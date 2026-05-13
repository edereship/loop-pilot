import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import * as core from "@actions/core";
import { loadConfig, loadInitConfig, DEFAULT_AUTO_REVIEW_LABEL } from "./config.js";
import {
  createInitialState,
  readState,
  StateUpdateConflictError,
  updateStateComment,
} from "./state-manager.js";
import {
  fetchReviewComments,
  filterAndParseComments,
  stabilizeReviewComments,
} from "./review-collector.js";
import { computeFindingsHash } from "./findings-hash.js";
import { isLoop } from "./loop-detector.js";
import { runCheckCommand } from "./check-runner.js";
import { buildNoApplicableEditsDetail } from "./stop-detail.js";
import { planFindingsForIteration } from "./finding-planner.js";
import { processFindingsSequentially } from "./sequential-fix-runner.js";
import {
  postFixSummary,
  postCompletionComment,
  postStopComment,
  postTestFailureComment,
  postInitIncompleteComment,
  postCodexReviewRequest,
} from "./comment-poster.js";
import { fetchPrLabels, isAutoReviewAllowed } from "./pr-labels.js";
import {
  handleRestartCommand,
  isRestartCommandLike,
} from "./restart-command.js";
import type { EditOperation, PrContext, ReviewState } from "./types.js";

/** Pause execution for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Mask sensitive values to prevent accidental log exposure
  core.setSecret(config.anthropicApiKey);
  core.setSecret(config.githubToken);
  core.setSecret(config.codexReviewRequestToken);

  const triggerCommentId = config.triggerCommentId;
  const prHeadRef = config.prHeadRef;
  if (!prHeadRef) {
    throw new Error("[main-loop] pr-head-ref is required but not set. Cannot determine target branch.");
  }

  core.info(
    `[main-loop] Starting Workflow B for PR #${config.prNumber}, trigger comment: ${triggerCommentId}`
  );

  // ─── Phase 0: Label gate (default-strict, opt-out via AUTO_REVIEW_FULL_AUTO) ───
  // Re-check labels at run time even though the workflow `if` already filtered:
  // a maintainer may have removed the gate label after Codex posted its review.
  // When AUTO_REVIEW_FULL_AUTO=true the gate is disabled and we proceed unconditionally.
  // Recovery commands bypass this gate so operators can recover or restart a loop even
  // after the gate label has been removed; the fork guard in the workflow and
  // the per-user permission checks in command handlers still apply.
  const isCommandTrigger = isRestartCommandLike(config.triggerCommentBody);
  if (!config.autoReviewFullAuto && !isCommandTrigger) {
    const effectiveLabel = config.autoReviewLabel || DEFAULT_AUTO_REVIEW_LABEL;
    const labels = await fetchPrLabels(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken,
    );
    if (!isAutoReviewAllowed(effectiveLabel, labels)) {
      core.info(
        `[main-loop] Required label '${effectiveLabel}' is not present on PR #${config.prNumber}. Skipping (no state mutation, no fix).`,
      );
      return;
    }
  }

  // ─── Phase 1: State + Guard ──────────────────────────────────────────────

  const stateResult = await readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );
  let stateCommentUpdatedAt = stateResult.found || stateResult.corrupted
    ? stateResult.commentUpdatedAt
    : undefined;

  async function updateStateCommentLocked(
    targetCommentId: number,
    nextState: ReviewState,
    detail: string,
  ): Promise<boolean> {
    try {
      const result = await updateStateComment(
        config.repoOwner,
        config.repoName,
        targetCommentId,
        nextState,
        config.githubToken,
        stateCommentUpdatedAt
          ? { expectedUpdatedAt: stateCommentUpdatedAt }
          : undefined,
      );
      stateCommentUpdatedAt = result.updatedAt;
      return true;
    } catch (error) {
      if (!(error instanceof StateUpdateConflictError)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      core.warning(`[main-loop] Hidden comment state conflict. ${message}`);
      await postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "state_conflict",
        triggerCommentId,
        0,
        `${detail} Hidden comment was updated by another workflow run before this run could safely persist its state. Re-run after the active workflow finishes if needed.`,
        config.githubToken,
      );
      return false;
    }
  }

  if (isRestartCommandLike(config.triggerCommentBody)) {
    const restartResult = await handleRestartCommand({
      owner: config.repoOwner,
      repo: config.repoName,
      prNumber: config.prNumber,
      triggerCommentId,
      triggerCommentBody: config.triggerCommentBody,
      triggerUserLogin: config.triggerUserLogin,
      restartRoles: config.autoReviewRestartRoles,
      githubToken: config.githubToken,
      codexReviewRequestToken: config.codexReviewRequestToken,
      stateResult,
    });
    if (restartResult.handled) {
      return;
    }
  }

  // Guard: no hidden comment means Workflow A hasn't run yet — skip silently
  if (!stateResult.found && !stateResult.corrupted) {
    core.info("[main-loop] No state found. Workflow A has not run. Skipping.");
    return;
  }

  // Guard: hidden comment exists but JSON is corrupted
  if (!stateResult.found && stateResult.corrupted) {
    core.error("[main-loop] Hidden comment found but state JSON is corrupted.");
    if (stateResult.commentId !== null) {
      const corruptedState: ReviewState = {
        ...createInitialState(),
        status: "stopped",
        stopReason: "state_corrupted",
      };
      if (!(await updateStateCommentLocked(
        stateResult.commentId,
        corruptedState,
        "Could not mark corrupted hidden state as stopped.",
      ))) return;
    }
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "state_corrupted",
      triggerCommentId,
      0,
      "Hidden comment state JSON is corrupted. Manual re-initialization required.",
      config.githubToken
    );
    return;
  }

  // At this point both not-found cases have returned, so stateResult.found is true.
  if (!stateResult.found) {
    // Unreachable — guard for type narrowing
    return;
  }
  const { state } = stateResult;
  const { commentId } = stateResult;

  // Guard: status === "initialized" means Workflow A never posted the review request
  if (state.status === "initialized") {
    core.info("[main-loop] State is 'initialized' — Workflow A incomplete.");
    await postInitIncompleteComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken
    );
    return;
  }

  // Guard: already in a terminal state
  if (state.status === "stopped" || state.status === "done") {
    core.info(`[main-loop] Status is '${state.status}'. Skipping.`);
    return;
  }

  // Guard: fixing state — recover if stale (>30min), otherwise skip
  if (state.status === "fixing") {
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    const fixingStartedAt = state.lastCodexReviewReceivedAt;

    // Null timestamp means fixing state was entered abnormally — treat as stale immediately
    if (fixingStartedAt === null) {
      core.warning(
        "[main-loop] Status is 'fixing' with null timestamp. Treating as stale."
      );
    }

    const elapsed = Date.now() - new Date(fixingStartedAt ?? 0).getTime();

    if (fixingStartedAt !== null && elapsed < STALE_THRESHOLD_MS) {
      core.info(
        `[main-loop] Status is 'fixing' (started ${Math.round(elapsed / 1000)}s ago). Skipping.`
      );
      return;
    }

    core.warning(
      `[main-loop] Status stuck in 'fixing' for ${Math.round(elapsed / 60000)}min. Recovering.`
    );
    const recoveredState: ReviewState = {
      ...state,
      status: "stopped",
      stopReason: "state_corrupted",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      recoveredState,
      "Could not recover stale fixing state.",
    ))) return;
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "state_corrupted",
      triggerCommentId,
      0,
      "Previous fixing state timed out — recovered automatically",
      config.githubToken
    );
    return;
  }

  // Guard: unexpected state — only waiting_codex should proceed
  if (state.status !== "waiting_codex") {
    core.warning(
      `[main-loop] Unexpected status '${state.status}'. Only 'waiting_codex' is processable. Skipping.`
    );
    return;
  }

  // Idempotency: same trigger comment already processed
  if (
    triggerCommentId !== 0 &&
    state.lastProcessedReviewId === triggerCommentId
  ) {
    core.info(
      `[main-loop] Trigger comment ${triggerCommentId} already processed. Skipping.`
    );
    return;
  }

  // ─── Debounce ─────────────────────────────────────────────────────────────
  core.info(`[main-loop] Debouncing ${config.debounceSeconds}s...`);
  await sleep(config.debounceSeconds * 1000);

  // ─── Collect Findings ────────────────────────────────────────────────────
  core.info("[main-loop] Fetching review comments...");
  const fetchedComments = await fetchReviewComments(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );
  const rawComments = await stabilizeReviewComments(fetchedComments, {
    botLogin: config.codexBotLogin,
    lastReceivedAt: state.lastCodexReviewReceivedAt,
    triggerSummaryBody: config.triggerCommentBody,
    intervalMs: config.stabilizeIntervalSeconds * 1000,
    stablePolls: config.stabilizeCount,
    maxWaitMs: config.debounceSeconds * 1000,
    fetchComments: () =>
      fetchReviewComments(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        config.githubToken
      ),
    sleep,
    log: (message) => core.info(message),
  });

  const findings = filterAndParseComments(
    rawComments,
    config.codexBotLogin,
    state.lastCodexReviewReceivedAt
  );

  core.info(`[main-loop] Found ${findings.length} P0/P1/P2 findings.`);

  // ─── Phase 2: Judge ───────────────────────────────────────────────────────

  // Note: iterationCount is NOT incremented here.
  // It is incremented only after a successful Claude fix (Phase 3).
  // Spec: "If the initial review has 0 P0/P1/P2, iterationCount is 0."
  // Use the latest Codex comment timestamp rather than processing start time,
  // so the next iteration's time filter does not skip comments posted during processing
  const latestCommentTime = rawComments
    .filter((c) => c.user.login === config.codexBotLogin)
    .reduce((max, c) => (c.createdAt > max ? c.createdAt : max), state.lastCodexReviewReceivedAt ?? "");

  const updatedStateBase: ReviewState = {
    ...state,
    lastProcessedReviewId: triggerCommentId || state.lastProcessedReviewId,
    lastCodexReviewReceivedAt: latestCommentTime || new Date().toISOString(),
  };

  // 2a: No findings → done
  if (findings.length === 0) {
    core.info("[main-loop] No findings. Marking done.");
    const doneState: ReviewState = {
      ...updatedStateBase,
      status: "done",
      stopReason: "no_findings",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      doneState,
      "Could not mark auto-review as done.",
    ))) return;
    await postCompletionComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      doneState.iterationCount,
      config.githubToken
    );
    return;
  }

  // 2b: Max iterations reached → stopped
  if (state.iterationCount >= config.maxReviewIterations) {
    core.info(
      `[main-loop] Iteration count ${state.iterationCount} >= max ${config.maxReviewIterations}. Stopping.`
    );
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "max_iterations",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      stoppedState,
      "Could not stop after reaching the max iteration limit.",
    ))) return;
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "max_iterations",
      triggerCommentId,
      findings.length,
      `Reached MAX_REVIEW_ITERATIONS (${config.maxReviewIterations})`,
      config.githubToken
    );
    return;
  }

  // 2c: Loop detected → stopped
  if (isLoop(findings, state.findingsHashHistory)) {
    core.info("[main-loop] Loop detected. Stopping.");
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "loop_detected",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      stoppedState,
      "Could not stop after detecting a findings loop.",
    ))) return;
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "loop_detected",
      triggerCommentId,
      findings.length,
      "Same findings hash detected in previous iteration",
      config.githubToken
    );
    return;
  }

  // ─── Phase 3: Claude Fix ─────────────────────────────────────────────────

  // Record current hash in history before fixing
  const currentHash = computeFindingsHash(findings);
  const newIteration = state.iterationCount + 1;
  const updatedHashHistory = [
    ...state.findingsHashHistory,
    { iteration: newIteration, hash: currentHash },
  ];

  // Transition to "fixing" — iterationCount incremented here (after judge passed)
  const fixingState: ReviewState = {
    ...updatedStateBase,
    iterationCount: newIteration,
    status: "fixing",
    lastFindingsHash: currentHash,
    findingsHashHistory: updatedHashHistory,
  };
  if (!(await updateStateCommentLocked(
    commentId,
    fixingState,
    "Could not claim the hidden comment state for fixing.",
  ))) return;

  // Checkout PR branch using execFileSync to avoid shell injection
  if (prHeadRef) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(prHeadRef) || prHeadRef.includes("..")) {
      throw new Error(`[main-loop] Invalid branch name: ${prHeadRef}`);
    }
    core.info(`[main-loop] Checking out branch: ${prHeadRef}`);
    execFileSync("git", ["checkout", prHeadRef], { stdio: "inherit" });
  }

  const plannedFindings = planFindingsForIteration(
    findings,
    config.maxFilesPerIteration,
  );
  const selectedFileCount = new Set(
    plannedFindings.selectedFindings.map((finding) => finding.path),
  ).size;

  core.info(
    `[main-loop] Processing ${plannedFindings.selectedFindings.length} finding(s) in ${selectedFileCount} file(s).`
  );

  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });

  const prContext: PrContext = {
    number: config.prNumber,
    title: config.prTitle,
    branch: prHeadRef,
  };

  const allAppliedEdits: EditOperation[] = [];
  const skipReasons: { filePath: string; reason: string }[] = [];

  // Track modified files for rollback if check fails
  let modifiedFiles: string[] = [];

  const repoRoot = resolve(".");
  const skippedItems = plannedFindings.deferredFiles.map(
    (filePath) =>
      `${filePath}: deferred because MAX_FILES_PER_ITERATION=${config.maxFilesPerIteration} was reached`,
  );

  const sequentialResult = await processFindingsSequentially({
    client: anthropicClient,
    findings: plannedFindings.selectedFindings,
    prContext,
    iteration: fixingState.iterationCount,
    maxIterations: config.maxReviewIterations,
    maxInputTokensPerFile: config.maxInputTokensPerFile,
    readFile: (filePath) => {
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(repoRoot + sep) && resolvedPath !== repoRoot) {
        throw new Error(`Path traversal detected: ${filePath}`);
      }
      return readFileSync(filePath, "utf-8");
    },
    writeFile: (filePath, content) => {
      writeFileSync(filePath, content, "utf-8");
    },
    log: (message) => core.info(message),
    warn: (message) => core.warning(message),
  });

  allAppliedEdits.push(...sequentialResult.appliedEdits);
  modifiedFiles = sequentialResult.modifiedFiles;
  for (const skipped of sequentialResult.skippedFindings) {
    const label = `${skipped.finding.severity} ${skipped.finding.path}:${skipped.finding.line} ${skipped.finding.title}`;
    skippedItems.push(`${label}: ${skipped.reason}`);
    skipReasons.push({
      filePath: skipped.finding.path,
      reason: `${skipped.finding.title}: ${skipped.reason}`,
    });
  }

  // If no edits were applied across all files → stop with claude_api_error
  if (allAppliedEdits.length === 0) {
    core.error("[main-loop] No edits applied. Stopping with claude_api_error.");
    // No file changed, so do not consume an iteration or persist the findings hash.
    // Otherwise a manual retry of the same Codex finding would be stopped by loop detection.
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "claude_api_error",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      stoppedState,
      "Could not stop after Claude produced no applicable edits.",
    ))) return;
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "claude_api_error",
      triggerCommentId,
      findings.length,
      buildNoApplicableEditsDetail(skipReasons),
      config.githubToken
    );
    return;
  }

  // Run check command
  core.info(`[main-loop] Running check command: ${config.checkCommand}`);
  const checkResult = await runCheckCommand(
    config.checkCommand,
    modifiedFiles
  );

  if (!checkResult.success) {
    core.error("[main-loop] Check command failed. Rolling back and stopping.");
    // Use updatedStateBase (pre-increment) so that:
    // 1. iterationCount is not consumed by a failed attempt
    // 2. findingsHashHistory does not contain the failed iteration's hash,
    //    preventing false loop detection on retry
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "test_failure",
    };
    if (!(await updateStateCommentLocked(
      commentId,
      stoppedState,
      "Could not stop after CHECK_COMMAND failed.",
    ))) return;
    await postTestFailureComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      checkResult.output,
      config.githubToken
    );
    return;
  }

  core.info("[main-loop] Check command passed. Committing changes...");

  // git add individual files using execFileSync to avoid shell injection
  execFileSync("git", ["add", ...modifiedFiles], { stdio: "inherit" });

  // Guard: skip commit if all edits resulted in no actual file changes
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { stdio: "inherit" });
    // Exit code 0 means no staged changes — nothing to commit
    core.warning("[main-loop] No staged changes after edits. Skipping commit.");
  } catch {
    // Exit code 1 means there are staged changes — proceed with commit

    // Sanitize explanations: strip newlines to prevent Git trailer injection
    const sanitize = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
    const commitBody = allAppliedEdits.map((e) => `- ${sanitize(e.explanation)}`).join("\n");
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        `fix: auto-resolve P0/P1/P2 findings from Codex review (iteration ${fixingState.iterationCount})\n\n${commitBody}`,
      ],
      { stdio: "inherit" }
    );
    execFileSync("git", ["push"], { stdio: "inherit" });
  }

  // Capture commit SHA for state
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  core.info(`[main-loop] Committed: ${commitSha}`);

  // Post fix summary
  await postFixSummary(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    fixingState.iterationCount,
    allAppliedEdits,
    skippedItems,
    config.githubToken
  );

  // ─── Phase 4: Re-review ───────────────────────────────────────────────────
  // Transition state before posting the review request so that a failure
  // in postCodexReviewRequest does not leave state stuck in "fixing".
  // If the review request fails, the commit is already pushed, and the next
  // workflow trigger (or manual retry) can still proceed.

  const waitingState: ReviewState = {
    ...fixingState,
    status: "waiting_codex",
    lastClaudeCommitSha: commitSha,
  };
  if (!(await updateStateCommentLocked(
    commentId,
    waitingState,
    "Could not return hidden comment state to waiting_codex after committing fixes.",
  ))) return;

  core.info("[main-loop] Posting @codex review request...");
  try {
    const reviewRequestId = await postCodexReviewRequest(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.codexReviewRequestToken
    );

    // Update state with the review request comment ID
    const updatedWaitingState: ReviewState = {
      ...waitingState,
      lastCodexRequestCommentId: reviewRequestId,
    };
    if (!(await updateStateCommentLocked(
      commentId,
      updatedWaitingState,
      "Could not persist the Codex review request comment ID.",
    ))) return;

    core.info(
      `[main-loop] Phase 4 complete. Status: waiting_codex. Review request: ${reviewRequestId}`
    );
  } catch (phase4Error: unknown) {
    core.error(
      `[main-loop] Failed to post Codex review request: ${phase4Error instanceof Error ? phase4Error.message : String(phase4Error)}. ` +
      `State is waiting_codex. Manual '@codex review' comment may be needed.`
    );
  }
}

main().catch(async (error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));

  // Attempt to recover from fixing state on unhandled crash
  try {
    // Use loadInitConfig to avoid requiring ANTHROPIC_API_KEY for recovery
    const crashConfig = loadInitConfig();
    const crashStateResult = await readState(
      crashConfig.repoOwner,
      crashConfig.repoName,
      crashConfig.prNumber,
      crashConfig.githubToken
    );
    if (crashStateResult.found && crashStateResult.state.status === "fixing") {
      core.warning(
        "[main-loop] Crash recovery: resetting fixing → stopped (state_corrupted)"
      );
      const recoveredState: ReviewState = {
        ...crashStateResult.state,
        status: "stopped",
        stopReason: "state_corrupted",
      };
      await updateStateComment(
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
      `[main-loop] Crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
    );
  }
});
