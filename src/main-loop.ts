import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import * as core from "@actions/core";
import { loadConfig, loadInitConfig } from "./config.js";
import { createInitialState, readState, updateStateComment } from "./state-manager.js";
import {
  fetchReviewComments,
  filterAndParseComments,
  stabilizeReviewComments,
} from "./review-collector.js";
import { computeFindingsHash } from "./findings-hash.js";
import { isLoop } from "./loop-detector.js";
import { fixFile, retryFailedEdits } from "./claude-fix-engine.js";
import { applyEdits } from "./edit-applier.js";
import { runCheckCommand } from "./check-runner.js";
import {
  postFixSummary,
  postCompletionComment,
  postStopComment,
  postTestFailureComment,
  postInitIncompleteComment,
  postCodexReviewRequest,
} from "./comment-poster.js";
import type { Finding, EditOperation, PrContext, ReviewState } from "./types.js";

/** Pause execution for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group findings by file path.
 * Returns a Map keyed by file path.
 */
function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.path);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(finding.path, [finding]);
    }
  }
  return groups;
}

/**
 * Select files up to maxFiles for processing.
 * Prioritization: files with P0 findings first, then P1-only files sorted by descending finding count.
 */
function selectFiles(
  fileGroups: Map<string, Finding[]>,
  maxFiles: number
): [string, Finding[]][] {
  const entries = Array.from(fileGroups.entries());

  // Separate P0 files from P1-only files
  const p0Files = entries.filter(([, findings]) =>
    findings.some((f) => f.severity === "P0")
  );
  const otherFiles = entries.filter(([, findings]) =>
    findings.every((f) => f.severity !== "P0")
  );

  // Sort each group by descending finding count
  const sortByCount = (a: [string, Finding[]], b: [string, Finding[]]) =>
    b[1].length - a[1].length;

  p0Files.sort(sortByCount);
  otherFiles.sort(sortByCount);

  const ordered = [...p0Files, ...otherFiles];
  return ordered.slice(0, maxFiles);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Mask sensitive values to prevent accidental log exposure
  core.setSecret(config.anthropicApiKey);
  core.setSecret(config.githubToken);

  const triggerCommentId = config.triggerCommentId;
  const prHeadRef = config.prHeadRef;
  if (!prHeadRef) {
    throw new Error("[main-loop] pr-head-ref is required but not set. Cannot determine target branch.");
  }

  core.info(
    `[main-loop] Starting Workflow B for PR #${config.prNumber}, trigger comment: ${triggerCommentId}`
  );

  // ─── Phase 1: State + Guard ──────────────────────────────────────────────

  const stateResult = await readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );

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
      await updateStateComment(
        config.repoOwner,
        config.repoName,
        stateResult.commentId,
        corruptedState,
        config.githubToken
      );
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
  const { state, commentId } = stateResult;

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
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      recoveredState,
      config.githubToken
    );
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

  core.info(`[main-loop] Found ${findings.length} P0/P1 findings.`);

  // ─── Phase 2: Judge ───────────────────────────────────────────────────────

  // Note: iterationCount is NOT incremented here.
  // It is incremented only after a successful Claude fix (Phase 3).
  // Spec: "If the initial review has 0 P0/P1, iterationCount is 0."
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
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      doneState,
      config.githubToken
    );
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
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      stoppedState,
      config.githubToken
    );
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
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      stoppedState,
      config.githubToken
    );
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
  await updateStateComment(
    config.repoOwner,
    config.repoName,
    commentId,
    fixingState,
    config.githubToken
  );

  // Checkout PR branch using execFileSync to avoid shell injection
  if (prHeadRef) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(prHeadRef) || prHeadRef.includes("..")) {
      throw new Error(`[main-loop] Invalid branch name: ${prHeadRef}`);
    }
    core.info(`[main-loop] Checking out branch: ${prHeadRef}`);
    execFileSync("git", ["checkout", prHeadRef], { stdio: "inherit" });
  }

  // Group findings and select files to process
  const fileGroups = groupByFile(findings);
  const selectedFiles = selectFiles(fileGroups, config.maxFilesPerIteration);

  core.info(
    `[main-loop] Processing ${selectedFiles.length} file(s) out of ${fileGroups.size} total.`
  );

  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });

  const prContext: PrContext = {
    number: config.prNumber,
    title: config.prTitle,
    branch: prHeadRef,
  };

  const allAppliedEdits: EditOperation[] = [];
  const skippedFiles: string[] = [];

  // Track modified files for rollback if check fails
  const modifiedFiles: string[] = [];

  const repoRoot = resolve(".");

  for (const [filePath, fileFindings] of selectedFiles) {
    // Path traversal guard: reject paths outside repository root
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(repoRoot + sep) && resolvedPath !== repoRoot) {
      core.warning(`[main-loop] Path traversal detected: ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, "utf-8");
    } catch {
      core.warning(`[main-loop] Cannot read file: ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    try {  // Wrap Claude API + edit logic to catch unrecoverable errors

    // Token estimation guard: skip files that are too large
    const estimatedTokens = Math.ceil(fileContent.length / 4);
    if (estimatedTokens > config.maxInputTokensPerFile) {
      // TODO(phase:PoC, reason:chunking large files not implemented — files exceeding
      // maxInputTokensPerFile are skipped entirely instead of being processed in chunks,
      // due:MVP): implement chunked processing for large files
      core.warning(
        `[main-loop] File ${filePath} estimated ${estimatedTokens} tokens > max ${config.maxInputTokensPerFile}. Skipping.`
      );
      skippedFiles.push(filePath);
      continue;
    }

    core.info(`[main-loop] Fixing ${filePath} (${fileFindings.length} findings)...`);

    const fixResult = await fixFile(
      anthropicClient,
      prContext,
      filePath,
      fileContent,
      fileFindings,
      fixingState.iterationCount,
      config.maxReviewIterations
    );

    if (fixResult.skippedReason) {
      core.warning(
        `[main-loop] Claude skipped ${filePath}: ${fixResult.skippedReason}`
      );
      skippedFiles.push(filePath);
      continue;
    }

    if (fixResult.edits.length === 0) {
      core.warning(`[main-loop] No edits returned for ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Apply edits (lineHints intentionally omitted: edits array does not
    // correspond 1:1 to findings, so index-based hint lookup would be wrong)
    let applyResult = applyEdits(fileContent, fixResult.edits, filePath);

    let successfulEdits: EditOperation[] = [];
    let failedEdits: EditOperation[] = [];

    if (!applyResult.success) {
      // Separate successful from failed edits
      successfulEdits = fixResult.edits.filter(
        (e) => !applyResult.failedEdits.includes(e)
      );
      failedEdits = applyResult.failedEdits;

      // Retry up to 2 times
      for (let retryAttempt = 0; retryAttempt < 2 && failedEdits.length > 0; retryAttempt++) {
        core.info(
          `[main-loop] Retrying ${failedEdits.length} failed edit(s) for ${filePath} (attempt ${retryAttempt + 1}/2)...`
        );

        // Build intermediate content by applying successful edits to original
        let intermediateContent = fileContent;
        if (successfulEdits.length > 0) {
          const intermediateResult = applyEdits(
            fileContent,
            successfulEdits,
            filePath
          );
          if (intermediateResult.success && intermediateResult.content !== null) {
            intermediateContent = intermediateResult.content;
          }
        }

        // Retry failed edits with the intermediate content
        const retryResult = await retryFailedEdits(
          anthropicClient,
          prContext,
          filePath,
          intermediateContent,
          failedEdits,
          fixingState.iterationCount,
          config.maxReviewIterations
        );

        if (retryResult.skippedReason || retryResult.edits.length === 0) {
          core.warning(
            `[main-loop] Retry produced no edits for ${filePath}. Keeping successful edits.`
          );
          break;
        }

        // Merge: apply successful + retry edits to ORIGINAL content
        const mergedEdits = [...successfulEdits, ...retryResult.edits];
        const mergedResult = applyEdits(fileContent, mergedEdits, filePath);

        if (mergedResult.success) {
          // All edits applied — update successful set and clear failed
          successfulEdits = mergedEdits;
          failedEdits = [];
          applyResult = mergedResult;
        } else {
          // Update sets: edits that are no longer in failed are now successful
          const stillFailed = mergedResult.failedEdits;
          const nowSuccessful = mergedEdits.filter((e) => !stillFailed.includes(e));
          successfulEdits = nowSuccessful;
          failedEdits = stillFailed;
          // Keep applyResult as partial failure; next retry will attempt remaining failed edits
        }
      }

      // After retries, apply only the successful edits to the original file content
      if (successfulEdits.length > 0) {
        const finalResult = applyEdits(fileContent, successfulEdits, filePath);
        if (finalResult.success && finalResult.content !== null) {
          applyResult = finalResult;
        } else {
          core.warning(`[main-loop] All edits failed for ${filePath}. Skipping file.`);
          skippedFiles.push(filePath);
          continue;
        }
      } else {
        core.warning(`[main-loop] All edits failed for ${filePath} after retries. Skipping file.`);
        skippedFiles.push(filePath);
        continue;
      }
    } else {
      successfulEdits = fixResult.edits;
    }

    if (!applyResult.success || applyResult.content === null) {
      core.warning(`[main-loop] Could not apply edits for ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Write successful edits to disk
    writeFileSync(filePath, applyResult.content, "utf-8");
    allAppliedEdits.push(...successfulEdits);
    modifiedFiles.push(filePath);

    core.info(
      `[main-loop] Applied ${successfulEdits.length} edit(s) to ${filePath}.`
    );

    } catch (fileError: unknown) {
      // Catch unrecoverable errors (e.g., 400 Bad Request from Claude API)
      // to prevent leaving state stuck in "fixing"
      core.error(`[main-loop] Error processing ${filePath}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
      skippedFiles.push(filePath);
      continue;
    }
  }

  // If no edits were applied across all files → stop with claude_api_error
  if (allAppliedEdits.length === 0) {
    core.error("[main-loop] No edits applied. Stopping with claude_api_error.");
    const stoppedState: ReviewState = {
      ...fixingState,
      status: "stopped",
      stopReason: "claude_api_error",
    };
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      stoppedState,
      config.githubToken
    );
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "claude_api_error",
      triggerCommentId,
      findings.length,
      "Claude returned no applicable edits for any selected file",
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
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      stoppedState,
      config.githubToken
    );
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
        `fix: auto-resolve P0/P1 findings from Codex review (iteration ${fixingState.iterationCount})\n\n${commitBody}`,
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
    skippedFiles,
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
  await updateStateComment(
    config.repoOwner,
    config.repoName,
    commentId,
    waitingState,
    config.githubToken
  );

  core.info("[main-loop] Posting @codex review request...");
  try {
    const reviewRequestId = await postCodexReviewRequest(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken
    );

    // Update state with the review request comment ID
    const updatedWaitingState: ReviewState = {
      ...waitingState,
      lastCodexRequestCommentId: reviewRequestId,
    };
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      updatedWaitingState,
      config.githubToken
    );

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
        crashConfig.githubToken
      );
    }
  } catch (recoveryError) {
    core.error(
      `[main-loop] Crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
    );
  }
});
