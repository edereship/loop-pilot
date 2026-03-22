import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { readState, updateStateComment } from "./state-manager.js";
import {
  fetchReviewComments,
  filterAndParseComments,
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
  const triggerCommentId = parseInt(process.env.TRIGGER_COMMENT_ID ?? "0", 10);
  const prHeadRef = process.env.PR_HEAD_REF ?? "";

  console.log(
    `[main-loop] Starting Workflow B for PR #${config.prNumber}, trigger comment: ${triggerCommentId}`
  );

  // ─── Phase 1: State + Guard ──────────────────────────────────────────────

  const stateResult = await readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );

  // Guard: no state means Workflow A hasn't run yet — skip silently
  if (!stateResult) {
    console.log("[main-loop] No state found. Workflow A has not run. Skipping.");
    return;
  }

  const { state, commentId } = stateResult;

  // Guard: status === "initialized" means Workflow A never posted the review request
  if (state.status === "initialized") {
    console.log("[main-loop] State is 'initialized' — Workflow A incomplete.");
    await postInitIncompleteComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken
    );
    return;
  }

  // Guard: already in a terminal or active state that should not be re-entered
  if (
    state.status === "fixing" ||
    state.status === "stopped" ||
    state.status === "done"
  ) {
    console.log(`[main-loop] Status is '${state.status}'. Skipping.`);
    return;
  }

  // Idempotency: same trigger comment already processed
  if (
    triggerCommentId !== 0 &&
    state.lastProcessedReviewId === triggerCommentId
  ) {
    console.log(
      `[main-loop] Trigger comment ${triggerCommentId} already processed. Skipping.`
    );
    return;
  }

  // ─── Debounce ─────────────────────────────────────────────────────────────
  console.log(`[main-loop] Debouncing ${config.debounceSeconds}s...`);
  await sleep(config.debounceSeconds * 1000);

  // TODO(phase:PoC, reason:stabilize safeguard not implemented — would poll review comments
  // until the count stabilizes over STABILIZE_COUNT polling intervals of STABILIZE_INTERVAL_SECONDS,
  // ensuring Codex has finished posting all inline comments before we process them,
  // due:MVP): implement comment stabilization check

  // ─── Collect Findings ────────────────────────────────────────────────────
  console.log("[main-loop] Fetching review comments...");
  const rawComments = await fetchReviewComments(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );

  const findings = filterAndParseComments(
    rawComments,
    config.codexBotLogin,
    state.lastCodexReviewReceivedAt
  );

  console.log(`[main-loop] Found ${findings.length} P0/P1 findings.`);

  // ─── Phase 2: Judge ───────────────────────────────────────────────────────

  const updatedStateBase: ReviewState = {
    ...state,
    lastProcessedReviewId: triggerCommentId || state.lastProcessedReviewId,
    iterationCount: state.iterationCount + 1,
    lastCodexReviewReceivedAt: new Date().toISOString(),
  };

  // 2a: No findings → done
  if (findings.length === 0) {
    console.log("[main-loop] No findings. Marking done.");
    const doneState: ReviewState = {
      ...updatedStateBase,
      status: "done",
      stopReason: null,
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
    console.log(
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
    console.log("[main-loop] Loop detected. Stopping.");
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
  const updatedHashHistory = [
    ...state.findingsHashHistory,
    { iteration: updatedStateBase.iterationCount, hash: currentHash },
  ];

  // Transition to "fixing"
  const fixingState: ReviewState = {
    ...updatedStateBase,
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
    console.log(`[main-loop] Checking out branch: ${prHeadRef}`);
    execFileSync("git", ["checkout", prHeadRef], { stdio: "inherit" });
  }

  // Group findings and select files to process
  const fileGroups = groupByFile(findings);
  const selectedFiles = selectFiles(fileGroups, config.maxFilesPerIteration);

  console.log(
    `[main-loop] Processing ${selectedFiles.length} file(s) out of ${fileGroups.size} total.`
  );

  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });

  const prContext: PrContext = {
    number: config.prNumber,
    title: process.env.PR_TITLE ?? "",
    branch: prHeadRef,
  };

  const allAppliedEdits: EditOperation[] = [];
  const skippedFiles: string[] = [];

  // Track files for rollback if check fails
  const modifiedFiles: string[] = [];
  const createdFiles: string[] = [];

  for (const [filePath, fileFindings] of selectedFiles) {
    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, "utf-8");
    } catch {
      console.warn(`[main-loop] Cannot read file: ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Token estimation guard: skip files that are too large
    const estimatedTokens = Math.ceil(fileContent.length / 4);
    if (estimatedTokens > config.maxInputTokensPerFile) {
      // TODO(phase:PoC, reason:chunking large files not implemented — files exceeding
      // maxInputTokensPerFile are skipped entirely instead of being processed in chunks,
      // due:MVP): implement chunked processing for large files
      console.warn(
        `[main-loop] File ${filePath} estimated ${estimatedTokens} tokens > max ${config.maxInputTokensPerFile}. Skipping.`
      );
      skippedFiles.push(filePath);
      continue;
    }

    console.log(`[main-loop] Fixing ${filePath} (${fileFindings.length} findings)...`);

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
      console.warn(
        `[main-loop] Claude skipped ${filePath}: ${fixResult.skippedReason}`
      );
      skippedFiles.push(filePath);
      continue;
    }

    if (fixResult.edits.length === 0) {
      console.warn(`[main-loop] No edits returned for ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Apply edits with retry logic
    const lineHints = fileFindings.map((f) => f.line);
    let applyResult = applyEdits(fileContent, fixResult.edits, filePath, lineHints);

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
        console.log(
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
          console.warn(
            `[main-loop] Retry produced no edits for ${filePath}. Keeping successful edits.`
          );
          break;
        }

        // Merge: apply successful + retry edits to ORIGINAL content
        const mergedEdits = [...successfulEdits, ...retryResult.edits];
        const mergedResult = applyEdits(fileContent, mergedEdits, filePath, lineHints);

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
          console.warn(`[main-loop] All edits failed for ${filePath}. Skipping file.`);
          skippedFiles.push(filePath);
          continue;
        }
      } else {
        console.warn(`[main-loop] All edits failed for ${filePath} after retries. Skipping file.`);
        skippedFiles.push(filePath);
        continue;
      }
    } else {
      successfulEdits = fixResult.edits;
    }

    if (!applyResult.success || applyResult.content === null) {
      console.warn(`[main-loop] Could not apply edits for ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Write successful edits to disk
    writeFileSync(filePath, applyResult.content, "utf-8");
    allAppliedEdits.push(...successfulEdits);
    modifiedFiles.push(filePath);

    console.log(
      `[main-loop] Applied ${successfulEdits.length} edit(s) to ${filePath}.`
    );
  }

  // If no edits were applied across all files → stop with claude_api_error
  if (allAppliedEdits.length === 0) {
    console.error("[main-loop] No edits applied. Stopping with claude_api_error.");
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
  console.log(`[main-loop] Running check command: ${config.checkCommand}`);
  const checkResult = await runCheckCommand(
    config.checkCommand,
    modifiedFiles,
    createdFiles
  );

  if (!checkResult.success) {
    console.error("[main-loop] Check command failed. Rolling back and stopping.");
    const stoppedState: ReviewState = {
      ...fixingState,
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

  console.log("[main-loop] Check command passed. Committing changes...");

  // git add individual files using execFileSync to avoid shell injection
  execFileSync("git", ["add", ...modifiedFiles], { stdio: "inherit" });
  execFileSync(
    "git",
    [
      "commit",
      "-m",
      `fix: auto-fix iteration ${fixingState.iterationCount} [skip ci]`,
    ],
    { stdio: "inherit" }
  );
  execFileSync("git", ["push"], { stdio: "inherit" });

  // Capture commit SHA for state
  const commitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  console.log(`[main-loop] Committed: ${commitSha}`);

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

  console.log("[main-loop] Posting @codex review request...");
  const reviewRequestId = await postCodexReviewRequest(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken
  );

  const waitingState: ReviewState = {
    ...fixingState,
    status: "waiting_codex",
    lastClaudeCommitSha: commitSha,
    lastCodexRequestCommentId: reviewRequestId,
  };
  await updateStateComment(
    config.repoOwner,
    config.repoName,
    commentId,
    waitingState,
    config.githubToken
  );

  console.log(
    `[main-loop] Phase 4 complete. Status: waiting_codex. Review request: ${reviewRequestId}`
  );
}

main().catch((error) => {
  console.error("[main-loop] Workflow B failed:", error);
  process.exit(1);
});
