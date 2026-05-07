import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";
import { updateStateComment as defaultUpdateStateComment } from "./state-manager.js";
import type { ReadStateResult } from "./state-manager.js";
import type { ReviewState, StopReason } from "./types.js";

const execFileAsync = promisify(execFile);

export type ResetMode = "soft" | "hard";
type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const SOFT_RESET_REASONS = new Set<StopReason>([
  "claude_api_error",
  "test_failure",
  "manual_stop",
]);
const HARD_RESET_REASONS = new Set<StopReason>([
  ...SOFT_RESET_REASONS,
  "max_iterations",
  "loop_detected",
]);

export type ResetParseResult =
  | { isReset: false }
  | { isReset: true; mode: ResetMode; invalidReason?: never }
  | { isReset: true; invalidReason: "unsupported_option" };

// Workflow B's `if:` triggers reset-review handling on:
//   github.event.comment.body == '/reset-review'
//   || startsWith(github.event.comment.body, '/reset-review ')
// GitHub Actions `==` and `startsWith` are case-insensitive but the separator
// is a single literal space — leading whitespace, tabs, and other separators
// would not start the workflow. The runtime parser mirrors this contract so
// commands accepted here also reach Workflow B (no silent drift). Trailing
// CR/LF is tolerated because GitHub sometimes appends them to comment bodies.
function normalizeBody(body: string): string {
  return body.replace(/[\r\n]+$/, "");
}

export function isResetCommandLike(body: string): boolean {
  const normalized = normalizeBody(body).toLowerCase();
  return normalized === "/reset-review" || normalized.startsWith("/reset-review ");
}

export function parseResetCommand(body: string): ResetParseResult {
  const normalized = normalizeBody(body);
  const lower = normalized.toLowerCase();

  if (lower === "/reset-review") {
    return { isReset: true, mode: "soft" };
  }
  if (!lower.startsWith("/reset-review ")) {
    return { isReset: false };
  }

  const tail = normalized.slice("/reset-review ".length).trim();
  if (tail === "") {
    return { isReset: true, mode: "soft" };
  }
  if (tail.toLowerCase() === "--hard") {
    return { isReset: true, mode: "hard" };
  }
  return { isReset: true, invalidReason: "unsupported_option" };
}

export type ResetApplyResult =
  | {
      ok: true;
      nextState: ReviewState;
      previousStopReason: StopReason | null;
      noChange?: boolean;
    }
  | {
      ok: false;
      reason:
        | "already_done"
        | "state_corrupted"
        | "hard_required"
        | "unsupported_status"
        | "unsupported_stop_reason";
    };

export function applyResetToState(
  state: ReviewState,
  mode: ResetMode,
): ResetApplyResult {
  if (state.status === "waiting_codex") {
    return {
      ok: true,
      nextState: state,
      noChange: true,
      previousStopReason: state.stopReason,
    };
  }
  if (state.status === "done") {
    return { ok: false, reason: "already_done" };
  }
  if (state.status !== "stopped") {
    return { ok: false, reason: "unsupported_status" };
  }
  if (state.stopReason === "state_corrupted") {
    return { ok: false, reason: "state_corrupted" };
  }

  const stopReason = state.stopReason;
  if (mode === "soft") {
    if (stopReason === "max_iterations" || stopReason === "loop_detected") {
      return { ok: false, reason: "hard_required" };
    }
    if (stopReason !== null && !SOFT_RESET_REASONS.has(stopReason)) {
      return { ok: false, reason: "unsupported_stop_reason" };
    }
  }
  if (mode === "hard" && stopReason !== null && !HARD_RESET_REASONS.has(stopReason)) {
    return { ok: false, reason: "unsupported_stop_reason" };
  }

  const nextState: ReviewState = {
    ...state,
    status: "waiting_codex",
    stopReason: null,
  };
  if (mode === "hard") {
    nextState.iterationCount = 0;
    nextState.findingsHashHistory = [];
  }

  return { ok: true, nextState, previousStopReason: stopReason };
}

export interface ResetCommandContext {
  owner: string;
  repo: string;
  prNumber: number;
  triggerCommentId: number;
  triggerCommentBody: string;
  triggerUserLogin: string;
  resetRoles: string;
  githubToken: string;
  stateResult: ReadStateResult;
}

export interface ResetCommandDeps {
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
  ) => Promise<void>;
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
}

export async function handleResetCommand(
  context: ResetCommandContext,
  deps: ResetCommandDeps = defaultResetCommandDeps,
): Promise<{ handled: boolean }> {
  const command = parseResetCommand(context.triggerCommentBody);
  if (!command.isReset) {
    return { handled: false };
  }

  if (command.invalidReason) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Reset rejected: unsupported option. Use `/reset-review` or `/reset-review --hard`.",
      context.githubToken,
    );
    return { handled: true };
  }

  if (!context.stateResult.found && context.stateResult.corrupted) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Reset cannot apply: state is corrupted. See docs/operations/stop-and-recovery.md.",
      context.githubToken,
    );
    return { handled: true };
  }
  if (!context.stateResult.found) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "❌ Reset cannot apply: auto-review state was not found.",
      context.githubToken,
    );
    return { handled: true };
  }

  const hasPermission = await canReset(context, deps);
  if (!hasPermission) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      `❌ Reset rejected: insufficient permission. @${context.triggerUserLogin} is not allowed to reset auto-review.`,
      context.githubToken,
    );
    return { handled: true };
  }

  const resetResult = applyResetToState(context.stateResult.state, command.mode);
  if (!resetResult.ok) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      rejectionMessage(resetResult.reason),
      context.githubToken,
    );
    return { handled: true };
  }

  if (!resetResult.noChange) {
    await deps.updateStateComment(
      context.owner,
      context.repo,
      context.stateResult.commentId,
      resetResult.nextState,
      context.githubToken,
    );
  }

  const body = resetResult.noChange
    ? "🟢 Already in waiting_codex — no change."
    : [
        `🟢 Auto-review reset accepted by @${context.triggerUserLogin}.`,
        "",
        `mode: ${command.mode}`,
        `from: ${resetResult.previousStopReason ?? "none"}`,
      ].join("\n");

  await deps.postComment(
    context.owner,
    context.repo,
    context.prNumber,
    body,
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
      // can happen on duplicate reactions and should not roll back the reset.
    }
  }

  return { handled: true };
}

async function canReset(
  context: ResetCommandContext,
  deps: ResetCommandDeps,
): Promise<boolean> {
  if (!context.triggerUserLogin) {
    return false;
  }

  const roles = parseRoles(context.resetRoles);
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

function rejectionMessage(reason: Exclude<ResetApplyResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "already_done":
      return "❌ Reset cannot apply: review already done.";
    case "state_corrupted":
      return "❌ Reset cannot apply: state is corrupted. See docs/operations/stop-and-recovery.md.";
    case "hard_required":
      return "❌ Reset cannot apply: use `/reset-review --hard` for this stop reason.";
    case "unsupported_status":
      return "❌ Reset cannot apply: current review status is not resettable.";
    case "unsupported_stop_reason":
      return "❌ Reset cannot apply: current stop reason is not resettable.";
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
        ".permission",
      ],
      { env: buildGhEnv(token) },
    );
    const permission = stdout.trim();
    if (
      permission === "admin" ||
      permission === "maintain" ||
      permission === "write" ||
      permission === "triage" ||
      permission === "read"
    ) {
      return permission;
    }
  } catch {
    return "none";
  }
  return "none";
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

const defaultResetCommandDeps: ResetCommandDeps = {
  getPrAuthor,
  getCollaboratorPermission,
  updateStateComment: defaultUpdateStateComment,
  postComment,
  addEyesReaction,
};
