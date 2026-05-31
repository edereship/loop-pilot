import * as core from "@actions/core";
import { loadInitConfig } from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import {
  createInitialState,
  createStateComment,
  updateStateComment,
  readState,
  StateUpdateConflictError,
} from "./state-manager.js";
import {
  postCodexReviewRequest,
  postInitialStatusComment,
  postStopComment,
  deriveIterationProgress,
} from "./comment-poster.js";
import { ensureCodexAck } from "./codex-ack.js";
import type { CodexAckParams, CodexAckResult } from "./codex-ack.js";
import type { BaseConfig } from "./config.js";
import type { ReviewState } from "./types.js";
import { registerAllSecrets } from "./secrets.js";

type ReadState = typeof readState;
type CreateStateComment = typeof createStateComment;
type UpdateStateComment = typeof updateStateComment;
type PostCodexReviewRequest = typeof postCodexReviewRequest;
type PostInitialStatusComment = typeof postInitialStatusComment;
type PostStopComment = typeof postStopComment;

export interface InitDeps {
  readState: ReadState;
  createStateComment: CreateStateComment;
  updateStateComment: UpdateStateComment;
  postCodexReviewRequest: PostCodexReviewRequest;
  postInitialStatusComment: PostInitialStatusComment;
  postStopComment: PostStopComment;
  // TY-334: injected so tests can drive ACK / no-ACK without real polling.
  ensureCodexAck: (params: CodexAckParams) => Promise<CodexAckResult>;
  setSecret: (secret: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  setOutput: (name: string, value: string) => void;
}

const defaultDeps: InitDeps = {
  readState,
  createStateComment,
  updateStateComment,
  postCodexReviewRequest,
  postInitialStatusComment,
  postStopComment,
  ensureCodexAck: (params) => ensureCodexAck(params),
  // TY-276 #4: wrap @actions/core methods in arrows for symmetry with
  // main-pre-fix / main-post-fix. The direct-reference form works today
  // because `@actions/core` does not use `this`, but a future version that
  // does would silently break.
  setSecret: (secret) => core.setSecret(secret),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  setOutput: (name, value) => core.setOutput(name, value),
};

export async function runInit(config: BaseConfig, deps: InitDeps = defaultDeps): Promise<void> {
  registerAllSecrets(config, deps.setSecret);
  deps.info(`Initializing LoopPilot for PR #${config.prNumber}`);

  // Check for existing hidden comment (re-run support)
  const existing = await deps.readState(
    config.repoOwner, config.repoName, config.prNumber, config.githubToken,
  );

  let commentId: number;
  let state = createInitialState();
  // Finding 1: track commentUpdatedAt so the 1st write can use optimistic locking
  // when resuming an existing comment, preventing stale init runs from clobbering
  // state that Workflow B has already advanced.
  let firstWriteExpectedUpdatedAt: string | undefined;

  if (existing.found) {
    commentId = existing.commentId;
    firstWriteExpectedUpdatedAt = existing.commentUpdatedAt; // Finding 1
    if (
      existing.state.status === "waiting_codex" &&
      existing.state.lastCodexRequestCommentId === null &&
      existing.state.iterationCount === 0 && // Finding 2
      existing.state.lastCodexReviewReceivedAt === null // Finding 2
    ) {
      // Crash-window recovery: the 1st write (waiting_codex + null) succeeded but
      // the job was cancelled before @codex review was posted. Only resume when the
      // state looks like a genuinely fresh init (iterationCount === 0, no prior
      // Codex reviews), which rules out /restart-review transient states where
      // iterationCount or lastCodexReviewReceivedAt would be non-null/non-zero.
      // Synthesize "initialized" as the base state so stateBeforeFirstWrite is
      // a restartable rollback target, then fall through to the normal
      // 1st-write → post → 2nd-write sequence. The 1st write is idempotent
      // (re-writing the same waiting_codex + null value).
      deps.info(
        "[init] Detected crash-window state (waiting_codex + null lastCodexRequestCommentId). " +
          "Resuming 1st-write → post → 2nd-write sequence.",
      );
      state = { ...existing.state, status: "initialized" };
    } else if (existing.state.status !== "initialized") {
      deps.info(`LoopPilot state is already ${existing.state.status}. Skipping init.`);
      deps.setOutput("comment-id", String(commentId));
      return;
    } else {
      deps.info("Found incomplete initialized state comment, continuing init");
      state = { ...existing.state };
    }
  } else if (existing.corrupted && existing.commentId !== null) {
    deps.warning("Found corrupted state comment, overwriting with fresh state");
    commentId = existing.commentId;
    await deps.updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);
  } else {
    commentId = await deps.createStateComment(config.repoOwner, config.repoName, config.prNumber, state, config.githubToken);
    deps.info(`Created state comment: ${commentId}`);
  }

  // TY-303: align with post-fix Phase 4's "1st write (status: waiting_codex,
  // lastCodexRequestCommentId: null) → post @codex review → 2nd write (id
  // recorded)" pattern. We always do the 1st write even when resuming a legacy
  // initialized state that already has a non-null lastCodexRequestCommentId:
  // the prior @codex review was a one-shot `created` event that fired while
  // state was still `initialized`, so Workflow B's early-return consumed that
  // trigger without processing it — a fresh post is required to regenerate
  // the trigger and advance the loop.
  const stateBeforeFirstWrite = { ...state };
  state = { ...state, status: "waiting_codex", lastCodexRequestCommentId: null };
  // Finding 1: use optimistic locking on the 1st write when resuming an existing
  // comment (firstWriteExpectedUpdatedAt is set). A conflict means Workflow B
  // advanced the state between readState and this write; abort gracefully instead
  // of clobbering newer state and re-posting @codex review.
  let firstWriteResult: Awaited<ReturnType<typeof deps.updateStateComment>>;
  try {
    if (firstWriteExpectedUpdatedAt !== undefined) {
      firstWriteResult = await deps.updateStateComment(
        config.repoOwner, config.repoName, commentId, state, config.githubToken,
        { expectedUpdatedAt: firstWriteExpectedUpdatedAt },
      );
    } else {
      firstWriteResult = await deps.updateStateComment(
        config.repoOwner, config.repoName, commentId, state, config.githubToken,
      );
    }
  } catch (error) {
    if (firstWriteExpectedUpdatedAt !== undefined && error instanceof StateUpdateConflictError) {
      deps.warning(
        `[init] Concurrent state update detected on 1st write. ` +
          "Workflow B has already advanced the state; skipping init.",
      );
      deps.setOutput("comment-id", String(commentId));
      return;
    }
    throw error;
  }

  let reviewRequestId: number;
  // TY-334: capture before posting so any Codex activity that arrives between
  // the post and this timestamp is not excluded by the `since` filter.
  const codexRequestedAt = new Date().toISOString();
  try {
    reviewRequestId = await deps.postCodexReviewRequest(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.codexReviewRequestToken,
    );
    deps.info(`Posted @codex review: comment ${reviewRequestId}`);
  } catch (error) {
    // Roll back to the pre-1st-write state (status: initialized) so the next
    // Workflow A rerun retries the full 1st-write → post → 2nd-write sequence
    // instead of hitting the non-initialized early-return branch.
    try {
      await deps.updateStateComment(
        config.repoOwner, config.repoName, commentId, stateBeforeFirstWrite, config.githubToken,
        { expectedUpdatedAt: firstWriteResult.updatedAt },
      );
    } catch (rollbackError) {
      if (rollbackError instanceof StateUpdateConflictError) {
        // Workflow B advanced the state while we were posting — no rollback needed and
        // no terminal state: Workflow B is already handling the transition.
        deps.warning(
          `[init] Roll-back skipped: concurrent Workflow B update detected after @codex review post failure. ` +
            "Workflow B is handling the state; no terminal state needed.",
        );
      } else {
        const rbMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        deps.warning(
          `[init] Failed to roll back state after @codex review post failure: ${rbMsg}. ` +
            "Demoting to stopped/codex_request_failed.",
        );
        // Finding 3: both the post and the rollback failed. State is stuck at
        // waiting_codex + null. Write a terminal state so future Workflow A reruns
        // hit the stopped early-return rather than the non-initialized skip, and
        // operators receive a clear signal. Use the 1st-write updatedAt as an
        // optimistic lock so a concurrent Workflow B advance is detected and not
        // clobbered by this terminal write. Best-effort: if this write also fails
        // the rethrow below still surfaces the original error.
        try {
          await deps.updateStateComment(
            config.repoOwner, config.repoName, commentId,
            { ...state, status: "stopped", stopReason: "codex_request_failed" },
            config.githubToken,
            { expectedUpdatedAt: firstWriteResult.updatedAt },
          );
        } catch (stopError) {
          if (stopError instanceof StateUpdateConflictError) {
            deps.warning(
              `[init] Fallback stop write detected concurrent state update. ` +
                "Workflow B has already advanced the state; no terminal state needed.",
            );
          } else {
            const stopMsg = stopError instanceof Error ? stopError.message : String(stopError);
            deps.warning(
              `[init] Failed to write stopped/codex_request_failed state: ${stopMsg}. ` +
                "State may be stuck at waiting_codex; manual intervention required.",
            );
          }
        }
      }
    }
    throw error;
  }

  // 2nd write: record lastCodexRequestCommentId (informational). The 1st
  // write already committed `waiting_codex`, so a failure here cannot
  // deadlock the loop — the next Codex review trigger will reconcile.
  // Downgrade to warning, matching post-fix Phase 4 / TY-286 #A.
  // Finding 1: pass expectedUpdatedAt (from the 1st write) so a concurrent
  // Workflow B update (e.g. waiting_codex → fixing) is detected via
  // StateUpdateConflictError and not silently overwritten.
  state = {
    ...state,
    status: "waiting_codex",
    lastCodexRequestCommentId: reviewRequestId,
  };
  // TY-334: updatedAt of the latest confirmed `waiting_codex` write, used as
  // the optimistic lock for the ACK-failure demotion below. Stays undefined
  // when the 2nd write cannot be confirmed, in which case ACK polling is
  // skipped (we cannot safely mutate state we do not have a lock for).
  let ackLockUpdatedAt: string | undefined;
  try {
    const secondWriteResult = await deps.updateStateComment(
      config.repoOwner, config.repoName, commentId, state, config.githubToken,
      { expectedUpdatedAt: firstWriteResult.updatedAt },
    );
    ackLockUpdatedAt = secondWriteResult.updatedAt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warning(
      `[init] Failed to persist lastCodexRequestCommentId after @codex review post: ${message}. ` +
        "LoopPilot state remains waiting_codex; the next Codex review trigger will reconcile.",
    );
    // For StateUpdateConflictError, Workflow B already advanced the state (e.g. to
    // `fixing`), so a future Workflow A rerun will see a non-null status and hit the
    // early-return — no duplicate post risk. For any other error the GitHub state is
    // still `waiting_codex + lastCodexRequestCommentId: null` (the 1st-write value),
    // which is indistinguishable from crash-window state. Retry once with the same
    // optimistic lock so that a concurrent Workflow B advance is detected rather than
    // silently overwritten; on success a future rerun sees a non-null
    // lastCodexRequestCommentId and takes the early-return rather than re-posting.
    if (!(error instanceof StateUpdateConflictError)) {
      try {
        const retryResult = await deps.updateStateComment(
          config.repoOwner, config.repoName, commentId, state, config.githubToken,
          { expectedUpdatedAt: firstWriteResult.updatedAt },
        );
        ackLockUpdatedAt = retryResult.updatedAt;
      } catch (retryError) {
        if (retryError instanceof StateUpdateConflictError) {
          deps.warning(
            `[init] Retry to persist lastCodexRequestCommentId detected a concurrent state update. ` +
              "No re-post risk: either the 2nd write already committed or Workflow B has advanced.",
          );
        } else {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          deps.warning(
            `[init] Retry to persist lastCodexRequestCommentId also failed: ${retryMsg}. ` +
              "A Workflow A rerun may re-post @codex review.",
          );
        }
      }
    }
  }

  // TY-334: poll for a Codex ACK (👀 reaction or new Codex activity) while
  // this job is still alive. If Codex silently drops the request, repost up to
  // CODEX_ACK_MAX_REPOSTS times, then demote to stopped/codex_request_failed so
  // the loop is not wedged at waiting_codex with no restart trigger. Only runs
  // when the 2nd write was confirmed (ackLockUpdatedAt set) so demotion has a
  // valid optimistic lock.
  if (ackLockUpdatedAt !== undefined) {
    const ack = await deps.ensureCodexAck({
      owner: config.repoOwner,
      repo: config.repoName,
      pr: config.prNumber,
      commentId: reviewRequestId,
      requestedAt: codexRequestedAt,
      codexBotLogin: config.codexBotLogin,
      readToken: config.githubToken,
      token: config.codexReviewRequestToken,
      timeoutSeconds: config.codexAckTimeoutSeconds,
      pollIntervalSeconds: config.codexAckPollIntervalSeconds,
      maxReposts: config.codexAckMaxReposts,
    });
    if (!ack.acked) {
      const stoppedState: ReviewState = {
        ...state,
        lastCodexRequestCommentId: ack.lastCommentId,
        status: "stopped",
        stopReason: "codex_request_failed",
      };
      try {
        await deps.updateStateComment(
          config.repoOwner, config.repoName, commentId, stoppedState, config.githubToken,
          { expectedUpdatedAt: ackLockUpdatedAt },
        );
        try {
          await deps.postStopComment(
            config.repoOwner,
            config.repoName,
            config.prNumber,
            "codex_request_failed",
            config.triggerCommentId,
            0,
            `Codex did not acknowledge the @codex review request after ${config.codexAckMaxReposts} repost(s) (≈${config.codexAckTimeoutSeconds}s per attempt). Run /restart-review once Codex is reachable to resume.`,
            config.githubToken,
            deriveIterationProgress(stoppedState, config.maxReviewIterations),
          );
        } catch (notifyError) {
          const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
          deps.warning(`[init] Demoted to stopped/codex_request_failed but failed to post the stop notification: ${msg}.`);
        }
      } catch (demoteError) {
        if (demoteError instanceof StateUpdateConflictError) {
          deps.warning(
            "[init] ACK-failure demotion skipped: Workflow B advanced the state during ACK polling.",
          );
        } else {
          const msg = demoteError instanceof Error ? demoteError.message : String(demoteError);
          deps.warning(
            `[init] Failed to demote to stopped/codex_request_failed after no Codex ACK: ${msg}. ` +
              "State remains waiting_codex; /restart-review required.",
          );
        }
      }
      deps.setOutput("comment-id", String(commentId));
      return;
    } else if (ack.reposts > 0 && ack.lastCommentId !== reviewRequestId) {
      // Best-effort: record the latest @codex review comment id after reposts.
      try {
        await deps.updateStateComment(
          config.repoOwner, config.repoName, commentId,
          { ...state, lastCodexRequestCommentId: ack.lastCommentId }, config.githubToken,
          { expectedUpdatedAt: ackLockUpdatedAt },
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.warning(
          `[init] Failed to persist reposted Codex review request id ${ack.lastCommentId}: ${msg}. ` +
            "State remains waiting_codex; the next Codex review trigger will reconcile.",
        );
      }
    }
  }

  // TY-291 #2 (UX-05): seed the visible status comment so the PR shows
  // "Initialized — waiting for first Codex review" during the 5-15 minute gap
  // before post-fix runs its first iteration. Best-effort: a failure here is
  // logged but does not roll back init — the next post-fix iteration's
  // `upsertStatusComment` is idempotent and will pick the snapshot back up.
  try {
    const statusCommentId = await deps.postInitialStatusComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.maxReviewIterations,
      config.githubToken,
    );
    deps.info(`Created initial status comment: ${statusCommentId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warning(`Failed to create initial status comment: ${message}`);
  }

  deps.info("Workflow A completed: status = waiting_codex");
  deps.setOutput("comment-id", String(commentId));
}

async function run(): Promise<void> {
  await runInit(loadInitConfig());
}

runIfNotVitest(run);
