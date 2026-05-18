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
import { runBuildCommand as defaultRunBuildCommand } from "./build-runner.js";
import {
  parseGitNumstat,
  checkScope,
  checkScopeBuildMode,
  buildScopePolicy,
  parseBlockPathsSpec,
  type ChangedFile,
  type ScopeCheckResult,
  type ScopeCheckViolation,
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
  /**
   * Optional build step (TY-281). Invoked after CHECK_COMMAND succeeds and
   * before the auto-fix commit is staged. Skipped entirely when
   * `config.buildCommand` is empty so the post-fix path remains a no-op for
   * repos that do not commit build artifacts.
   */
  runBuildCommand: typeof defaultRunBuildCommand;
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
  runBuildCommand: defaultRunBuildCommand,
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

const SCOPE_POLICY_DOC = "docs/operations/scope-policy.md";

/**
 * Compose an actionable `Detail:` body for the stop comment when the post-fix
 * scope check rejects a diff (TY-271).
 *
 * Each violation reason maps to a different remediation: hard-block paths get
 * a copy-pasteable `AUTO_REVIEW_BLOCK_PATHS=!<path>` snippet; budget overruns
 * point at `AUTO_REVIEW_SCOPE_MAX_*`; binary changes are flagged as outside
 * the auto-fix surface; path traversal is reported as a security refusal with
 * no override path.
 */
export function formatScopeViolationDetail(
  violation: ScopeCheckViolation,
  maxFiles: number,
  maxLines: number,
): string {
  switch (violation.reason) {
    case "hard_block_path": {
      const matched = violation.matchedBlockPatterns ?? [];
      const lockedPaths = matched
        .filter((p) => p.locked)
        .map((p) => p.path);
      const unlockedSnippets = matched
        .filter((p) => !p.locked)
        .map((p) => `!${p.path}`);
      const uniqueSnippets = Array.from(new Set(unlockedSnippets));
      const lines: string[] = [
        "Auto-fix touched paths blocked by the scope check.",
        "",
        "Affected paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
      ];
      if (uniqueSnippets.length > 0) {
        lines.push(
          "",
          "To let Claude edit these paths, add the matching `!` entries to the",
          "`AUTO_REVIEW_BLOCK_PATHS` Repository variable:",
          "",
          `  AUTO_REVIEW_BLOCK_PATHS = "${uniqueSnippets.join(",")}"`,
          "",
          "(If the variable is already set, append the new entries with a comma.)",
        );
      }
      if (lockedPaths.length > 0) {
        lines.push(
          "",
          `Note: \`.github/\` is locked and cannot be unblocked — ${lockedPaths.join(", ")} must be edited manually.`,
        );
      }
      lines.push("", `See ${SCOPE_POLICY_DOC}.`);
      return lines.join("\n");
    }
    case "too_many_files":
      return [
        `Auto-fix diff exceeds the file-count budget (${violation.offendingPaths.length} > ${maxFiles}).`,
        "",
        "To raise the limit, set the `AUTO_REVIEW_SCOPE_MAX_FILES` Repository variable",
        "(or pass the `scope-max-files` action input) to a higher value.",
        "",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "too_many_lines":
      return [
        `Auto-fix diff exceeds the line-count budget (limit ${maxLines}).`,
        "",
        "To raise the limit, set the `AUTO_REVIEW_SCOPE_MAX_LINES` Repository variable",
        "(or pass the `scope-max-lines` action input) to a higher value.",
        "",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "binary_change":
      return [
        "Auto-fix produced a binary change, which the loop cannot validate.",
        "",
        "Affected paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
        "",
        "Auto-fix only handles text edits. Apply the binary change manually.",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "path_traversal":
      return [
        "Refusing to apply a diff containing path-traversal or absolute paths.",
        "",
        "Offending paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
        "",
        "This is a hard security refusal and has no override.",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
  }
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
      // TY-273 #B4: leaving stale entry would mislead the next pre-fix run.
      fixingStartedAt: null,
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
    // TY-273 #B3: roll back the optimistic Phase 3 bookkeeping. Pre-fix
    // appended the current findings hash to `findingsHashHistory` and bumped
    // `iterationCount` before claude-code-action ran. When no file edits
    // result, leaving those updates in place poisons two downstream paths:
    //   1. The tier-aware loop detector (TY-243) sees the just-written hash
    //      as a "previous" entry and short-circuits the next iteration into
    //      `loop_detected` even though no fix was actually attempted.
    //   2. iterationCount silently advances toward MAX_REVIEW_ITERATIONS
    //      for runs that produced nothing.
    // Mirror the rollback in `failureExit` so the no-op path leaves state
    // identical to "pre-fix never ran Phase 3" for retry purposes.
    const rolledBackHistory = state.findingsHashHistory.slice(0, -1);
    const rolledBackLastHash =
      rolledBackHistory.length > 0
        ? rolledBackHistory[rolledBackHistory.length - 1].hash
        : null;
    const waitingState: ReviewState = {
      ...state,
      iterationCount: Math.max(0, state.iterationCount - 1),
      findingsHashHistory: rolledBackHistory,
      lastFindingsHash: rolledBackLastHash,
      status: "waiting_codex",
      // TY-258: clear any `max_turns_exceeded` (or other) stop reason carried
      // over from a previous stop + `/restart-review`, so escalation stays
      // one-shot once the action finishes without an error outcome.
      stopReason: null,
      previousCheckFailure: null,
      // TY-273 #B4: fixingStartedAt only describes the *current* fixing
      // attempt; clearing it on every terminal transition keeps the next
      // `fixing` claim's stale window honest.
      fixingStartedAt: null,
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
      // TY-273 #B5: same deadlock as the committed-fix Phase 4 path —
      // leaving status at waiting_codex with a stale request id silently
      // strands the loop. Downgrade so the operator gets a notification.
      const message = error instanceof Error ? error.message : String(error);
      deps.error(
        `[post-fix] Failed to re-request Codex review (no-op path): ${message}. Downgrading to stopped/codex_request_failed.`,
      );
      const stoppedState: ReviewState = {
        ...waitingState,
        status: "stopped",
        stopReason: "codex_request_failed",
      };
      if (
        !(await updateStateCommentLocked(
          stoppedState,
          "Could not record codex_request_failed stop after no-op run.",
        ))
      ) {
        return;
      }
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "codex_request_failed",
        inputs.triggerCommentId,
        0,
        `Failed to post @codex review after a no-op claude-code-action run: ${message}`,
        config.githubToken,
      );
    }
    return;
  }

  // TY-271: deprecation warnings for the three superseded scope variables.
  // Old values still flow through `buildScopePolicy` (folded into the new
  // block spec) so existing repos keep working until the next minor.
  if (config.scopeAllowedPathPrefixes.length > 0) {
    deps.warning(
      "[scope-check] AUTO_REVIEW_SCOPE_ALLOWED_PATH_PREFIXES / scope-allowed-path-prefixes is deprecated (TY-271). The allow-list concept has been removed; the value is ignored. The scope check now blocks only paths matching AUTO_REVIEW_BLOCK_PATHS (or the built-in defaults). Remove this variable.",
    );
  }
  if (config.scopeAdditionalHardBlockPrefixes.length > 0) {
    deps.warning(
      `[scope-check] AUTO_REVIEW_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES / scope-additional-hard-block-prefixes is deprecated (TY-271). Migrate to AUTO_REVIEW_BLOCK_PATHS, e.g. AUTO_REVIEW_BLOCK_PATHS="${config.scopeAdditionalHardBlockPrefixes.join(",")}".`,
    );
  }
  if (config.hardBlockOverride.length > 0) {
    deps.warning(
      `[scope-check] AUTO_REVIEW_HARD_BLOCK_OVERRIDE / auto-review-hard-block-override is deprecated (TY-271). Migrate to AUTO_REVIEW_BLOCK_PATHS with the ! prefix, e.g. AUTO_REVIEW_BLOCK_PATHS="${config.hardBlockOverride.map((p) => `!${p}`).join(",")}".`,
    );
  }

  const blockSpec = parseBlockPathsSpec(config.autoReviewBlockPaths);
  for (const ignored of blockSpec.ignoredRemovals) {
    deps.warning(
      `[scope-check] AUTO_REVIEW_BLOCK_PATHS removal "!${ignored}" was ignored: .github/ is locked and cannot be unblocked.`,
    );
  }

  const scopePolicy = buildScopePolicy({
    blockPathsSpec: config.autoReviewBlockPaths,
    maxFiles: config.scopeMaxFiles > 0 ? config.scopeMaxFiles : undefined,
    maxLines: config.scopeMaxLines > 0 ? config.scopeMaxLines : undefined,
    additionalHardBlockPrefixes: config.scopeAdditionalHardBlockPrefixes,
    hardBlockOverride: config.hardBlockOverride,
  });

  if (config.autoReviewBlockPaths !== "") {
    deps.info(
      `[scope-check] AUTO_REVIEW_BLOCK_PATHS: "${config.autoReviewBlockPaths}"`,
    );
  }

  let scopeResult: ScopeCheckResult = checkScope(changedFiles, scopePolicy);
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
      detail: formatScopeViolationDetail(scopeResult, scopePolicy.maxFiles, scopePolicy.maxLines),
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
  // `modifiedFiles` may be replaced after BUILD_COMMAND when build artifacts
  // expand the staging set (TY-281), so it is `let` rather than `const`.
  let modifiedFiles = changedFiles.map((f) => f.path);
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

  // ─── BUILD_COMMAND (TY-281) ──────────────────────────────────────────────
  // For repos that commit build artifacts (e.g. this repo's `dist/`), run
  // a configurable build step so the auto-fix commit cannot drift out of
  // sync with `src/`. Empty `buildCommand` skips this block, preserving
  // prior behavior for repos without committed build outputs.
  if (config.buildCommand !== "") {
    // Re-enumerate the working tree after CHECK_COMMAND before running BUILD_COMMAND.
    // Files written or modified by CHECK_COMMAND (e.g. via --fix or autoformat) are
    // part of the repair and must be classified as pre-build edits, not as build
    // artifacts, so they receive strict scope validation rather than the relaxed
    // checkScopeBuildMode rules that only enforce locked paths.
    let postCheckNumstat: string;
    let postCheckUntrackedRaw: string;
    try {
      postCheckNumstat = deps.gitDiffNumstat();
      postCheckUntrackedRaw = deps.gitListUntracked();
    } catch (error) {
      deps.error(
        `[post-fix] Failed to re-enumerate working tree after CHECK_COMMAND: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        deps.resetWorkingTree();
      } catch {
        // best-effort; outer failureExit still records the failure
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: "Could not enumerate working-tree changes after CHECK_COMMAND.",
      });
      return;
    }
    const postCheckTracked: ChangedFile[] = parseGitNumstat(postCheckNumstat);
    const postCheckUntracked: ChangedFile[] = postCheckUntrackedRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((path) => {
        const content = deps.readWorkingTreeFile(path);
        if (content === null) {
          return { path, added: -1, deleted: -1 };
        }
        const added = content.length === 0 ? 0 : content.split("\n").length;
        return { path, added, deleted: 0 };
      });
    const postCheckChangedFiles: ChangedFile[] = [...postCheckTracked, ...postCheckUntracked];

    deps.info(`[post-fix] Running BUILD_COMMAND: ${config.buildCommand}`);
    const buildResult = await deps.runBuildCommand(config.buildCommand);
    if (!buildResult.success) {
      deps.error(
        "[post-fix] BUILD_COMMAND failed. Reverting working tree (incl. untracked).",
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      const truncated = buildResult.output.length > 1500
        ? buildResult.output.slice(0, 1500) + "\n... (truncated) ..."
        : buildResult.output;
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND failed: ${config.buildCommand}`,
          "",
          "Output:",
          truncated,
          "",
          "Adjust the BUILD_COMMAND Repository variable or fix the underlying build error and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Re-enumerate working tree changes after BUILD_COMMAND. Build artifacts
    // (e.g. dist/*.cjs) typically appear in `git diff --numstat HEAD` as
    // tracked-edits, but a brand-new artifact path would show up as untracked.
    let postBuildNumstat: string;
    let postBuildUntrackedRaw: string;
    try {
      postBuildNumstat = deps.gitDiffNumstat();
      postBuildUntrackedRaw = deps.gitListUntracked();
    } catch (error) {
      deps.error(
        `[post-fix] Failed to re-enumerate working tree after BUILD_COMMAND: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        deps.resetWorkingTree();
      } catch {
        // best-effort; outer failureExit still records the failure
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: "Could not enumerate working-tree changes after BUILD_COMMAND.",
      });
      return;
    }
    const postBuildTracked: ChangedFile[] = parseGitNumstat(postBuildNumstat);
    const postBuildUntracked: ChangedFile[] = postBuildUntrackedRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((path) => {
        const content = deps.readWorkingTreeFile(path);
        if (content === null) {
          return { path, added: -1, deleted: -1 };
        }
        const added = content.length === 0 ? 0 : content.split("\n").length;
        return { path, added, deleted: 0 };
      });
    const postBuildChangedFiles: ChangedFile[] = [
      ...postBuildTracked,
      ...postBuildUntracked,
    ];

    // BUILD_COMMAND succeeded but left the working tree identical to HEAD.
    // claude-code-action's edits were accepted by CHECK_COMMAND but erased by
    // the build step, which means BUILD_COMMAND is destructively overwriting
    // fixes rather than layering build artifacts on top of them. Re-queuing
    // Codex review with rolled-back accounting would allow the loop to spin
    // indefinitely because loop-detection and max-iteration safeguards never
    // advance. Stop with action_failure so the operator is notified.
    if (postBuildChangedFiles.length === 0) {
      deps.warning(
        "[post-fix] BUILD_COMMAND erased all working-tree changes after claude's edits passed CHECK_COMMAND. Stopping.",
      );
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND erased all working-tree changes: ${config.buildCommand}`,
          "",
          "claude-code-action's edits passed CHECK_COMMAND but the subsequent BUILD_COMMAND left",
          "the working tree identical to HEAD. If BUILD_COMMAND normalizes or overwrites the edits,",
          "the loop cannot make progress. Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Re-apply scope checks on the post-build working tree. Files that were
    // already in postCheckChangedFiles (claude's edits plus any files written
    // or modified by CHECK_COMMAND) receive the full strict checkScope so that
    // file/line budgets, binary rejection, and unlocked block patterns still
    // apply to non-artifact changes. Only net-new files produced by
    // BUILD_COMMAND (the "build delta") use the relaxed checkScopeBuildMode,
    // which skips size budgets and default-blocked paths such as dist/.
    // Locked paths (`.github/`) and path traversal are still rejected by
    // both checks — those are security boundaries the build step must not breach.
    const changedFilePathSet = new Set(postCheckChangedFiles.map((f) => f.path));
    const postBuildPathSet = new Set(postBuildChangedFiles.map((f) => f.path));
    const preBuildFiles = postBuildChangedFiles.filter((f) => changedFilePathSet.has(f.path));
    const buildDeltaFiles = postBuildChangedFiles.filter((f) => !changedFilePathSet.has(f.path));

    // Guard: BUILD_COMMAND reverted all pre-build repairs but produced some
    // artifact. Without this check, preBuildFiles would be empty, checkScope([])
    // would succeed, and the commit would contain only artifacts with none of the
    // actual repair edits — causing repeated identical Codex findings and wasted
    // iterations.
    if (preBuildFiles.length === 0) {
      deps.warning(
        "[post-fix] BUILD_COMMAND reverted all repaired paths. No pre-build file differs from HEAD after BUILD_COMMAND.",
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND reverted all repairs: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND reverted all repair edits: ${config.buildCommand}`,
          "",
          "The build step produced artifacts but overwrote every file that claude-code-action",
          "and CHECK_COMMAND had changed. The resulting commit would not contain the actual repair,",
          "causing repeated identical Codex findings and wasted iterations.",
          "Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Guard: BUILD_COMMAND reverted a subset of pre-build repairs. preBuildFiles
    // is non-empty (the all-reverted guard above did not fire) but some paths from
    // postCheckChangedFiles are absent from postBuildChangedFiles — the build step
    // restored those files to HEAD. Committing only the surviving paths would
    // produce an incomplete repair that re-triggers the same Codex findings.
    //
    // Only paths that were already in the pre-CHECK snapshot (changedFiles) are
    // considered repair paths. Files that first appeared after CHECK_COMMAND
    // (e.g. temporary scratch files or reports created as a CHECK_COMMAND
    // side-effect) are excluded: BUILD_COMMAND cleaning those up is not a revert
    // of the actual repair.
    const preCheckPathSet = new Set(changedFiles.map((f) => f.path));
    const revertedPaths = postCheckChangedFiles
      .map((f) => f.path)
      .filter((p) => preCheckPathSet.has(p) && !postBuildPathSet.has(p));
    if (revertedPaths.length > 0) {
      deps.warning(
        `[post-fix] BUILD_COMMAND reverted ${revertedPaths.length} repaired path(s): ${revertedPaths.join(", ")}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND partially reverted repairs: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND reverted some repair edits: ${config.buildCommand}`,
          "",
          "The following repaired paths were restored to their HEAD state by the build step:",
          revertedPaths.map((p) => `  - ${p}`).join("\n"),
          "",
          "A commit built from the remaining changes would be an incomplete repair, causing",
          "repeated Codex findings and wasted iterations.",
          "Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    const preBuildScopeResult: ScopeCheckResult = checkScope(preBuildFiles, scopePolicy);
    if (!preBuildScopeResult.ok) {
      deps.warning(
        `[post-fix] Scope violation (non-build files) after BUILD_COMMAND: ${preBuildScopeResult.message}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after post-build scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "scope_violation",
        detail: formatScopeViolationDetail(
          preBuildScopeResult,
          scopePolicy.maxFiles,
          scopePolicy.maxLines,
        ),
      });
      return;
    }

    const buildDeltaScopeResult: ScopeCheckResult = checkScopeBuildMode(
      buildDeltaFiles,
      scopePolicy,
    );
    if (!buildDeltaScopeResult.ok) {
      deps.warning(
        `[post-fix] Scope violation (build artifacts) after BUILD_COMMAND: ${buildDeltaScopeResult.message}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after post-build scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "scope_violation",
        detail: formatScopeViolationDetail(
          buildDeltaScopeResult,
          scopePolicy.maxFiles,
          scopePolicy.maxLines,
        ),
      });
      return;
    }

    scopeResult = {
      ok: true,
      changedFiles: postBuildChangedFiles.length,
      totalLines: preBuildScopeResult.totalLines + buildDeltaScopeResult.totalLines,
    };
    modifiedFiles = postBuildChangedFiles.map((f) => f.path);
    deps.info(
      `[post-fix] BUILD_COMMAND succeeded: ${postBuildChangedFiles.length} file(s), ${scopeResult.totalLines} line(s) staged.`,
    );
  }

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
    // TY-273 #B4: see no-op path and failureExit.
    fixingStartedAt: null,
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
    // TY-273 #B5: when @codex review re-request fails, leaving status at
    // `waiting_codex` with the stale `lastCodexRequestCommentId` deadlocks
    // the loop (no new Codex review will arrive, no trigger fires). Downgrade
    // to `stopped/codex_request_failed` so `postTerminalNotification` surfaces
    // a top-level comment and operators can `/restart-review` once Codex is
    // reachable again. The committed repair is preserved on the branch — we
    // only roll back the *pending* re-review request.
    const message = error instanceof Error ? error.message : String(error);
    deps.error(
      `[post-fix] Failed to post Codex review request: ${message}. Downgrading to stopped/codex_request_failed.`,
    );
    const stoppedState: ReviewState = {
      ...waitingState,
      status: "stopped",
      stopReason: "codex_request_failed",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "Could not record codex_request_failed stop.",
      ))
    ) {
      return;
    }
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "codex_request_failed",
      inputs.triggerCommentId,
      0,
      `Failed to post @codex review after the repair commit: ${message}`,
      config.githubToken,
    );
  }
}

async function run(): Promise<void> {
  await runPostFix(loadInitConfig());
}

runIfNotVitest(run, () => demoteFixingOnCrash("post-fix"));
