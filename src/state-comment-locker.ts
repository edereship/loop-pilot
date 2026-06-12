import {
  StateUpdateConflictError,
  updateStateComment as defaultUpdateStateComment,
} from "./state-manager.js";
import type { ReviewState } from "./types.js";

export type LockedStateUpdaterLabel = "pre-fix" | "post-fix" | "restart";

export interface LockedStateUpdaterArgs {
  owner: string;
  repo: string;
  commentId: number;
  token: string;
  /**
   * Initial expected `updated_at` for the hidden state comment, used for the
   * first preflight optimistic-lock check. Subsequent calls use the value
   * returned by the previous `updateStateComment` invocation.
   */
  initialExpectedUpdatedAt?: string;
  /** Log prefix; produces `[pre-fix]` / `[post-fix]` in warning messages. */
  label: LockedStateUpdaterLabel;
  updateStateComment: typeof defaultUpdateStateComment;
  warning: (message: string) => void;
  /**
   * Called when `updateStateComment` throws `StateUpdateConflictError` (412).
   * Typically posts a stop comment describing why the run could not persist.
   */
  onConflict: (detail: string) => Promise<void>;
}

export type LockedStateUpdater = (
  nextState: ReviewState,
  detail: string,
  options?: LockedStateUpdaterCallOptions,
) => Promise<boolean>;

/**
 * Per-call overrides for `LockedStateUpdater`. The default `onConflict`
 * supplied to `createLockedStateUpdater` is used for terminal state writes
 * that must surface a top-level `state_conflict` stop comment. For TY-286 #A
 * / #B the 2nd write in a "write A → external side-effect → write B"
 * sequence is informational only: the hidden state machine has already been
 * advanced to a healthy `waiting_codex` and a Codex review has already been
 * posted, so a 412 here should warn (so operators can see it in logs) rather
 * than emit a misleading `⚠️ LoopPilot stopped` comment that contradicts
 * the live state.
 */
export interface LockedStateUpdaterCallOptions {
  /**
   * Override the constructor-supplied `onConflict` for this single call.
   * Useful when only some writes are terminal — e.g., a follow-up write that
   * merely records a side-effect id should not produce a stop notification.
   */
  onConflict?: (detail: string) => Promise<void>;
}

/**
 * Build a state-update function that retains the latest `updated_at` so each
 * subsequent write keeps the optimistic-lock chain unbroken. On 412 conflict
 * the supplied `onConflict` callback runs and the function resolves to
 * `false`; other errors propagate. Individual calls may override the
 * conflict handler via `options.onConflict` (TY-286).
 */
export function createLockedStateUpdater(
  args: LockedStateUpdaterArgs,
): LockedStateUpdater {
  let expectedUpdatedAt = args.initialExpectedUpdatedAt;
  return async function tryUpdate(
    nextState: ReviewState,
    detail: string,
    options?: LockedStateUpdaterCallOptions,
  ): Promise<boolean> {
    try {
      const result = await args.updateStateComment(
        args.owner,
        args.repo,
        args.commentId,
        nextState,
        args.token,
        expectedUpdatedAt ? { expectedUpdatedAt } : undefined,
      );
      expectedUpdatedAt = result.updatedAt;
      return true;
    } catch (error) {
      if (!(error instanceof StateUpdateConflictError)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      args.warning(`[${args.label}] Hidden comment state conflict. ${message}`);
      const handler = options?.onConflict ?? args.onConflict;
      await handler(detail);
      return false;
    }
  };
}
