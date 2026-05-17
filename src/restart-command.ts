import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import {
  postCodexReviewRequest as defaultPostCodexReviewRequest,
  postComment as defaultPostComment,
  postStopComment as defaultPostStopComment,
} from "./comment-poster.js";
import { updateStateComment as defaultUpdateStateComment } from "./state-manager.js";
import type { ReadStateResult } from "./state-manager.js";
import { createLockedStateUpdater } from "./state-comment-locker.js";
import type { ReviewState, StopReason } from "./types.js";

export type RestartMode = "soft" | "hard";
type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export type RestartParseResult =
  | { isRestart: false }
  | { isRestart: true; mode: RestartMode; invalidReason?: never }
  | { isRestart: true; invalidReason: "unsupported_option" };

function normalizeBody(body: string): string {
  return body.replace(/[\r\n]+$/, "");
}

export function isRestartCommandLike(body: string): boolean {
  const normalized = normalizeBody(body).toLowerCase();
  return normalized === "/restart-review" || normalized.startsWith("/restart-review ");
}

export function parseRestartCommand(body: string): RestartParseResult {
  const normalized = normalizeBody(body);
  const lower = normalized.toLowerCase();

  if (lower === "/restart-review") {
    return { isRestart: true, mode: "soft" };
  }
  if (!lower.startsWith("/restart-review ")) {
    return { isRestart: false };
  }

  const tail = normalized.slice("/restart-review ".length).trim();
  if (tail === "") {
    return { isRestart: true, mode: "soft" };
  }
  if (tail.toLowerCase() === "--hard") {
    return { isRestart: true, mode: "hard" };
  }
  return { isRestart: true, invalidReason: "unsupported_option" };
}

export type RestartApplyResult =
  | {
      ok: true;
      nextState: ReviewState;
      previousStopReason: StopReason | null;
    }
  | {
      ok: false;
      reason: "state_corrupted" | "unsupported_status";
    };

export function applyRestartToState(
  state: ReviewState,
  mode: RestartMode,
  reviewRequestCommentId: number | null,
): RestartApplyResult {
  if (state.status === "initialized" || (state.status === "fixing" && mode !== "hard")) {
    return { ok: false, reason: "unsupported_status" };
  }
  if (state.status === "stopped" && state.stopReason === "state_corrupted") {
    return { ok: false, reason: "state_corrupted" };
  }
  if (
    state.status !== "done" &&
    state.status !== "stopped" &&
    state.status !== "waiting_codex" &&
    state.status !== "fixing"
  ) {
    return { ok: false, reason: "unsupported_status" };
  }

  // TY-258: `stopReason` is intentionally *not* cleared here. Pre-fix reads
  // `state.stopReason === "max_turns_exceeded"` to force the escalated tier
  // on the next iteration; clearing it would defeat that signal. Post-fix
  // clears `stopReason` on the next clean-commit transition to
  // `waiting_codex`, so a single successful repair returns the state to
  // normal tiering (one-shot escalation).
  const nextState: ReviewState = {
    ...state,
    status: "waiting_codex",
    lastProcessedReviewId: null,
    lastCodexRequestCommentId: reviewRequestCommentId,
  };
  if (mode === "hard") {
    nextState.iterationCount = 0;
    nextState.findingsHashHistory = [];
    nextState.lastFindingsHash = null;
  }
  return { ok: true, nextState, previousStopReason: state.stopReason };
}

export interface RestartCommandContext {
  owner: string;
  repo: string;
  prNumber: number;
  triggerCommentId: number;
  triggerCommentBody: string;
  triggerUserLogin: string;
  restartRoles: string;
  githubToken: string;
  codexReviewRequestToken: string;
  stateResult: ReadStateResult;
}

export interface RestartCommandDeps {
  getPrAuthor: (
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ) => Promise<string>;
  getCollaboratorPermission: (
    owner: string,
    repo: string,
    user: string,
    token: string,
  ) => Promise<Permission>;
  updateStateComment: typeof defaultUpdateStateComment;
  postComment: (
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ) => Promise<number>;
  postStopComment: typeof defaultPostStopComment;
  addEyesReaction: (
    owner: string,
    repo: string,
    commentId: number,
    token: string,
  ) => Promise<void>;
  postCodexReviewRequest: (
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ) => Promise<number>;
  warning: (message: string) => void;
}

/**
 * GitHub username 仕様 (TY-265 #9):
 *   - 1 〜 39 文字
 *   - `[A-Za-z0-9_]` または single hyphen (`-`) のみ
 *   - 先頭・末尾は `-` 不可、`--` 連続も不可
 *   - Enterprise Managed Users (EMU) は `<idp_username>_<shortcode>` 形式で
 *     underscore (`_`) を含むため、underscore は許容する。
 *
 * `triggerUserLogin` は collaborators API の path に直接埋め込まれるため、
 * defense-in-depth として正規表現で validate する。bot login
 * (`*[bot]`) は restart 権限を付与しない方針なので明示的に弾く。
 */
export function isValidGitHubLogin(login: string): boolean {
  if (login.length < 1 || login.length > 39) return false;
  return /^[a-zA-Z0-9_](?:[a-zA-Z0-9_]|-(?=[a-zA-Z0-9_]))*$/.test(login);
}

export async function handleRestartCommand(
  context: RestartCommandContext,
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<{ handled: boolean }> {
  const command = parseRestartCommand(context.triggerCommentBody);
  if (!command.isRestart) {
    return { handled: false };
  }

  // TY-272 #E: gate every side effect — including the "unsupported option" /
  // "state corrupted" rejection comments and the state read implied by them —
  // on the permission check first. The previous order let an unauthenticated
  // commenter trigger a state read + a PR comment per `/restart-review`,
  // which combined with the workflow `if` ungated for /restart-review (also
  // closed in this ticket, #C) formed a small amplification surface.
  const hasPermission = await canRestart(context, deps);
  if (!hasPermission) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      `❌ Restart rejected: insufficient permission. @${context.triggerUserLogin} is not allowed to restart auto-review.`,
      context.githubToken,
    );
    return { handled: true };
  }

  if (command.invalidReason) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Restart rejected: unsupported option. Use `/restart-review` or `/restart-review --hard`.",
      context.githubToken,
    );
    return { handled: true };
  }

  if (!context.stateResult.found && context.stateResult.corrupted) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Restart cannot apply: state is corrupted. See docs/operations/stop-and-recovery.md.",
      context.githubToken,
    );
    return { handled: true };
  }
  if (!context.stateResult.found) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Restart cannot apply: auto-review state was not found.",
      context.githubToken,
    );
    return { handled: true };
  }

  const preflight = applyRestartToState(context.stateResult.state, command.mode, null);
  if (!preflight.ok) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      restartRejectionMessage(preflight.reason),
      context.githubToken,
    );
    return { handled: true };
  }

  // TY-265 #5: route every state write through the optimistic-lock helper so a
  // concurrent workflow run cannot silently clobber our restart, and a failure
  // between the two state writes leaves an explicit `state_conflict` stop
  // comment instead of `status=waiting_codex` with `lastCodexRequestCommentId=null`.
  const updateStateCommentLocked = createLockedStateUpdater({
    owner: context.owner,
    repo: context.repo,
    commentId: context.stateResult.commentId,
    token: context.githubToken,
    initialExpectedUpdatedAt: context.stateResult.commentUpdatedAt,
    label: "pre-fix",
    updateStateComment: deps.updateStateComment,
    warning: deps.warning,
    onConflict: async (detail) => {
      await deps.postStopComment(
        context.owner,
        context.repo,
        context.prNumber,
        "state_conflict",
        0,
        0,
        `${detail} Restart aborted because the hidden state comment was modified by another workflow run. Re-issue /restart-review once the active run finishes.`,
        context.githubToken,
      );
    },
  });

  const firstWriteOk = await updateStateCommentLocked(
    preflight.nextState,
    "[restart] failed to publish pre-codex state",
  );
  if (!firstWriteOk) {
    return { handled: true };
  }

  const reviewRequestCommentId = await deps.postCodexReviewRequest(
    context.owner,
    context.repo,
    context.prNumber,
    context.codexReviewRequestToken,
  );
  const restartResult = applyRestartToState(
    context.stateResult.state,
    command.mode,
    reviewRequestCommentId,
  );
  if (!restartResult.ok) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      restartRejectionMessage(restartResult.reason),
      context.githubToken,
    );
    return { handled: true };
  }

  const secondWriteOk = await updateStateCommentLocked(
    restartResult.nextState,
    "[restart] failed to record review-request comment id after posting @codex review",
  );
  if (!secondWriteOk) {
    return { handled: true };
  }

  await deps.postComment(
    context.owner,
    context.repo,
    context.prNumber,
    [
      `🟢 Auto-review restarted by @${context.triggerUserLogin}.`,
      "",
      `mode: ${command.mode}`,
      `from: ${restartResult.previousStopReason ?? "none"}`,
      `reviewRequestCommentId: ${reviewRequestCommentId}`,
    ].join("\n"),
    context.githubToken,
  );
  if (context.triggerCommentId !== 0) {
    try {
      await deps.addEyesReaction(
        context.owner,
        context.repo,
        context.triggerCommentId,
        context.githubToken,
      );
    } catch {
      // The audit comment is the durable acknowledgement. Reaction failures
      // can happen on duplicate reactions and should not roll back restart.
    }
  }
  return { handled: true };
}

async function canRestart(
  context: Pick<
    RestartCommandContext,
    "owner" | "repo" | "prNumber" | "triggerUserLogin" | "restartRoles" | "githubToken"
  >,
  deps: Pick<RestartCommandDeps, "getPrAuthor" | "getCollaboratorPermission" | "warning">,
): Promise<boolean> {
  if (!context.triggerUserLogin) {
    return false;
  }
  // TY-265 #9: the login is path-embedded into
  // `repos/<owner>/<repo>/collaborators/<user>/permission`. GitHub's username
  // spec excludes `/` and `..`, but defense-in-depth: reject anything that
  // doesn't match the spec (incl. bot suffixes `[bot]`) before issuing the API
  // call, and surface a warning so operators can spot abuse attempts.
  if (!isValidGitHubLogin(context.triggerUserLogin)) {
    deps.warning(
      `[restart] Rejecting restart from user with invalid GitHub login: "${context.triggerUserLogin}"`,
    );
    return false;
  }

  const roles = parseRoles(context.restartRoles);
  if (roles.has("author")) {
    const author = await deps.getPrAuthor(
      context.owner,
      context.repo,
      context.prNumber,
      context.githubToken,
    );
    if (author === context.triggerUserLogin) {
      return true;
    }
  }

  const permission = await deps.getCollaboratorPermission(
    context.owner,
    context.repo,
    context.triggerUserLogin,
    context.githubToken,
  );
  return roles.has(permission);
}

function parseRoles(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((role) => role.trim().toLowerCase())
      .filter(Boolean),
  );
}

function restartRejectionMessage(reason: Exclude<RestartApplyResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "state_corrupted":
      return "❌ Restart cannot apply: state is corrupted. See docs/operations/stop-and-recovery.md.";
    case "unsupported_status":
      return "❌ Restart cannot apply: current review status is not restartable.";
  }
}

async function getPrAuthor(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const stdout = await ghApi(
    ["api", `repos/${owner}/${repo}/pulls/${prNumber}`, "--jq", ".user.login"],
    token,
  );
  return stdout.trim();
}

const BUILTIN_PERMISSIONS = new Set<Permission>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
]);

function isBuiltinPermission(value: unknown): value is Permission {
  return typeof value === "string" && BUILTIN_PERMISSIONS.has(value as Permission);
}

/**
 * Selects the effective permission tier for restart authorization.
 *
 * GitHub returns both `role_name` (5-tier: admin/maintain/write/triage/read)
 * and `permission` (legacy 4-tier: admin/write/read/none). When a repo uses
 * custom roles, `role_name` can be an arbitrary string ("Reviewer", etc.)
 * while `permission` still reports the underlying base tier. We prefer
 * `role_name` for accurate maintain/triage detection but fall back to
 * `permission` whenever `role_name` is not one of the built-in tiers, so
 * custom-role users keep their base access for restart commands.
 */
export function pickPermission(
  roleName: string | null,
  permission: string | null,
): Permission {
  if (isBuiltinPermission(roleName)) {
    return roleName;
  }
  if (isBuiltinPermission(permission)) {
    return permission;
  }
  return "none";
}

async function getCollaboratorPermission(
  owner: string,
  repo: string,
  user: string,
  token: string,
): Promise<Permission> {
  try {
    const stdout = await ghApi(
      [
        "api",
        `repos/${owner}/${repo}/collaborators/${user}/permission`,
        "--jq",
        // Emit both fields as a JSON array so we can disambiguate custom
        // role_name (e.g., "Reviewer") from built-in tiers in TS.
        "[.role_name, .permission] | @json",
      ],
      token,
    );
    const parsed = JSON.parse(stdout.trim()) as [unknown, unknown];
    const roleName = typeof parsed[0] === "string" ? parsed[0] : null;
    const permission = typeof parsed[1] === "string" ? parsed[1] : null;
    return pickPermission(roleName, permission);
  } catch {
    return "none";
  }
}

async function addEyesReaction(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  await ghApi(
    [
      "api",
      `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      "-X",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      // TY-269: `--raw-field` (= `-F`) avoids gh CLI's `@<value>` file-read
      // interpretation. `eyes` is safe here but stay consistent with the
      // rest of the codebase.
      "--raw-field",
      "content=eyes",
    ],
    token,
  );
}

const defaultRestartCommandDeps: RestartCommandDeps = {
  getPrAuthor,
  getCollaboratorPermission,
  updateStateComment: defaultUpdateStateComment,
  postComment: defaultPostComment,
  postStopComment: defaultPostStopComment,
  addEyesReaction,
  postCodexReviewRequest: defaultPostCodexReviewRequest,
  warning: (message: string) => core.warning(message),
};
