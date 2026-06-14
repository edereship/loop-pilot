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
import { ensureCodexAck as defaultEnsureCodexAck } from "./codex-ack.js";
import type { CodexAckParams, CodexAckResult } from "./codex-ack.js";
import { computeFindingsHash } from "./findings-hash.js";
import { selectEmbeddedFindings } from "./claude-code-repair-request.js";
import type { ModelTier } from "./model-selector.js";
import type { Finding, ReviewState, StopReason } from "./types.js";

export type RestartMode = "soft" | "hard";
type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export type RestartParseResult =
  | { isRestart: false }
  | { isRestart: true; mode: RestartMode; invalidReason?: never }
  | { isRestart: true; invalidReason: "unsupported_option" };

/**
 * Reduce a comment body to its first non-empty line for restart-command
 * matching (TY-275 #4). GitHub comments can carry a trailing rationale
 * (`/restart-review --hard\n\n（理由: …）`); without this, the rationale
 * lands inside the slice that follows `/restart-review `, no longer equals
 * `--hard` (the embedded newline survives `trim()`), and the command is
 * rejected with `unsupported_option` — forcing operators to keep the
 * command on a literal single line. Reading the first line keeps the
 * rationale freedom while still strictly validating the command itself.
 */
function normalizeBody(body: string): string {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/[\r\n]+$/, "");
}

export function isRestartCommandLike(body: string): boolean {
  const normalized = normalizeBody(body).toLowerCase();
  return normalized === "/restart-review" || normalized.startsWith("/restart-review ");
}

export function parseRestartCommand(body: string): RestartParseResult {
  const normalized = normalizeBody(body);
  const lower = normalized.toLowerCase();

  // Codex review on PR #95 (r3257717909): the continuation-flag check below
  // must run AFTER confirming the first line is actually a restart command.
  // Otherwise a non-restart comment like `notes\n--todo` would be
  // misclassified as `{ isRestart: true, invalidReason: "unsupported_option" }`
  // instead of `{ isRestart: false }`, leaking false-positive restart
  // attempts into callers that don't pre-filter with isRestartCommandLike.
  if (lower !== "/restart-review" && !lower.startsWith("/restart-review ")) {
    return { isRestart: false };
  }

  // Codex review on PR #95 (r3257480253): TY-275 #4 extracts only the first
  // line so operators can append a rationale. But `/restart-review\n--hard`
  // (flag on a *separate* line) would now be reduced to `/restart-review`
  // and silently demoted from the operator's intended hard restart to soft,
  // which is more dangerous than the pre-#4 rejection. If any continuation
  // line looks like a flag (`--<word>`), reject the whole command rather
  // than guess the mode.
  const continuationLines = body.split(/\r?\n/).slice(1);
  const continuationHasFlag = continuationLines.some((line) =>
    /^\s*--\w/.test(line),
  );
  if (continuationHasFlag) {
    return { isRestart: true, invalidReason: "unsupported_option" };
  }

  if (lower === "/restart-review") {
    return { isRestart: true, mode: "soft" };
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
      reason:
        | "state_corrupted"
        | "unsupported_status"
        | "secret_leak_requires_hard_restart"
        | "max_iterations_requires_hard_restart";
    };

export function applyRestartToState(
  state: ReviewState,
  mode: RestartMode,
  reviewRequestCommentId: number | null,
): RestartApplyResult {
  if (state.status === "initialized" || (state.status === "fixing" && mode !== "hard")) {
    return { ok: false, reason: "unsupported_status" };
  }
  // TY-282 #1C: previously `state_corrupted` was an absolute reject so the
  // only recovery was hand-editing the hidden state comment. In practice that
  // path was hit by automatic recoveries (`demoteFixingOnCrash`, stale
  // `fixing` detector) writing a parseable state with stopReason
  // `state_corrupted`, not by genuine JSON corruption. Those crash paths are
  // now downgraded to `workflow_crashed` (which restart accepts without
  // ceremony), but legacy / future writes of `state_corrupted` still need an
  // escape hatch — `--hard` clears iteration count + findings history so the
  // next run starts from scratch, making it safe to apply even when the
  // recorded state machine looked off.
  //
  // Genuine JSON corruption (readState `corrupted=true`) is rejected earlier
  // in `handleRestartCommand` and never reaches this function, so this
  // branch always operates on a parseable state.
  if (
    state.status === "stopped" &&
    state.stopReason === "state_corrupted" &&
    mode !== "hard"
  ) {
    return { ok: false, reason: "state_corrupted" };
  }
  // TY-274 #1: soft restart from `secret_leak_suspected` is rejected so the
  // same Codex finding hash cannot immediately re-trigger the leak. `--hard`
  // clears iteration history + findings hash, which is an explicit operator
  // acknowledgement that they have reviewed the leak and the next run starts
  // from scratch.
  if (
    state.status === "stopped" &&
    state.stopReason === "secret_leak_suspected" &&
    mode !== "hard"
  ) {
    return { ok: false, reason: "secret_leak_requires_hard_restart" };
  }
  // A soft restart preserves `iterationCount`, which on a `max_iterations`
  // stop is already at the cap. The next pre-fix run re-trips its
  // `iterationCount >= maxReviewIterations` guard (`main-pre-fix.ts`) and
  // immediately re-stops with the same reason — burning a Codex review round
  // and showing operators a misleading "🟢 restarted" followed by an instant
  // re-stop. Only `--hard` (which resets `iterationCount` to 0) can make
  // progress, so reject soft exactly like `state_corrupted` /
  // `secret_leak_suspected`. The `STOP_REASON_LABELS` text and the recovery
  // docs already steer operators to `--hard` for this stop reason.
  if (
    state.status === "stopped" &&
    state.stopReason === "max_iterations" &&
    mode !== "hard"
  ) {
    return { ok: false, reason: "max_iterations_requires_hard_restart" };
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
    // TY-286 #C: `applyRestartToState` allows hard-restart from `fixing`. The
    // outgoing status is no longer `fixing`, so the invariant
    // "`fixingStartedAt === null` whenever `status !== 'fixing'`" requires
    // clearing the timestamp here — every other transition out of `fixing`
    // (post-fix Phase 4, `failureExit`, stale recovery) already does this.
    fixingStartedAt: null,
  };
  if (mode === "hard") {
    nextState.iterationCount = 0;
    nextState.findingsHashHistory = [];
    nextState.lastFindingsHash = null;
    // `--hard` is an explicit "start from scratch", so wipe the
    // iteration-derived CHECK_COMMAND failure context too. Without this, a
    // `fixing` state hard-restarted after a prior `test_failure` (whose tail is
    // preserved across a soft `/restart-review` and then carried into the
    // `fixing` claim) would inject a now-stale "Previous CHECK_COMMAND Failure"
    // section into the next repair prompt AND trip `selectModel`'s
    // `previous_check_failure` escalation — burning an escalated-tier iteration
    // on context the `--hard` was meant to discard. `stopReason` stays
    // preserved on purpose (TY-258 one-shot escalation); soft restart still
    // keeps `previousCheckFailure` so the next attempt sees the last failure.
    nextState.previousCheckFailure = null;
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
  // TY-334: Codex bot login + ACK-poll tuning so the re-posted @codex review is
  // monitored for an acknowledgement, the same as init / post-fix. Without this
  // the documented recovery path (/restart-review) re-wedges at waiting_codex
  // whenever Codex drops the request again.
  codexBotLogin: string;
  codexAckTimeoutSeconds: number;
  codexAckPollIntervalSeconds: number;
  codexAckMaxReposts: number;
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
  addRestartReaction: (
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
  // TY-334: injected so tests can drive ACK / no-ACK without real polling.
  ensureCodexAck: (params: CodexAckParams) => Promise<CodexAckResult>;
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

/**
 * Validated restart command result. `mode` + `preflight` are the inputs for
 * either Case A (`handleRestartWithRepair`) or Case B
 * (`executeRestartWithCodexReview`).
 */
export interface RestartValidation {
  mode: RestartMode;
  preflight: { nextState: ReviewState; previousStopReason: StopReason | null };
}

export type ValidateRestartCommandResult =
  | { valid: true; validation: RestartValidation }
  | { valid: false; handled: boolean };

/**
 * Extracted validation logic from `handleRestartCommand` (ES-413 refactoring).
 * Parses the command, checks permission, validates state, and runs preflight.
 * All rejection comments are posted before returning `valid: false`.
 *
 * - `{ valid: false, handled: false }` → not a restart command at all
 * - `{ valid: false, handled: true }` → restart command rejected, comment posted
 * - `{ valid: true, ... }` → proceed with Case A or B
 */
export async function validateRestartCommand(
  context: RestartCommandContext,
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<ValidateRestartCommandResult> {
  const command = parseRestartCommand(context.triggerCommentBody);
  if (!command.isRestart) {
    return { valid: false, handled: false };
  }

  const hasPermission = await canRestart(context, deps);
  if (!hasPermission) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      `⚠️ Restart rejected: insufficient permission. @${context.triggerUserLogin} is not allowed to restart LoopPilot.`,
      context.githubToken,
    );
    return { valid: false, handled: true };
  }

  if (command.invalidReason) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "⚠️ Restart rejected: unsupported option. Use `/restart-review` or `/restart-review --hard`.",
      context.githubToken,
    );
    return { valid: false, handled: true };
  }

  if (!context.stateResult.found && context.stateResult.corrupted) {
    const rejection = [
      "⚠️ Restart cannot apply: hidden `looppilot-state` comment is unparseable JSON.",
      "",
      "**`/restart-review --hard` will return the same rejection** — state read fails before the `--hard` clear logic runs, so this path requires manual surgery.",
      "",
      "Recovery (operator):",
      "1. Find the hidden comment whose body contains `<!-- looppilot-state ... -->` on this PR.",
      `2. \`gh api -X DELETE /repos/${context.owner}/${context.repo}/issues/comments/<id>\` to delete it.`,
      "3. Remove and re-add the gate label (or, in full-auto mode, close + reopen the PR) so Workflow A re-runs and recreates the state.",
      "4. Leave an audit comment on the PR with the operator and the reason, for the run history.",
      "",
      "See [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) → `state_corrupted` の復旧 → 1 番目の経路 (JSON unparseable).",
    ].join("\n");
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      rejection,
      context.githubToken,
    );
    return { valid: false, handled: true };
  }
  if (!context.stateResult.found) {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      "⚠️ Restart cannot apply: LoopPilot state was not found.",
      context.githubToken,
    );
    return { valid: false, handled: true };
  }

  const preflight = applyRestartToState(context.stateResult.state, command.mode, null);
  if (!preflight.ok) {
    const rejection =
      preflight.reason === "unsupported_status" &&
      context.stateResult.state.status === "fixing" &&
      command.mode !== "hard"
        ? [
            "⚠️ Restart cannot apply: a fix is currently in progress (`fixing`).",
            "",
            "If a Workflow B run is still active for this PR, wait for it to finish — it returns the loop to `waiting_codex` on its own.",
            "If the previous run crashed or was cancelled (e.g. a job timeout) and left the state stuck at `fixing`, a soft `/restart-review` cannot recover it. Confirm no auto-fix run is active, then use `/restart-review --hard` to clear iteration history and resume.",
            "",
            "See docs/operations/stop-and-recovery.md (`fixing` のまま停止している場合).",
          ].join("\n")
        : restartRejectionMessage(preflight.reason);
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      rejection,
      context.githubToken,
    );
    return { valid: false, handled: true };
  }

  return {
    valid: true,
    validation: {
      mode: command.mode,
      preflight: {
        nextState: preflight.nextState,
        previousStopReason: preflight.previousStopReason,
      },
    },
  };
}

/**
 * Case B: no unresolved findings — post `@codex review`, ACK-poll, and
 * write the `waiting_codex` state. This is the existing restart flow,
 * extracted from `handleRestartCommand` for ES-413.
 */
export async function executeRestartWithCodexReview(
  context: RestartCommandContext,
  validation: RestartValidation,
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<void> {
  if (!context.stateResult.found) {
    throw new Error("[restart] executeRestartWithCodexReview called with unfound state");
  }
  const updateStateCommentLocked = createLockedStateUpdater({
    owner: context.owner,
    repo: context.repo,
    commentId: context.stateResult.commentId,
    token: context.githubToken,
    initialExpectedUpdatedAt: context.stateResult.commentUpdatedAt,
    label: "restart",
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
    validation.preflight.nextState,
    "[restart] failed to publish pre-codex state",
  );
  if (!firstWriteOk) {
    return;
  }

  let reviewRequestCommentId: number;
  const codexRequestedAt = new Date().toISOString();
  try {
    reviewRequestCommentId = await deps.postCodexReviewRequest(
      context.owner,
      context.repo,
      context.prNumber,
      context.codexReviewRequestToken,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warning(
      `[restart] Failed to post @codex review after first state write: ${message}. ` +
        "Downgrading to stopped/codex_request_failed so operators see the actionable stop reason.",
    );
    const stoppedState: ReviewState = {
      ...validation.preflight.nextState,
      status: "stopped",
      stopReason: "codex_request_failed",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "[restart] Could not record codex_request_failed stop after @codex review post failure.",
      ))
    ) {
      return;
    }
    await deps.postStopComment(
      context.owner,
      context.repo,
      context.prNumber,
      "codex_request_failed",
      context.triggerCommentId,
      0,
      `Failed to post @codex review after /restart-review: ${message}`,
      context.githubToken,
    );
    return;
  }
  const restartState: ReviewState = {
    ...validation.preflight.nextState,
    lastCodexRequestCommentId: reviewRequestCommentId,
  };

  const secondWriteOk = await updateStateCommentLocked(
    restartState,
    "[restart] failed to record review-request comment id after posting @codex review",
    {
      onConflict: async (detail) => {
        deps.warning(
          `[restart] ${detail} LoopPilot state remains waiting_codex; ` +
            "the next Codex review trigger will reconcile.",
        );
      },
    },
  );
  if (!secondWriteOk) {
    return;
  }

  const ack = await deps.ensureCodexAck({
    owner: context.owner,
    repo: context.repo,
    pr: context.prNumber,
    commentId: reviewRequestCommentId,
    requestedAt: codexRequestedAt,
    codexBotLogin: context.codexBotLogin,
    readToken: context.githubToken,
    token: context.codexReviewRequestToken,
    timeoutSeconds: context.codexAckTimeoutSeconds,
    pollIntervalSeconds: context.codexAckPollIntervalSeconds,
    maxReposts: context.codexAckMaxReposts,
  });
  if (!ack.acked) {
    const stoppedState: ReviewState = {
      ...restartState,
      lastCodexRequestCommentId: ack.lastCommentId,
      status: "stopped",
      stopReason: "codex_request_failed",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "[restart] Could not record codex_request_failed stop after no Codex ACK.",
        {
          onConflict: async (detail) => {
            deps.warning(
              `[restart] ${detail} State was advanced by a concurrent run; ACK-demotion write skipped.`,
            );
          },
        },
      ))
    ) {
      return;
    }
    try {
      await deps.postStopComment(
        context.owner,
        context.repo,
        context.prNumber,
        "codex_request_failed",
        context.triggerCommentId,
        0,
        `Codex did not acknowledge the @codex review request after ${context.codexAckMaxReposts} repost(s) (≈${context.codexAckTimeoutSeconds}s per attempt). Re-run /restart-review once Codex is reachable to resume.`,
        context.githubToken,
      );
    } catch (notifyError) {
      const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
      deps.warning(
        `[restart] Demoted to stopped/codex_request_failed after no Codex ACK but failed to post the stop notification: ${msg}.`,
      );
    }
    return;
  }
  if (ack.reposts > 0 && ack.lastCommentId !== reviewRequestCommentId) {
    try {
      await updateStateCommentLocked(
        { ...restartState, lastCodexRequestCommentId: ack.lastCommentId },
        "[restart] Could not persist the reposted Codex review request comment id.",
        {
          onConflict: async (detail) => {
            deps.warning(
              `[restart] ${detail} Auto-review state remains waiting_codex; ` +
                "the next Codex review trigger will reconcile.",
            );
          },
        },
      );
    } catch (repostWriteError) {
      const msg =
        repostWriteError instanceof Error
          ? repostWriteError.message
          : String(repostWriteError);
      deps.warning(
        `[restart] Failed to persist the reposted Codex review request id ${ack.lastCommentId}: ${msg}. ` +
          "Auto-review state remains waiting_codex; the next Codex review trigger will reconcile.",
      );
    }
  }

  await deps.postComment(
    context.owner,
    context.repo,
    context.prNumber,
    [
      `🟢 LoopPilot restarted by @${context.triggerUserLogin}.`,
      "",
      `mode: ${validation.mode}`,
      `from: ${validation.preflight.previousStopReason ?? "none"}`,
      `reviewRequestCommentId: ${ack.lastCommentId}`,
    ].join("\n"),
    context.githubToken,
  );
  if (context.triggerCommentId !== 0) {
    try {
      await deps.addRestartReaction(
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
}

/**
 * Case A (ES-413): unresolved Codex findings exist — transition to `fixing`
 * so the composite action repairs them before requesting a new review.
 * Returns the repair context for main-pre-fix to build the prompt, or `null`
 * when the state write conflicts (conflict comment already posted).
 */
export interface RestartRepairContext {
  fixingState: ReviewState;
}

export async function handleRestartWithRepair(
  context: RestartCommandContext,
  validation: RestartValidation,
  unresolvedFindings: Finding[],
  modelTier: ModelTier,
  now: () => Date = () => new Date(),
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<RestartRepairContext | null> {
  if (!context.stateResult.found) {
    throw new Error("[restart] handleRestartWithRepair called with unfound state");
  }
  const base = validation.preflight.nextState;
  const currentHash = computeFindingsHash(unresolvedFindings);
  const newIteration = base.iterationCount + 1;
  const fixingStartedAt = now().toISOString();
  // ES-413 (Codex P2): second-truncate the review baseline. GitHub
  // `created_at` is second-precision (`...00Z`), which sorts lexicographically
  // *after* a millisecond stamp (`...00.123Z`) because "Z" > ".". Storing the
  // raw millisecond `toISOString()` would make a Codex comment created in the
  // same second as this restart compare as "newer" than the baseline, so the
  // next pre-fix pass would re-parse the already-repaired comment as a fresh
  // finding. The normal pre-fix path truncates the same field for this reason
  // (see `main-pre-fix.ts`). `fixingStartedAt` keeps millisecond precision —
  // it is only used for duration-based stale detection, never lexicographic
  // comparison against `created_at`.
  const repairReviewBaseline = fixingStartedAt.replace(/\.\d{3}Z$/, "Z");

  const fixingState: ReviewState = {
    ...base,
    status: "fixing",
    fixingStartedAt,
    // ES-413 (Codex P2): advance the Codex review baseline to the restart
    // repair time. The unresolved findings claimed here are old Codex inline
    // comments; without bumping `lastCodexReviewReceivedAt`, the next pre-fix
    // pass — which fetches REST review comments by timestamp only — would
    // re-parse these already-repaired comments as fresh findings (the soft
    // restart preserves whatever stale/null baseline `base` carried). Every
    // comment in this set predates the restart, so this baseline is safely
    // after all of them and only genuinely new post-repair reviews are
    // reconsidered.
    lastCodexReviewReceivedAt: repairReviewBaseline,
    iterationCount: newIteration,
    lastFindingsHash: currentHash,
    findingsHashHistory: [
      ...base.findingsHashHistory,
      { iteration: newIteration, hash: currentHash, modelTier },
    ],
    currentIterationFindingCommentIds: selectEmbeddedFindings(
      unresolvedFindings,
    ).map((f) => f.commentId),
  };

  const updateStateCommentLocked = createLockedStateUpdater({
    owner: context.owner,
    repo: context.repo,
    commentId: context.stateResult.commentId,
    token: context.githubToken,
    initialExpectedUpdatedAt: context.stateResult.commentUpdatedAt,
    label: "restart",
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

  const writeOk = await updateStateCommentLocked(
    fixingState,
    "[restart] failed to publish fixing state for repair",
  );
  if (!writeOk) {
    return null;
  }

  // ES-413 (Codex P2): best-effort audit comment. The hidden `fixing` state
  // (written above) is the durable acknowledgement. If this public notification
  // fails — e.g. a transient API error or secondary-rate-limit — letting it
  // throw here would abort Case A *after* the state has already moved to
  // `fixing` but *before* pre-fix emits `should_run=true`; the top-level crash
  // handler would then demote the state instead of letting Claude repair the
  // unresolved findings. Swallow the failure like the reaction/status updates
  // and continue so output emission proceeds.
  try {
    await deps.postComment(
      context.owner,
      context.repo,
      context.prNumber,
      [
        `🔧 Found ${unresolvedFindings.length} unresolved finding(s) — fixing before requesting new review.`,
        "",
        `mode: ${validation.mode}`,
        `iteration: ${newIteration}`,
      ].join("\n"),
      context.githubToken,
    );
  } catch (error) {
    deps.warning(
      `[restart] Failed to post Case A repair audit comment (continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (context.triggerCommentId !== 0) {
    try {
      await deps.addRestartReaction(
        context.owner,
        context.repo,
        context.triggerCommentId,
        context.githubToken,
      );
    } catch {
      // Best-effort — the audit comment is the durable acknowledgement.
    }
  }

  return { fixingState };
}

/**
 * Backward-compatible wrapper: validates and then executes the existing
 * Case B (codex review) flow. `main-pre-fix.ts` now calls
 * `validateRestartCommand` + `executeRestartWithCodexReview` /
 * `handleRestartWithRepair` directly, but this wrapper remains for callers
 * that do not need the Case A/B split.
 */
export async function handleRestartCommand(
  context: RestartCommandContext,
  deps: RestartCommandDeps = defaultRestartCommandDeps,
): Promise<{ handled: boolean }> {
  const result = await validateRestartCommand(context, deps);
  if (!result.valid) return { handled: result.handled };
  await executeRestartWithCodexReview(context, result.validation, deps);
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

  const roles = parseRoles(context.restartRoles, deps.warning);
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

/**
 * Known role tokens accepted by `LOOPPILOT_RESTART_ROLES`.
 *
 * `"author"` is a synthetic alias resolved against the PR author (not a
 * GitHub permission); the rest mirror `BUILTIN_PERMISSIONS`. Unknown tokens
 * are silently ignored without this validation, so a typo like
 * `LOOPPILOT_RESTART_ROLES="admins"` (trailing s) would reject every
 * restart command without surfacing the misconfiguration anywhere — TY-275 #2.
 */
const KNOWN_RESTART_ROLES: ReadonlySet<string> = new Set([
  "author",
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
]);

function parseRoles(raw: string, warn: (msg: string) => void): Set<string> {
  const requested = raw
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((r) => !KNOWN_RESTART_ROLES.has(r));
  if (unknown.length > 0) {
    warn(
      `[restart] Unknown role(s) ignored in LOOPPILOT_RESTART_ROLES: ${unknown.join(", ")}. Valid roles: ${[...KNOWN_RESTART_ROLES].join(", ")}.`,
    );
  }
  return new Set(requested.filter((r) => KNOWN_RESTART_ROLES.has(r)));
}

function restartRejectionMessage(reason: Exclude<RestartApplyResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "state_corrupted":
      return (
        "⚠️ Restart cannot apply: state is corrupted. " +
        "Soft `/restart-review` is rejected from a corrupted-state stop because the hidden state may not reflect reality. " +
        "Use `/restart-review --hard` to clear iteration history and resume — `--hard` resets iterationCount + findingsHashHistory so the next run starts from scratch (TY-282 #1C). " +
        "See docs/operations/stop-and-recovery.md."
      );
    case "unsupported_status":
      return "⚠️ Restart cannot apply: current review status is not restartable.";
    case "secret_leak_requires_hard_restart":
      return (
        "⚠️ Restart cannot apply: this PR stopped with `secret_leak_suspected`. " +
        "Soft `/restart-review` would let the same Codex finding hash re-trigger the leak. " +
        "Review the affected files manually first, then use `/restart-review --hard` to clear iteration history and resume. " +
        "See docs/operations/security.md (secret-scanner ポリシー) and docs/operations/stop-and-recovery.md."
      );
    case "max_iterations_requires_hard_restart":
      return (
        "⚠️ Restart cannot apply: this PR stopped at `max_iterations`. " +
        "Soft `/restart-review` keeps `iterationCount` at the cap, so the next run would immediately re-stop with the same reason. " +
        "Use `/restart-review --hard` to reset the iteration count (and findings history) and resume. " +
        "See docs/operations/stop-and-recovery.md."
      );
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

async function addRestartReaction(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  await ghApi(
    [
      "api",
      `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      // TY-276 #5: prefer `--method` over `-X` for consistency with the rest
      // of the codebase (state-manager.ts already uses --method).
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      // TY-269: `--raw-field` (= `-F`) avoids gh CLI's `@<value>` file-read
      // interpretation. `rocket` is safe here but stay consistent with the
      // rest of the codebase.
      //
      // 🚀 (rocket) was chosen over 👀 (eyes) because eyes collides with the
      // reaction Codex posts when it acknowledges a review request — having
      // both bots add the same reaction made it hard to see at a glance
      // which side had picked up the work. rocket also reads better as
      // "Workflow B has been launched" than the more passive "I see your
      // command".
      "--raw-field",
      "content=rocket",
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
  addRestartReaction,
  postCodexReviewRequest: defaultPostCodexReviewRequest,
  ensureCodexAck: (params) => defaultEnsureCodexAck(params),
  warning: (message: string) => core.warning(message),
};
