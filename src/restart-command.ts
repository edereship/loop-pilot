import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";
import { postCodexReviewRequest as defaultPostCodexReviewRequest } from "./comment-poster.js";
import { updateStateComment as defaultUpdateStateComment } from "./state-manager.js";
import type { ReadStateResult } from "./state-manager.js";
import type { ReviewState, StopReason } from "./types.js";

const execFileAsync = promisify(execFile);

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

  const nextState: ReviewState = {
    ...state,
    status: "waiting_codex",
    stopReason: null,
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
  updateStateComment: (
    owner: string,
    repo: string,
    commentId: number,
    state: ReviewState,
    token: string,
  ) => Promise<unknown>;
  postComment: (
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ) => Promise<number>;
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
}

export async function handleRestartCommand(
  context: RestartCommandContext,
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<{ handled: boolean }> {
  const command = parseRestartCommand(context.triggerCommentBody);
  if (!command.isRestart) {
    return { handled: false };
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

  await deps.updateStateComment(
    context.owner,
    context.repo,
    context.stateResult.commentId,
    preflight.nextState,
    context.githubToken,
  );

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

  await deps.updateStateComment(
    context.owner,
    context.repo,
    context.stateResult.commentId,
    restartResult.nextState,
    context.githubToken,
  );
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
  deps: Pick<RestartCommandDeps, "getPrAuthor" | "getCollaboratorPermission">,
): Promise<boolean> {
  if (!context.triggerUserLogin) {
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
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${owner}/${repo}/pulls/${prNumber}`, "--jq", ".user.login"],
    { env: buildGhEnv(token) },
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
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/collaborators/${user}/permission`,
        "--jq",
        // Emit both fields as a JSON array so we can disambiguate custom
        // role_name (e.g., "Reviewer") from built-in tiers in TS.
        "[.role_name, .permission] | @json",
      ],
      { env: buildGhEnv(token) },
    );
    const parsed = JSON.parse(stdout.trim()) as [unknown, unknown];
    const roleName = typeof parsed[0] === "string" ? parsed[0] : null;
    const permission = typeof parsed[1] === "string" ? parsed[1] : null;
    return pickPermission(roleName, permission);
  } catch {
    return "none";
  }
}

async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<number> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      "-X",
      "POST",
      "-f",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    { env: buildGhEnv(token) },
  );
  return Number.parseInt(stdout.trim(), 10);
}

async function addEyesReaction(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      "-X",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-f",
      "content=eyes",
    ],
    { env: buildGhEnv(token) },
  );
}

const defaultRestartCommandDeps: RestartCommandDeps = {
  getPrAuthor,
  getCollaboratorPermission,
  updateStateComment: defaultUpdateStateComment,
  postComment,
  addEyesReaction,
  postCodexReviewRequest: defaultPostCodexReviewRequest,
};
