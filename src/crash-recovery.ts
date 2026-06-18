import * as core from "@actions/core";
import { loadInitConfig as defaultLoadInitConfig } from "./config.js";
import { postStopComment as defaultPostStopComment } from "./comment-poster.js";
import {
  readState as defaultReadState,
  updateStateComment as defaultUpdateStateComment,
} from "./state-manager.js";
import type { ReviewState } from "./types.js";

export type CrashRecoveryLabel = "pre-fix" | "post-fix";

export interface CrashRecoveryDeps {
  loadInitConfig: typeof defaultLoadInitConfig;
  readState: typeof defaultReadState;
  updateStateComment: typeof defaultUpdateStateComment;
  /**
   * Best-effort top-level stop comment posted after the state demotion so the
   * operator gets a ⚠️ notification on the PR even when the workflow died
   * before `failureExit` could run. Failures are caught and logged.
   */
  postStopComment: typeof defaultPostStopComment;
}

const defaultDeps: CrashRecoveryDeps = {
  loadInitConfig: defaultLoadInitConfig,
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
  postStopComment: defaultPostStopComment,
};

/**
 * TY-302 #1: pre-fix Phase 3 claims `fixing` by writing
 * `iterationCount: N+1` and appending the current findings hash to
 * `findingsHashHistory` before claude-code-action runs. When the loop
 * exits the `fixing` phase without finalizing a repair commit
 * (workflow crash, stale-fixing recovery, post-fix failureExit), that
 * bookkeeping must be rolled back so a subsequent soft `/restart-review`
 * does not see a phantom `loop_detected` (next pre-fix would match the
 * orphan history entry on the same hash).
 *
 * The rollback target is identified by `findingsHashHistory.at(-1).iteration
 * === state.iterationCount` — pre-fix's Phase 3 write keeps those two in sync,
 * so on crash recovery paths the heuristic is always true. If the invariant
 * is broken (legacy / hand-edited state), the helper is a no-op rather than
 * destroying state we cannot reason about.
 *
 * Returns only the rollback-affected fields; callers merge them into the
 * full `ReviewState` they are writing.
 */
export function rollbackFixingClaim(state: ReviewState): Pick<
  ReviewState,
  "iterationCount" | "findingsHashHistory" | "lastFindingsHash"
> {
  const lastEntry = state.findingsHashHistory.at(-1);
  const shouldRollback =
    lastEntry !== undefined && lastEntry.iteration === state.iterationCount;
  if (!shouldRollback) {
    return {
      iterationCount: state.iterationCount,
      findingsHashHistory: state.findingsHashHistory,
      lastFindingsHash: state.lastFindingsHash,
    };
  }
  const rolledBackHistory = state.findingsHashHistory.slice(0, -1);
  return {
    iterationCount: Math.max(0, state.iterationCount - 1),
    findingsHashHistory: rolledBackHistory,
    lastFindingsHash: rolledBackHistory.at(-1)?.hash ?? null,
  };
}

/**
 * Recover from a crash in pre-fix / post-fix: if the hidden state was left at
 * `status === "fixing"`, demote it back to `stopped + workflow_crashed` so the
 * next trigger can proceed without manual intervention, and best-effort post
 * a top-level ⚠️ notification so the operator notices the crash.
 *
 * TY-282 #2A: previously this path wrote `state_corrupted`, which
 * `applyRestartToState` rejects outright. That combined with the silent
 * absence of a stop comment (the workflow died before `failureExit` could
 * run) to produce the "silent failure → unrecoverable PR" UX observed across
 * PR #93 / #94 / #95. The new `workflow_crashed` stop reason is restart-able
 * via `/restart-review`, and `postStopComment` here triggers
 * `postTerminalNotification` so a top-level comment surfaces on the PR.
 *
 * Codex P2 review on PR #96 (commit 8346b0d): the stop notification is now
 * **gated on successful state demotion**. Previously, if `updateStateComment`
 * failed (e.g. 412 conflict from a concurrent writer, or transient 5xx),
 * `postStopComment` would still run and stamp `Stopped — workflow_crashed`
 * onto the visible status comment plus a top-level "⚠️ LoopPilot stopped"
 * notification — while the hidden state remained `fixing`. That contradicts
 * operator expectations (operator sees "Stopped", tries `/restart-review`,
 * `applyRestartToState` rejects because hidden state is `fixing`) and
 * recreates exactly the silent-unrecoverable-state UX TY-282 was meant to
 * cure. With gating, demotion-failure cases fall through to the workflow
 * YAML 2B fail-safe step, which posts a distinct "⚠️ LoopPilot crashed"
 * message that does NOT claim the state was demoted.
 *
 * Never throws — recovery failures are logged via `core.error` and swallowed
 * because this runs inside the `runIfNotVitest` `onError` callback after
 * `core.setFailed` has already marked the step failed. State demotion is
 * attempted before the notification so a notification failure does not block
 * the recoverable state write.
 */
export async function demoteFixingOnCrash(
  label: CrashRecoveryLabel,
  deps: CrashRecoveryDeps = defaultDeps,
): Promise<void> {
  try {
    const crashConfig = deps.loadInitConfig();
    const crashStateResult = await deps.readState(
      crashConfig.repoOwner,
      crashConfig.repoName,
      crashConfig.prNumber,
      crashConfig.githubToken,
    );
    if (!(crashStateResult.found && crashStateResult.state.status === "fixing")) {
      return;
    }

    core.warning(
      `[${label}] Crash recovery: resetting fixing → stopped (workflow_crashed)`,
    );
    const recoveredState: ReviewState = {
      ...crashStateResult.state,
      // TY-302 #1: roll back the iteration / history entries pre-fix Phase 3
      // optimistically claimed before the crash so a soft `/restart-review`
      // does not loop-detect on the orphan entry.
      ...rollbackFixingClaim(crashStateResult.state),
      status: "stopped",
      stopReason: "workflow_crashed",
      // TY-273 #B4 / TY-282: the fixing attempt did not complete so the
      // timestamp is no longer meaningful and must not survive into the next
      // pre-fix stale check.
      fixingStartedAt: null,
      currentIterationFindingCommentIds: [],
    };
    let stateWriteSucceeded = false;
    try {
      await deps.updateStateComment(
        crashConfig.repoOwner,
        crashConfig.repoName,
        crashStateResult.commentId,
        recoveredState,
        crashConfig.githubToken,
        { expectedUpdatedAt: crashStateResult.commentUpdatedAt },
      );
      stateWriteSucceeded = true;
    } catch (writeError) {
      // State write failed — typically a concurrent run already wrote a
      // different terminal state, or a transient GitHub API error. We
      // deliberately do NOT fall through to `postStopComment` here (see the
      // function docstring): publishing a "Stopped" status entry and a
      // top-level ⚠️ notification while the hidden state is still `fixing`
      // misleads operators into restart attempts that `applyRestartToState`
      // will reject. The workflow YAML 2B fail-safe step posts a distinct
      // "LoopPilot crashed" notification that does not claim demotion.
      core.error(
        `[${label}] Crash recovery state write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      );
    }

    if (!stateWriteSucceeded) {
      core.warning(
        `[${label}] Skipping top-level stop notification because the state demotion failed; the workflow YAML 2B fail-safe step will post the crash notification instead.`,
      );
      return;
    }

    const detail = `Auto-fix workflow crashed during ${label}. The hidden state has been demoted to stopped/workflow_crashed; use /restart-review (or /restart-review --hard if iteration history needs clearing) to resume. Check workflow logs for the underlying exception.`;

    try {
      await deps.postStopComment(
        crashConfig.repoOwner,
        crashConfig.repoName,
        crashConfig.prNumber,
        "workflow_crashed",
        crashConfig.triggerCommentId ?? 0,
        0,
        detail,
        crashConfig.githubToken,
      );
    } catch (notifyError) {
      // Best-effort: a missing token / API outage must not prevent the state
      // write that already succeeded above. The workflow-level fail-safe
      // step (looppilot-loop.yml `if: failure()`) is the durable backstop.
      core.error(
        `[${label}] Crash recovery notification failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
      );
    }
  } catch (recoveryError) {
    core.error(
      `[${label}] Crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
    );
  }
}
