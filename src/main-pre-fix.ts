import * as core from "@actions/core";
import {
  loadConfig,
  DEFAULT_AUTO_REVIEW_LABEL,
  type Config,
} from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import { demoteFixingOnCrash } from "./crash-recovery.js";
import {
  createInitialState,
  readState as defaultReadState,
  updateStateComment as defaultUpdateStateComment,
} from "./state-manager.js";
import { createLockedStateUpdater } from "./state-comment-locker.js";
import * as git from "./git.js";
import {
  fetchReviewComments as defaultFetchReviewComments,
  filterAndParseComments,
  stabilizeReviewComments as defaultStabilizeReviewComments,
} from "./review-collector.js";
import { computeFindingsHash } from "./findings-hash.js";
import { isLoop } from "./loop-detector.js";
import {
  postCompletionComment as defaultPostCompletionComment,
  postStopComment as defaultPostStopComment,
  postInitIncompleteComment as defaultPostInitIncompleteComment,
} from "./comment-poster.js";
import { enableAutoMergeSquash as defaultEnableAutoMergeSquash } from "./pr-merger.js";
import { registerAllSecrets } from "./secrets.js";
import {
  fetchPrLabels as defaultFetchPrLabels,
  isAutoReviewAllowed,
} from "./pr-labels.js";
import {
  handleRestartCommand as defaultHandleRestartCommand,
  isRestartCommandLike,
} from "./restart-command.js";
import {
  buildClaudeCodeRepairRequest,
  buildClaudeCodeRepairPrompt,
} from "./claude-code-repair-request.js";
import {
  deriveAllowedBashTools,
  serializeAllowedBashTools,
} from "./check-command-allowlist.js";
import { selectModel } from "./model-selector.js";
import { isCodexUsageLimitMessage } from "./codex-status.js";
import type { PrContext, ReviewState } from "./types.js";

/** Pause execution for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Outputs emitted by the pre-fix step for downstream composite-action steps.
 *
 * `should_run` gates whether claude-code-action and the post-fix step run.
 * When `should_run === "false"` the post-fix step is skipped; pre-fix has
 * already finalized state (done / stopped) and the loop is over for this
 * trigger.
 */
export type PreFixOutputName =
  | "should_run"
  | "prompt"
  | "iteration"
  | "check_command"
  | "pr_head_ref"
  | "head_sha"
  | "comment_id"
  | "trigger_comment_id"
  | "findings_count"
  | "allowed_bash_tools"
  | "model";

export interface PreFixDeps {
  readState: typeof defaultReadState;
  updateStateComment: typeof defaultUpdateStateComment;
  fetchReviewComments: typeof defaultFetchReviewComments;
  stabilizeReviewComments: typeof defaultStabilizeReviewComments;
  postCompletionComment: typeof defaultPostCompletionComment;
  postStopComment: typeof defaultPostStopComment;
  postInitIncompleteComment: typeof defaultPostInitIncompleteComment;
  enableAutoMergeSquash: typeof defaultEnableAutoMergeSquash;
  fetchPrLabels: typeof defaultFetchPrLabels;
  handleRestartCommand: typeof defaultHandleRestartCommand;
  setSecret: (secret: string) => void;
  setOutput: (name: PreFixOutputName, value: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Reads HEAD sha. Returns "" on failure. */
  readHeadSha: () => string;
  /** Best-effort `git checkout <ref>`. Failure is logged but non-fatal. */
  checkoutBranch: (ref: string) => void;
}

const defaultDeps: PreFixDeps = {
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
  fetchReviewComments: defaultFetchReviewComments,
  stabilizeReviewComments: defaultStabilizeReviewComments,
  postCompletionComment: defaultPostCompletionComment,
  postStopComment: defaultPostStopComment,
  postInitIncompleteComment: defaultPostInitIncompleteComment,
  enableAutoMergeSquash: defaultEnableAutoMergeSquash,
  fetchPrLabels: defaultFetchPrLabels,
  handleRestartCommand: defaultHandleRestartCommand,
  setSecret: (secret) => core.setSecret(secret),
  setOutput: (name, value) => core.setOutput(name, value),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  error: (message) => core.error(message),
  sleep,
  now: () => new Date(),
  readHeadSha: () => git.readHeadSha("pre-fix"),
  checkoutBranch: git.checkoutBranch,
};

/**
 * Run the pre-fix phase of Workflow B.
 *
 * Performs Phase 0 (label gate), Phase 1 (state guards), debounce, findings
 * collection, Phase 2 (judge: done / max-iterations / loop), and the first
 * half of Phase 3 (transition to "fixing"). On success, emits the prompt and
 * execution context for the downstream `claude-code-action` and `post-fix`
 * steps via GITHUB_OUTPUT (`should_run=true`). On any short-circuit (label
 * gate, terminal status, judge stop, restart command), emits
 * `should_run=false`.
 */
export async function runPreFix(config: Config, deps: PreFixDeps = defaultDeps): Promise<void> {
  // TY-264: all secret-bearing Config fields (incl. autoReviewPushToken) are
  // registered via a single helper so a new credential added to `Config`
  // automatically appears in init/pre-fix/post-fix log masking. Empty values
  // are skipped, so the API-key / OAuth token gate from `loadConfig` keeps
  // working without a special case here.
  registerAllSecrets(config, deps.setSecret);

  // TY-260: surface a one-line caution when running on a personal Claude
  // Code subscription. The auto-review loop can fire up to
  // MAX_REVIEW_ITERATIONS (default 20) repairs per PR — with Opus
  // escalation in the mix — which can burn through a Pro / Max quota fast
  // and starve the same account's interactive Claude Code usage.
  if (config.claudeCodeOauthToken !== "") {
    deps.warning(
      "[pre-fix] Running with Claude Code OAuth token (subscription). " +
        "Your personal account's usage limits apply — auto-review iterations " +
        "may consume your quota quickly, especially with Opus escalation. " +
        "Consider lowering MAX_REVIEW_ITERATIONS for high-frequency CI use; " +
        "see docs/operations/security.md (認証).",
    );
  }

  // Default to should_run=false so any early return leaves the gate closed.
  deps.setOutput("should_run", "false");

  const triggerCommentId = config.triggerCommentId;
  const prHeadRef = config.prHeadRef;
  if (!prHeadRef) {
    throw new Error(
      "[pre-fix] pr-head-ref is required but not set. Cannot determine target branch.",
    );
  }

  deps.info(
    `[pre-fix] Starting Workflow B for PR #${config.prNumber}, trigger comment: ${triggerCommentId}`,
  );

  // ─── Phase 0: Label gate ──────────────────────────────────────────────────
  const isCommandTrigger = isRestartCommandLike(config.triggerCommentBody);
  if (!config.autoReviewFullAuto && !isCommandTrigger) {
    const effectiveLabel = config.autoReviewLabel || DEFAULT_AUTO_REVIEW_LABEL;
    const labels = await deps.fetchPrLabels(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken,
    );
    if (!isAutoReviewAllowed(effectiveLabel, labels)) {
      deps.info(
        `[pre-fix] Required label '${effectiveLabel}' is not present on PR #${config.prNumber}. Skipping.`,
      );
      return;
    }
  }

  // ─── Phase 1: State + Guard ──────────────────────────────────────────────
  const stateResult = await deps.readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  const stateCommentUpdatedAt =
    stateResult.found || stateResult.corrupted
      ? stateResult.commentUpdatedAt
      : undefined;

  function makeLockedUpdater(targetCommentId: number) {
    return createLockedStateUpdater({
      owner: config.repoOwner,
      repo: config.repoName,
      commentId: targetCommentId,
      token: config.githubToken,
      initialExpectedUpdatedAt: stateCommentUpdatedAt,
      label: "pre-fix",
      updateStateComment: deps.updateStateComment,
      warning: deps.warning,
      onConflict: async (detail) => {
        await deps.postStopComment(
          config.repoOwner,
          config.repoName,
          config.prNumber,
          "state_conflict",
          triggerCommentId,
          0,
          `${detail} Hidden comment was updated by another workflow run before this run could safely persist its state. Re-run after the active workflow finishes if needed.`,
          config.githubToken,
        );
      },
    });
  }

  if (isCommandTrigger) {
    const restartResult = await deps.handleRestartCommand({
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

  if (!stateResult.found && !stateResult.corrupted) {
    deps.info("[pre-fix] No state found. Workflow A has not run. Skipping.");
    return;
  }

  if (!stateResult.found && stateResult.corrupted) {
    deps.error("[pre-fix] Hidden comment found but state JSON is corrupted.");
    if (stateResult.commentId !== null) {
      const corruptedState: ReviewState = {
        ...createInitialState(),
        status: "stopped",
        stopReason: "state_corrupted",
      };
      if (
        !(await makeLockedUpdater(stateResult.commentId)(
          corruptedState,
          "Could not mark corrupted hidden state as stopped.",
        ))
      )
        return;
    }
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "state_corrupted",
      triggerCommentId,
      0,
      "Hidden comment state JSON is corrupted. Manual re-initialization required.",
      config.githubToken,
    );
    return;
  }

  if (!stateResult.found) {
    return;
  }
  const { state } = stateResult;
  const { commentId } = stateResult;
  const updateStateCommentLocked = makeLockedUpdater(commentId);

  if (state.status === "initialized") {
    deps.info("[pre-fix] State is 'initialized' — Workflow A incomplete.");
    await deps.postInitIncompleteComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken,
    );
    return;
  }

  if (state.status === "stopped" || state.status === "done") {
    deps.info(`[pre-fix] Status is '${state.status}'. Skipping.`);
    return;
  }

  if (state.status === "fixing") {
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    const fixingStartedAt = state.lastCodexReviewReceivedAt;

    if (fixingStartedAt === null) {
      deps.warning(
        "[pre-fix] Status is 'fixing' with null timestamp. Treating as stale.",
      );
    }

    const elapsed = deps.now().getTime() - new Date(fixingStartedAt ?? 0).getTime();

    if (fixingStartedAt !== null && elapsed < STALE_THRESHOLD_MS) {
      deps.info(
        `[pre-fix] Status is 'fixing' (started ${Math.round(elapsed / 1000)}s ago). Skipping.`,
      );
      return;
    }

    deps.warning(
      `[pre-fix] Status stuck in 'fixing' for ${Math.round(elapsed / 60000)}min. Recovering.`,
    );
    const recoveredState: ReviewState = {
      ...state,
      status: "stopped",
      stopReason: "state_corrupted",
    };
    if (
      !(await updateStateCommentLocked(
        recoveredState,
        "Could not recover stale fixing state.",
      ))
    )
      return;
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "state_corrupted",
      triggerCommentId,
      0,
      "Previous fixing state timed out — recovered automatically",
      config.githubToken,
    );
    return;
  }

  if (state.status !== "waiting_codex") {
    deps.warning(
      `[pre-fix] Unexpected status '${state.status}'. Only 'waiting_codex' is processable. Skipping.`,
    );
    return;
  }

  if (
    triggerCommentId !== 0 &&
    state.lastProcessedReviewId === triggerCommentId
  ) {
    deps.info(
      `[pre-fix] Trigger comment ${triggerCommentId} already processed. Skipping.`,
    );
    return;
  }

  // ─── Codex usage-limit short-circuit (TY-229) ────────────────────────────
  // When Codex hits its quota it replies to the @codex review request with a
  // notice instead of a real review. Without this check we'd debounce, fetch
  // zero inline comments, and mark the auto-review `done / no_findings` —
  // silently masking a quota-induced stop. Detect it here and stop with a
  // dedicated reason so PR readers and `/restart-review` users understand
  // the loop did not actually succeed.
  if (
    config.triggerUserLogin === config.codexBotLogin &&
    isCodexUsageLimitMessage(config.triggerCommentBody)
  ) {
    deps.info("[pre-fix] Codex usage limit detected in trigger body. Stopping.");
    const stoppedState: ReviewState = {
      ...state,
      lastProcessedReviewId: triggerCommentId || state.lastProcessedReviewId,
      status: "stopped",
      stopReason: "codex_usage_limit",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "Could not stop after detecting Codex usage limit.",
      ))
    )
      return;
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "codex_usage_limit",
      triggerCommentId,
      0,
      "Codex replied with a usage-limit notice instead of a review. Wait for quota to reset (or upgrade), then run /restart-review.",
      config.githubToken,
    );
    return;
  }

  // ─── Debounce ─────────────────────────────────────────────────────────────
  deps.info(`[pre-fix] Debouncing ${config.debounceSeconds}s...`);
  await deps.sleep(config.debounceSeconds * 1000);

  // ─── Collect Findings ────────────────────────────────────────────────────
  deps.info("[pre-fix] Fetching review comments...");
  const fetchedComments = await deps.fetchReviewComments(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  const rawComments = await deps.stabilizeReviewComments(fetchedComments, {
    botLogin: config.codexBotLogin,
    lastReceivedAt: state.lastCodexReviewReceivedAt,
    triggerSummaryBody: config.triggerCommentBody,
    severityThreshold: config.severityThreshold,
    intervalMs: config.stabilizeIntervalSeconds * 1000,
    stablePolls: config.stabilizeCount,
    maxWaitMs: config.debounceSeconds * 1000,
    fetchComments: () =>
      deps.fetchReviewComments(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        config.githubToken,
      ),
    sleep: deps.sleep,
    log: (message) => deps.info(message),
  });

  const { findings, skipped } = filterAndParseComments(
    rawComments,
    config.codexBotLogin,
    state.lastCodexReviewReceivedAt,
    config.severityThreshold,
  );

  if (skipped.unparseable > 0) {
    deps.warning(
      `[review-collector] Skipped ${skipped.unparseable} comments due to unparseable severity; check parser regex.`,
    );
  }
  if (skipped.belowThreshold > 0) {
    deps.info(
      `[review-collector] Skipped ${skipped.belowThreshold} findings below threshold (threshold=${config.severityThreshold}).`,
    );
  }

  deps.info(
    `[pre-fix] Found ${findings.length} findings at or above threshold ${config.severityThreshold}.`,
  );

  // ─── Phase 2: Judge ───────────────────────────────────────────────────────
  const latestCommentTime = rawComments
    .filter((c) => c.user.login === config.codexBotLogin)
    .reduce(
      (max, c) => (c.createdAt > max ? c.createdAt : max),
      state.lastCodexReviewReceivedAt ?? "",
    );

  const updatedStateBase: ReviewState = {
    ...state,
    lastProcessedReviewId: triggerCommentId || state.lastProcessedReviewId,
    lastCodexReviewReceivedAt: latestCommentTime || deps.now().toISOString(),
  };

  if (findings.length === 0) {
    deps.info("[pre-fix] No findings. Marking done.");
    const doneState: ReviewState = {
      ...updatedStateBase,
      status: "done",
      stopReason: "no_findings",
    };
    if (
      !(await updateStateCommentLocked(
        doneState,
        "Could not mark auto-review as done.",
      ))
    )
      return;
    await deps.postCompletionComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      doneState.iterationCount,
      config.githubToken,
    );
    if (config.autoMergeOnClean) {
      await deps.enableAutoMergeSquash(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        config.githubToken,
        { info: deps.info, warning: deps.warning },
      );
    }
    return;
  }

  if (state.iterationCount >= config.maxReviewIterations) {
    deps.info(
      `[pre-fix] Iteration count ${state.iterationCount} >= max ${config.maxReviewIterations}. Stopping.`,
    );
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "max_iterations",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "Could not stop after reaching the max iteration limit.",
      ))
    )
      return;
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "max_iterations",
      triggerCommentId,
      findings.length,
      `Reached MAX_REVIEW_ITERATIONS (${config.maxReviewIterations})`,
      config.githubToken,
    );
    return;
  }

  if (isLoop(findings, state.findingsHashHistory)) {
    deps.info("[pre-fix] Loop detected. Stopping.");
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "loop_detected",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "Could not stop after detecting a findings loop.",
      ))
    )
      return;
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "loop_detected",
      triggerCommentId,
      findings.length,
      "Same findings hash detected in previous iteration",
      config.githubToken,
    );
    return;
  }

  // ─── Phase 3 (first half): Transition to "fixing" ────────────────────────
  const currentHash = computeFindingsHash(findings);
  const newIteration = state.iterationCount + 1;

  // TY-243: when the previous iteration produced the same findings hash at
  // the base tier, `isLoop` lets us through so we can retry at the escalated
  // tier. Mark the upcoming iteration as `repeated_finding` so `selectModel`
  // picks the escalated model.
  const previousEntry =
    state.findingsHashHistory.length > 0
      ? state.findingsHashHistory[state.findingsHashHistory.length - 1]
      : null;
  const repeatedFinding =
    previousEntry !== null &&
    previousEntry.hash === currentHash &&
    (previousEntry.modelTier ?? "escalated") === "base";

  // TY-258: when the previous iteration ended with stopReason ==
  // "max_turns_exceeded", retry once at the escalated tier. `stopReason` is
  // intentionally preserved across `/restart-review` (see
  // `applyRestartToState`) and cleared on the next clean-commit transition
  // to `waiting_codex` (see post-fix), so this behaves as one-shot.
  const previousMaxTurnsExceeded = state.stopReason === "max_turns_exceeded";

  const selection = selectModel({
    baseModel: config.claudeCodeModelBase,
    escalatedModel: config.claudeCodeModelEscalated,
    findings,
    previousCheckFailure: state.previousCheckFailure ?? null,
    repeatedFinding,
    previousMaxTurnsExceeded,
  });
  deps.info(
    `[pre-fix] Model tier=${selection.tier} model=${selection.model}` +
      (selection.escalationReasons.length > 0
        ? ` reasons=${selection.escalationReasons.join(",")}`
        : ""),
  );

  const updatedHashHistory: typeof state.findingsHashHistory = [
    ...state.findingsHashHistory,
    { iteration: newIteration, hash: currentHash, modelTier: selection.tier },
  ];

  const fixingState: ReviewState = {
    ...updatedStateBase,
    iterationCount: newIteration,
    status: "fixing",
    lastFindingsHash: currentHash,
    findingsHashHistory: updatedHashHistory,
  };
  if (
    !(await updateStateCommentLocked(
      fixingState,
      "Could not claim the hidden comment state for fixing.",
    ))
  )
    return;

  // The workflow already checked out the PR ref before this step runs, but
  // a recovery / retry may have left the working tree on a different ref.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(prHeadRef) || prHeadRef.includes("..")) {
    throw new Error(`[pre-fix] Invalid branch name: ${prHeadRef}`);
  }
  deps.checkoutBranch(prHeadRef);
  const headSha = deps.readHeadSha();

  // ─── Build claude-code-action prompt ─────────────────────────────────────
  const prContext: PrContext = {
    number: config.prNumber,
    title: config.prTitle,
    branch: prHeadRef,
  };

  const repairRequest = buildClaudeCodeRepairRequest({
    prContext,
    headSha,
    findings,
    iteration: fixingState.iterationCount,
    maxIterations: config.maxReviewIterations,
    checkCommand: config.checkCommand,
    previousCheckFailure: state.previousCheckFailure ?? null,
  });
  const prompt = buildClaudeCodeRepairPrompt(repairRequest);

  // Promote CHECK_COMMAND into the claude-code-action Bash allowlist so the
  // final verification step can run when the downstream repository uses a
  // non-npm package manager (TY-238). Rejections fall back to the baseline
  // and are surfaced as warnings so operators can fix CHECK_COMMAND.
  const allowedBashTools = deriveAllowedBashTools(config.checkCommand);
  if (allowedBashTools.rejection !== null) {
    deps.warning(
      `[pre-fix] CHECK_COMMAND '${config.checkCommand}' not added to Bash allowlist: ${allowedBashTools.rejection}. claude-code-action may fail to verify; set CHECK_COMMAND to a whitelisted binary (see docs/operations/security.md).`,
    );
  }

  deps.setOutput("should_run", "true");
  deps.setOutput("prompt", prompt);
  deps.setOutput("iteration", String(fixingState.iterationCount));
  deps.setOutput("check_command", config.checkCommand);
  deps.setOutput("pr_head_ref", prHeadRef);
  deps.setOutput("head_sha", headSha);
  deps.setOutput("comment_id", String(commentId));
  deps.setOutput("trigger_comment_id", String(triggerCommentId));
  deps.setOutput("findings_count", String(findings.length));
  deps.setOutput(
    "allowed_bash_tools",
    serializeAllowedBashTools(allowedBashTools.tools),
  );
  deps.setOutput("model", selection.model);

  deps.info(
    `[pre-fix] Phase 3 prep complete. iteration=${fixingState.iterationCount}, findings=${findings.length}.`,
  );
}

async function run(): Promise<void> {
  await runPreFix(loadConfig());
}

runIfNotVitest(run, () => demoteFixingOnCrash("pre-fix"));
