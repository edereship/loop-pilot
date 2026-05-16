import * as core from "@actions/core";
import { loadInitConfig as defaultLoadInitConfig } from "./config.js";
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
}

const defaultDeps: CrashRecoveryDeps = {
  loadInitConfig: defaultLoadInitConfig,
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
};

/**
 * Recover from a crash in pre-fix / post-fix: if the hidden state was left at
 * `status === "fixing"`, demote it back to `stopped + state_corrupted` so the
 * next trigger can proceed without `/restart-review --hard`.
 *
 * Never throws — recovery failures are logged via `core.error` and swallowed
 * because this runs inside the `runIfNotVitest` `onError` callback after
 * `core.setFailed` has already marked the step failed.
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
    if (crashStateResult.found && crashStateResult.state.status === "fixing") {
      core.warning(
        `[${label}] Crash recovery: resetting fixing → stopped (state_corrupted)`,
      );
      const recoveredState: ReviewState = {
        ...crashStateResult.state,
        status: "stopped",
        stopReason: "state_corrupted",
      };
      await deps.updateStateComment(
        crashConfig.repoOwner,
        crashConfig.repoName,
        crashStateResult.commentId,
        recoveredState,
        crashConfig.githubToken,
        { expectedUpdatedAt: crashStateResult.commentUpdatedAt },
      );
    }
  } catch (recoveryError) {
    core.error(
      `[${label}] Crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
    );
  }
}
