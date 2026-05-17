import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import {
  loadInitConfig,
  type BaseConfig,
} from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import { demoteFixingOnCrash } from "./crash-recovery.js";
import {
  readState as defaultReadState,
  updateStateComment as defaultUpdateStateComment,
} from "./state-manager.js";
import { createLockedStateUpdater } from "./state-comment-locker.js";
import * as git from "./git.js";
import { runCheckCommand as defaultRunCheckCommand } from "./check-runner.js";
import {
  parseGitNumstat,
  checkScope,
  buildScopePolicy,
  type ChangedFile,
  type ScopeCheckResult,
} from "./scope-checker.js";
import {
  truncatePreviousCheckFailure,
} from "./claude-code-repair-request.js";
import {
  postClaudeCodeActionFixSummary as defaultPostClaudeCodeActionFixSummary,
  postCodexReviewRequest as defaultPostCodexReviewRequest,
  postStopComment as defaultPostStopComment,
  postTestFailureComment as defaultPostTestFailureComment,
} from "./comment-poster.js";
import { registerAllSecrets } from "./secrets.js";
import type { ReviewState, StopReason } from "./types.js";

/**
 * Inputs received from the composite action's pre-fix and claude-code-action
 * steps. The post-fix step always runs (`if: always()`) when pre-fix gated
 * `should_run=true`, so this includes the claude-code-action `outcome` /
 * `conclusion` for failure / timeout handling.
 */
export interface PostFixInputs {
  commentId: number;
  iteration: number;
  checkCommand: string;
  prHeadRef: string;
  triggerCommentId: number;
  /**
   * GitHub Actions step `outcome`: "success" | "failure" | "cancelled" |
   * "skipped". Set on the `claude-code-action@v1` step. We intentionally
   * accept the wider string type so the YAML can pass the raw expression.
   */
  actionOutcome: string;
  /**
   * Optional path to the claude-code-action execution output file. When
   * present and readable, post-fix inspects it to distinguish
   * `max_turns_exceeded` from generic `action_failure`.
   */
  actionExecutionFile: string;
}

export interface PostFixDeps {
  readState: typeof defaultReadState;
  updateStateComment: typeof defaultUpdateStateComment;
  runCheckCommand: typeof defaultRunCheckCommand;
  postClaudeCodeActionFixSummary: typeof defaultPostClaudeCodeActionFixSummary;
  postCodexReviewRequest: typeof defaultPostCodexReviewRequest;
  postStopComment: typeof defaultPostStopComment;
  postTestFailureComment: typeof defaultPostTestFailureComment;
  setSecret: (secret: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  /**
   * Returns numstat output (stdout) for `git diff --numstat --no-renames HEAD`.
   *
   * `--no-renames` is mandatory: without it git emits compact rename notation
   * (`src/{a.ts => b.ts}`) that is not a real filesystem path and would crash
   * subsequent `git add -- <path>` calls in `stagePaths`.
   */
  gitDiffNumstat: () => string;
  /** Lists untracked file paths from the working tree (one per line). */
  gitListUntracked: () => string;
  /**
   * Reads a working-tree file. Used to count lines for synthesized numstat
   * entries of untracked files. Returns null on read failure (binary, missing,
   * or permission error); the caller treats null as a binary entry.
   */
  readWorkingTreeFile: (path: string) => string | null;
  /** Capture HEAD sha for logging. Returns "" on failure. */
  readHeadSha: () => string;
  /**
   * Reverts the working tree to HEAD AND removes untracked files / dirs.
   * Used on scope_violation, action_failure, and CHECK failure paths so that
   * new files written by claude-code-action are also cleaned up (a plain
   * `git reset --hard HEAD` only touches tracked paths).
   */
  resetWorkingTree: () => void;
  /** Stages the given paths. */
  stagePaths: (paths: string[]) => void;
  /** Returns true if the index has staged changes. */
  hasStagedChanges: () => boolean;
  /** Creates a commit with the supplied message. */
  commit: (message: string) => void;
  /** Pushes HEAD to the given branch on github.com/<owner>/<repo>.git, optionally using a push token. */
  push: (owner: string, repo: string, ref: string, token: string) => void;
  /** Reads the file at `path` as utf-8. Returns null on failure. */
  readActionExecutionFile: (path: string) => string | null;
}

const defaultDeps: PostFixDeps = {
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
  runCheckCommand: defaultRunCheckCommand,
  postClaudeCodeActionFixSummary: defaultPostClaudeCodeActionFixSummary,
  postCodexReviewRequest: defaultPostCodexReviewRequest,
  postStopComment: defaultPostStopComment,
  postTestFailureComment: defaultPostTestFailureComment,
  setSecret: (secret) => core.setSecret(secret),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  error: (message) => core.error(message),
  gitDiffNumstat: git.gitDiffNumstat,
  gitListUntracked: git.gitListUntracked,
  readWorkingTreeFile: git.readWorkingTreeFile,
  readHeadSha: () => git.readHeadSha("post-fix"),
  resetWorkingTree: git.resetWorkingTree,
  stagePaths: git.stagePaths,
  hasStagedChanges: git.hasStagedChanges,
  commit: git.commit,
  push: git.pushWithToken,
  readActionExecutionFile: (path) => {
    if (!path) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  },
};

function readPostFixInputs(): PostFixInputs {
  const commentId = parseInt(core.getInput("comment-id"), 10);
  const iteration = parseInt(core.getInput("iteration"), 10);
  const triggerCommentId = parseInt(core.getInput("trigger-comment-id") || "0", 10);
  if (!Number.isFinite(commentId) || commentId <= 0) {
    throw new Error(`[post-fix] Invalid input comment-id: ${core.getInput("comment-id")}`);
  }
  if (!Number.isFinite(iteration) || iteration <= 0) {
    throw new Error(`[post-fix] Invalid input iteration: ${core.getInput("iteration")}`);
  }
  return {
    commentId,
    iteration,
    triggerCommentId: Number.isFinite(triggerCommentId) ? triggerCommentId : 0,
    checkCommand: core.getInput("check-command") || "npm run check",
    prHeadRef: core.getInput("pr-head-ref"),
    actionOutcome: core.getInput("action-outcome") || "success",
    actionExecutionFile: core.getInput("action-execution-file") || "",
  };
}

/**
 * Determine whether a non-success claude-code-action outcome was caused by the
 * configured `--max-turns` budget being exhausted. Returns null when the
 * execution file is missing / unreadable / does not match the heuristic.
 */
function detectMaxTurnsExceeded(executionFileContents: string | null): boolean {
  if (executionFileContents === null) return false;
  // The Claude Code SDK surfaces the limit either as a structured field or
  // a human-readable line; match both shapes leniently.
  const haystack = executionFileContents.toLowerCase();
  return (
    haystack.includes("max_turns") ||
    haystack.includes("max turns") ||
    haystack.includes("maximum turns")
  );
}

interface FailureExitOptions {
  config: BaseConfig;
  inputs: PostFixInputs;
  state: ReviewState;
  stopReason: StopReason;
  detail: string;
  postCheckFailureBody?: string;
  /** When true, save `postCheckFailureBody` (truncated) into previousCheckFailure. */
  preservePreviousCheckFailure?: boolean;
  remainingFindings?: number;
}

export async function runPostFix(
  config: BaseConfig,
  deps: PostFixDeps = defaultDeps,
  inputs: PostFixInputs = readPostFixInputs(),
): Promise<void> {
  // TY-264: shared helper so a new Config secret is masked symmetrically in
  // init/pre-fix/post-fix. Anthropic credentials are also registered here in
  // case the wrapping workflow exports `ANTHROPIC_API_KEY` via `env:` without
  // going through `loadConfig` (post-fix uses `loadInitConfig`, which leaves
  // those two fields empty by design).
  registerAllSecrets(config, deps.setSecret);

  deps.info(
    `[post-fix] Starting post-fix for PR #${config.prNumber}, iteration ${inputs.iteration}, action outcome: ${inputs.actionOutcome}`,
  );

  // Re-read state to get the latest commentUpdatedAt for optimistic locking,
  // and to verify pre-fix actually claimed the "fixing" status.
  const stateResult = await deps.readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  if (!stateResult.found) {
    deps.error(
      "[post-fix] Hidden state comment is missing or corrupted at post-fix entry. Cannot proceed.",
    );
    return;
  }
  if (stateResult.commentId !== inputs.commentId) {
    deps.warning(
      `[post-fix] State comment id changed since pre-fix (pre=${inputs.commentId}, current=${stateResult.commentId}). Using current id.`,
    );
  }
  if (stateResult.state.status !== "fixing") {
    deps.warning(
      `[post-fix] Expected status 'fixing' but found '${stateResult.state.status}'. Pre-fix may have short-circuited or another workflow ran. Skipping post-fix.`,
    );
    return;
  }

  const state = stateResult.state;
  const commentId = stateResult.commentId;

  const updateStateCommentLocked = createLockedStateUpdater({
    owner: config.repoOwner,
    repo: config.repoName,
    commentId,
    token: config.githubToken,
    initialExpectedUpdatedAt: stateResult.commentUpdatedAt,
    label: "post-fix",
    updateStateComment: deps.updateStateComment,
    warning: deps.warning,
    onConflict: async (detail) => {
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "state_conflict",
        inputs.triggerCommentId,
        0,
        `${detail} Hidden comment was updated by another workflow run before this run could safely persist its state.`,
        config.githubToken,
      );
    },
  });

  async function failureExit(opts: FailureExitOptions): Promise<void> {
    const previousCheckFailure =
      opts.preservePreviousCheckFailure && opts.postCheckFailureBody
        ? truncatePreviousCheckFailure(opts.postCheckFailureBody)
        : null;

    // Pre-fix optimistically claimed `fixing` with iterationCount+1 and
    // appended the current findings hash to history before claude-code-action
    // ran. When post-fix is stopping without a committed fix, that bookkeeping
    // would otherwise consume an iteration and pre-poison loop detection for
    // a subsequent soft /restart-review (next run sees the same hash already
    // in history → `loop_detected` immediately). Roll back both fields so the
    // user can retry the same Codex findings after intervention.
    const rolledBackHistory = opts.state.findingsHashHistory.slice(0, -1);
    const rolledBackLastHash =
      rolledBackHistory.length > 0
        ? rolledBackHistory[rolledBackHistory.length - 1].hash
        : null;

    const stoppedState: ReviewState = {
      ...opts.state,
      iterationCount: Math.max(0, opts.state.iterationCount - 1),
      findingsHashHistory: rolledBackHistory,
      lastFindingsHash: rolledBackLastHash,
      status: "stopped",
      stopReason: opts.stopReason,
      previousCheckFailure,
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        `Could not stop after ${opts.stopReason}.`,
      ))
    ) {
      return;
    }
    if (opts.stopReason === "test_failure" && opts.postCheckFailureBody) {
      await deps.postTestFailureComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        opts.postCheckFailureBody,
        config.githubToken,
      );
    } else {
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        opts.stopReason,
        inputs.triggerCommentId,
        opts.remainingFindings ?? 0,
        opts.detail,
        config.githubToken,
      );
    }
  }

  // ─── claude-code-action outcome handling ─────────────────────────────────
  const outcome = inputs.actionOutcome.toLowerCase();
  if (outcome !== "success") {
    deps.warning(
      `[post-fix] claude-code-action outcome=${inputs.actionOutcome}. Reverting working tree and stopping.`,
    );
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after action failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }

    let stopReason: StopReason = "action_failure";
    let detail = `claude-code-action exited with outcome=${inputs.actionOutcome}.`;

    if (outcome === "cancelled") {
      // Cancelled steps are typically the result of job-level timeout or a
      // manual cancel. The dedicated stop reason for the workflow timeout
      // case is action_timeout.
      stopReason = "action_timeout";
      detail =
        "claude-code-action step was cancelled, typically because the workflow job timeout was reached.";
    } else if (outcome === "failure") {
      const fileContents = deps.readActionExecutionFile(inputs.actionExecutionFile);
      if (detectMaxTurnsExceeded(fileContents)) {
        stopReason = "max_turns_exceeded";
        detail = "claude-code-action exhausted the configured --max-turns budget.";
      }
    }

    await failureExit({
      config,
      inputs,
      state,
      stopReason,
      detail,
    });
    return;
  }

  // ─── Scope check ─────────────────────────────────────────────────────────
  // Combine `git diff --numstat HEAD` (tracked edits / deletions; ignoring
  // rename detection so paths are real filesystem paths, not `{a => b}`
  // notation) with `git ls-files --others --exclude-standard` (untracked
  // files). Without the second source, brand-new files written by
  // claude-code-action are invisible to the pipeline and either drop the
  // entire run as a no-op or partially stage edits — see Codex review
  // feedback on PR #33.
  let numstat: string;
  let untrackedRaw: string;
  try {
    numstat = deps.gitDiffNumstat();
    untrackedRaw = deps.gitListUntracked();
  } catch (error) {
    deps.error(
      `[post-fix] Failed to enumerate working-tree changes: ${error instanceof Error ? error.message : String(error)}`,
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Could not enumerate working-tree changes via git diff / ls-files.",
    });
    return;
  }
  const trackedChanges: ChangedFile[] = parseGitNumstat(numstat);
  const untrackedChanges: ChangedFile[] = untrackedRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => {
      const content = deps.readWorkingTreeFile(path);
      // null content (binary, missing, permission) → mark as binary so
      // checkScope rejects it explicitly via reason="binary_change" rather
      // than silently undercounting line totals.
      if (content === null) {
        return { path, added: -1, deleted: -1 };
      }
      const added = content.length === 0 ? 0 : content.split("\n").length;
      return { path, added, deleted: 0 };
    });
  const changedFiles: ChangedFile[] = [...trackedChanges, ...untrackedChanges];
  deps.info(
    `[post-fix] Detected ${changedFiles.length} changed file(s) in working tree (${trackedChanges.length} tracked, ${untrackedChanges.length} new).`,
  );

  if (changedFiles.length === 0) {
    deps.warning(
      "[post-fix] claude-code-action made no file changes. Treating as no-op success and re-requesting Codex review.",
    );
    const waitingState: ReviewState = {
      ...state,
      status: "waiting_codex",
      // TY-258: clear any `max_turns_exceeded` (or other) stop reason carried
      // over from a previous stop + `/restart-review`, so escalation stays
      // one-shot once the action finishes without an error outcome.
      stopReason: null,
      previousCheckFailure: null,
    };
    if (
      !(await updateStateCommentLocked(
        waitingState,
        "Could not return state to waiting_codex after no-op claude-code-action run.",
      ))
    ) {
      return;
    }
    try {
      const reviewRequestId = await deps.postCodexReviewRequest(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        config.codexReviewRequestToken,
      );
      const updated: ReviewState = {
        ...waitingState,
        lastCodexRequestCommentId: reviewRequestId,
      };
      await updateStateCommentLocked(
        updated,
        "Could not persist Codex review request comment id after no-op run.",
      );
    } catch (error) {
      deps.error(
        `[post-fix] Failed to re-request Codex review: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  if (config.hardBlockOverride.length > 0) {
    deps.info(
      `[scope-check] hard-block override paths: [${config.hardBlockOverride.join(", ")}]`,
    );
  }
  // TY-266: build the policy from action inputs so consumers can reshape
  // allowed prefixes / budgets / additional hard-block prefixes without
  // forking. Empty / zero values fall back to DEFAULT_SCOPE_POLICY.
  const scopePolicy = buildScopePolicy({
    allowedPathPrefixes: config.scopeAllowedPathPrefixes,
    maxFiles: config.scopeMaxFiles > 0 ? config.scopeMaxFiles : undefined,
    maxLines: config.scopeMaxLines > 0 ? config.scopeMaxLines : undefined,
    additionalHardBlockPrefixes: config.scopeAdditionalHardBlockPrefixes,
    hardBlockOverride: config.hardBlockOverride,
  });
  if (config.scopeAllowedPathPrefixes.length > 0) {
    deps.info(
      `[scope-check] allowed path prefixes (override): [${config.scopeAllowedPathPrefixes.join(", ")}]`,
    );
  }
  if (config.scopeAdditionalHardBlockPrefixes.length > 0) {
    deps.info(
      `[scope-check] additional hard-block prefixes: [${config.scopeAdditionalHardBlockPrefixes.join(", ")}]`,
    );
  }
  const scopeResult: ScopeCheckResult = checkScope(changedFiles, scopePolicy);
  if (!scopeResult.ok) {
    deps.warning(`[post-fix] Scope violation: ${scopeResult.message}`);
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "scope_violation",
      detail: scopeResult.message,
    });
    return;
  }

  deps.info(
    `[post-fix] Scope check passed: ${scopeResult.changedFiles} file(s), ${scopeResult.totalLines} line(s).`,
  );

  // ─── CHECK_COMMAND ───────────────────────────────────────────────────────
  // Pass only tracked paths to runCheckCommand: its rollback is `git checkout
  // -- <path>`, which errors out for paths git has never seen (untracked
  // files). Untracked files are reverted below via resetWorkingTree on the
  // failure path.
  const modifiedFiles = changedFiles.map((f) => f.path);
  const trackedModified = trackedChanges.map((f) => f.path);
  deps.info(`[post-fix] Running CHECK_COMMAND: ${inputs.checkCommand}`);
  const checkResult = await deps.runCheckCommand(inputs.checkCommand, trackedModified);

  if (!checkResult.success) {
    deps.error("[post-fix] CHECK_COMMAND failed. Reverting working tree (incl. untracked).");
    try {
      // resetWorkingTree does `git reset --hard HEAD && git clean -ffd`, which
      // also removes untracked files written by claude-code-action that
      // check-runner's per-path rollback cannot see.
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after CHECK_COMMAND failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "test_failure",
      detail: "CHECK_COMMAND failed after claude-code-action repair.",
      postCheckFailureBody: checkResult.output,
      preservePreviousCheckFailure: true,
    });
    return;
  }

  deps.info("[post-fix] CHECK_COMMAND passed. Committing changes...");

  // Stage every file that the scope check accepted, then commit + push.
  try {
    deps.stagePaths(modifiedFiles);
  } catch (error) {
    deps.error(
      `[post-fix] git add failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Failed to stage repaired files for commit.",
    });
    return;
  }

  let commitSha = "";
  if (deps.hasStagedChanges()) {
    const commitMessage = [
      `fix: auto-resolve Codex review findings (iteration ${inputs.iteration})`,
      "",
      "Generated by anthropics/claude-code-action@v1 (auto-review-loop).",
      `Files: ${modifiedFiles.length}, lines: ${scopeResult.totalLines}.`,
    ].join("\n");
    try {
      deps.commit(commitMessage);
      deps.push(
        config.repoOwner,
        config.repoName,
        inputs.prHeadRef,
        config.autoReviewPushToken,
      );
    } catch (error) {
      deps.error(
        `[post-fix] commit/push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: "Failed to commit or push repaired changes.",
      });
      return;
    }
    commitSha = deps.readHeadSha();
    deps.info(`[post-fix] Committed and pushed: ${commitSha}`);
  } else {
    deps.warning(
      "[post-fix] No staged changes after `git add`. Skipping commit; treating as no-op.",
    );
  }

  await deps.postClaudeCodeActionFixSummary(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    inputs.iteration,
    modifiedFiles,
    commitSha || undefined,
    config.githubToken,
  );

  // ─── Phase 4: Re-review ──────────────────────────────────────────────────
  const waitingState: ReviewState = {
    ...state,
    status: "waiting_codex",
    lastClaudeCommitSha: commitSha || state.lastClaudeCommitSha,
    // TY-258: clear any `max_turns_exceeded` (or other) stop reason carried
    // over from a previous stop + `/restart-review`. A successful repair
    // means the escalation signal has done its job and the next iteration
    // should fall back to normal tiering (one-shot escalation).
    stopReason: null,
    previousCheckFailure: null,
  };
  if (
    !(await updateStateCommentLocked(
      waitingState,
      "Could not return state to waiting_codex after committing fixes.",
    ))
  ) {
    return;
  }

  deps.info("[post-fix] Posting @codex review request...");
  try {
    const reviewRequestId = await deps.postCodexReviewRequest(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.codexReviewRequestToken,
    );
    const updatedWaitingState: ReviewState = {
      ...waitingState,
      lastCodexRequestCommentId: reviewRequestId,
    };
    if (
      !(await updateStateCommentLocked(
        updatedWaitingState,
        "Could not persist the Codex review request comment id.",
      ))
    ) {
      return;
    }
    deps.info(
      `[post-fix] Phase 4 complete. Status: waiting_codex. Review request: ${reviewRequestId}`,
    );
  } catch (error) {
    deps.error(
      `[post-fix] Failed to post Codex review request: ${error instanceof Error ? error.message : String(error)}. ` +
        "State is waiting_codex. Manual '@codex review' comment may be needed.",
    );
  }
}

async function run(): Promise<void> {
  await runPostFix(loadInitConfig());
}

runIfNotVitest(run, () => demoteFixingOnCrash("post-fix"));
