import * as core from "@actions/core";
import {
  loadConfig,
  DEFAULT_LOOPPILOT_LABEL,
  type Config,
} from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import { ghApi } from "./gh.js";
import { demoteFixingOnCrash, rollbackFixingClaim } from "./crash-recovery.js";
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
  summaryMayContainFindings,
} from "./review-collector.js";
import { computeFindingsHash } from "./findings-hash.js";
import { isLoop } from "./loop-detector.js";
import {
  deriveIterationProgress,
  postAutoMergeSkipNotification as defaultPostAutoMergeSkipNotification,
  postCompletionComment as defaultPostCompletionComment,
  postFixingStartComment as defaultPostFixingStartComment,
  postStopComment as defaultPostStopComment,
  postInitIncompleteComment as defaultPostInitIncompleteComment,
} from "./comment-poster.js";
import { mergeIfChecksPass as defaultMergeIfChecksPass } from "./pr-merger.js";
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
  type ClaudeCodeRepairScopePolicy,
} from "./claude-code-repair-request.js";
import { buildScopePolicy } from "./scope-checker.js";
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
  postFixingStartComment: typeof defaultPostFixingStartComment;
  postStopComment: typeof defaultPostStopComment;
  postInitIncompleteComment: typeof defaultPostInitIncompleteComment;
  /** TY-295: top-level PR notification when `mergeIfChecksPass` skips. */
  postAutoMergeSkipNotification: typeof defaultPostAutoMergeSkipNotification;
  mergeIfChecksPass: typeof defaultMergeIfChecksPass;
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
  /**
   * `git checkout <ref>` (via `execFileSync`, `stdio: "inherit"`). Throws on
   * non-zero exit (TY-298 #1 — corrects the prior "non-fatal" docstring that
   * misrepresented the implementation). The throw propagates through
   * `runPreFix` and is caught by `runIfNotVitest`'s `onError`, which calls
   * `core.setFailed` + `demoteFixingOnCrash`. That, in turn, lets the
   * `looppilot-loop.yml` #2B fail-safe post the top-level 🛑 notification.
   *
   * Must be invoked BEFORE the `fixingState` write (TY-285 #4) so a checkout
   * failure does not consume an iteration slot or append a finding-hash
   * entry. The corresponding invariant is fixed by
   * `tests/main-pre-fix.test.ts` "propagates checkoutBranch failure ..." —
   * any future stub that silently swallows the failure will break that test.
   */
  checkoutBranch: (ref: string) => void;
  /**
   * Fetches the PR head repo `full_name` ("owner/repo"), or "" when the head
   * repo is missing / deleted. Backstops the wrapping workflow's "Check fork
   * PR" step: the composite action must refuse to invoke claude-code-action +
   * commit/push against fork-controlled code even if a consumer's Workflow B
   * omits that guard. `docs/operations/security.md` documents the
   * claude-code-action step as double-guarded against forks; this dep makes
   * that guarantee hold inside the action, not only in the reference YAML.
   */
  fetchPrHeadRepoFullName: (
    owner: string,
    repo: string,
    pr: number,
    token: string,
  ) => Promise<string>;
}

const defaultDeps: PreFixDeps = {
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
  fetchReviewComments: defaultFetchReviewComments,
  stabilizeReviewComments: defaultStabilizeReviewComments,
  postCompletionComment: defaultPostCompletionComment,
  postFixingStartComment: defaultPostFixingStartComment,
  postStopComment: defaultPostStopComment,
  postInitIncompleteComment: defaultPostInitIncompleteComment,
  postAutoMergeSkipNotification: defaultPostAutoMergeSkipNotification,
  mergeIfChecksPass: defaultMergeIfChecksPass,
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
  fetchPrHeadRepoFullName: async (owner, repo, pr, token) => {
    const stdout = await ghApi(
      [
        "api",
        `repos/${owner}/${repo}/pulls/${pr}`,
        "--jq",
        ".head.repo.full_name // empty",
      ],
      token,
    );
    return stdout.trim();
  },
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
  // Code subscription. The LoopPilot loop can fire up to
  // MAX_REVIEW_ITERATIONS (default 20) repairs per PR — with Opus
  // escalation in the mix — which can burn through a Pro / Max quota fast
  // and starve the same account's interactive Claude Code usage.
  if (config.claudeCodeOauthToken !== "") {
    deps.warning(
      "[pre-fix] Running with Claude Code OAuth token (subscription). " +
        "Your personal account's usage limits apply — LoopPilot iterations " +
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

  // ─── Fork-PR backstop (defense-in-depth) ──────────────────────────────────
  // The wrapping workflow's "Check fork PR" step is the primary guard, but the
  // composite action must not invoke claude-code-action + commit/push (or even
  // a /restart-review) against fork-controlled code if a consumer's Workflow B
  // omits that step. Verify the PR head repo matches the base repo BEFORE any
  // state mutation, restart handling, or agent invocation. Same-repo PRs always
  // have head.repo.full_name === base repo; a fork PR (or a deleted head repo →
  // empty) is refused. should_run is already false, so returning here keeps the
  // claude-code-action and post-fix steps skipped. The comparison is
  // case-insensitive because GitHub treats repo names case-insensitively, so a
  // case-drifted but legitimate same-repo PR is never falsely blocked.
  const headRepoFullName = await deps.fetchPrHeadRepoFullName(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  const expectedRepo = `${config.repoOwner}/${config.repoName}`;
  if (headRepoFullName.toLowerCase() !== expectedRepo.toLowerCase()) {
    deps.error(
      `[pre-fix] Refusing to run: PR #${config.prNumber} head repo ` +
        `${headRepoFullName === "" ? "(unknown/deleted)" : `"${headRepoFullName}"`} ` +
        `does not match base repo "${expectedRepo}". Auto-fix is disabled for fork PRs. ` +
        `Ensure the workflow's "Check fork PR" guard is present (see docs/operations/security.md).`,
    );
    return;
  }

  // ─── Phase 0: Label gate ──────────────────────────────────────────────────
  const isCommandTrigger = isRestartCommandLike(config.triggerCommentBody);
  if (!config.autoReviewFullAuto && !isCommandTrigger) {
    const effectiveLabel = config.autoReviewLabel || DEFAULT_LOOPPILOT_LABEL;
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
      codexBotLogin: config.codexBotLogin,
      codexAckTimeoutSeconds: config.codexAckTimeoutSeconds,
      codexAckPollIntervalSeconds: config.codexAckPollIntervalSeconds,
      codexAckMaxReposts: config.codexAckMaxReposts,
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
    // TY-273 #B4: use the dedicated `fixingStartedAt` timestamp set when
    // Phase 3 transitioned into `fixing`. Earlier code reused
    // `lastCodexReviewReceivedAt`, which is preserved across
    // `/restart-review` and crash recovery; a soft-restarted fixing state
    // (or a state restored from a much older Codex review) would falsely
    // trip the stale threshold and downgrade to `state_corrupted`.
    //
    // Legacy state comments (pre-TY-273) carry `fixingStartedAt: null`. We
    // fall back to `lastCodexReviewReceivedAt` for those so the recovery
    // path is preserved; future writes populate `fixingStartedAt` and the
    // fallback stops being relevant.
    const fixingStartedAt =
      state.fixingStartedAt ?? state.lastCodexReviewReceivedAt;

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
    // TY-282 #1B: previously the stale recovery wrote `state_corrupted`,
    // which `applyRestartToState` reject outright, forcing manual hidden-
    // comment surgery. The fixing claim is stale because some prior workflow
    // exited without finalizing state — the data itself is still parseable
    // and the loop should be restartable. Downgrade to `workflow_crashed`
    // so `/restart-review` recovers cleanly.
    const recoveredState: ReviewState = {
      ...state,
      // TY-302 #1: roll back the iteration / history entries pre-fix Phase 3
      // claimed before the prior workflow died so a soft `/restart-review`
      // does not loop-detect on the orphan entry.
      ...rollbackFixingClaim(state),
      status: "stopped",
      stopReason: "workflow_crashed",
      fixingStartedAt: null,
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
      "workflow_crashed",
      triggerCommentId,
      0,
      "Previous fixing state timed out — recovered automatically. Use /restart-review to resume.",
      config.githubToken,
      deriveIterationProgress(recoveredState, config.maxReviewIterations),
    );
    return;
  }

  if (state.status !== "waiting_codex") {
    deps.warning(
      `[pre-fix] Unexpected status '${state.status}'. Only 'waiting_codex' is processable. Skipping.`,
    );
    return;
  }

  // TY-301 #2: dedup the trigger by (id, source) instead of id alone.
  // issue_comment.id and pull_request_review.id are drawn from separate ID
  // namespaces; without a source check, a stored review-id colliding with an
  // incoming comment-id (or vice versa) would silently skip the legitimate
  // trigger as "already processed". Legacy state (`lastProcessedTriggerSource
  // === null`) and legacy workflow YAML (no `triggerEventName`) both fall back
  // to id-only comparison so existing in-flight PRs do not regress.
  const currentTriggerSource: "comment" | "review" | null =
    config.triggerEventName === "issue_comment"
      ? "comment"
      : config.triggerEventName === "pull_request_review"
        ? "review"
        : null;

  if (
    triggerCommentId !== 0 &&
    state.lastProcessedReviewId === triggerCommentId &&
    (state.lastProcessedTriggerSource === null ||
      currentTriggerSource === null ||
      state.lastProcessedTriggerSource === currentTriggerSource)
  ) {
    deps.info(
      `[pre-fix] Trigger comment ${triggerCommentId} (source=${currentTriggerSource ?? "unknown"}) already processed. Skipping.`,
    );
    return;
  }

  // ─── Codex usage-limit short-circuit (TY-229) ────────────────────────────
  // When Codex hits its quota it replies to the @codex review request with a
  // notice instead of a real review. Without this check we'd debounce, fetch
  // zero inline comments, and mark the LoopPilot `done / no_findings` —
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
      // TY-301 #2: keep `lastProcessedTriggerSource` consistent with the id we
      // just wrote so the next dedup decision sees a coherent (id, source) pair.
      // When the event-name input is absent (legacy workflow YAML), fall back
      // to whatever source the previous trigger recorded.
      //
      // TY-306 #3: bind the source's fallback to the id's. When
      // `triggerCommentId === 0` the id falls back to the old value, so the
      // source MUST also fall back — otherwise the pair becomes
      // (id: old review_id, source: new "comment") cross-namespace garbage
      // that defeats the (id, source) dedup TY-301 #2 set up.
      lastProcessedTriggerSource:
        triggerCommentId !== 0
          ? (currentTriggerSource ?? state.lastProcessedTriggerSource)
          : state.lastProcessedTriggerSource,
      status: "stopped",
      stopReason: "codex_usage_limit",
      // TY-301 #1: pre-fix terminal transitions must explicitly clear
      // `fixingStartedAt` to uphold the `types.ts` invariant
      // "`fixingStartedAt === null` whenever `status !== 'fixing'`". The
      // happy-path input here is always `waiting_codex` with the field already
      // null, but a hand-edited / legacy state could carry a stale timestamp
      // that the spread would otherwise preserve into a `stopped` state.
      fixingStartedAt: null,
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
      deriveIterationProgress(stoppedState, config.maxReviewIterations),
    );
    return;
  }

  // ─── Debounce ─────────────────────────────────────────────────────────────
  // TY-294 (UX): the initial debounce exists to give Codex time to post inline
  // comments after the trigger summary. When the trigger summary itself
  // already signals no findings (e.g. Codex's "Didn't find any major issues"
  // reply), there are no inline comments to wait for, so the 90s sleep adds
  // user-visible latency for zero benefit. The stabilization safeguard inside
  // `stabilizeReviewComments` still re-polls inline comments before judging,
  // so a false negative here only falls back to today's behaviour.
  const debounceSkipped = !summaryMayContainFindings(
    config.triggerCommentBody,
    config.severityThreshold,
  );
  if (debounceSkipped) {
    deps.info(
      "[pre-fix] Trigger summary indicates no findings; skipping debounce.",
    );
  } else {
    deps.info(`[pre-fix] Debouncing ${config.debounceSeconds}s...`);
    await deps.sleep(config.debounceSeconds * 1000);
  }

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
    forceStabilize: debounceSkipped,
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
    // TY-301 #2: write the trigger source alongside the id so the next pre-fix
    // run can disambiguate the issue_comment / pull_request_review namespaces.
    // When the workflow YAML does not pass `triggerEventName` (legacy), keep
    // whatever the previous trigger recorded — `null` simply preserves the
    // id-only fallback dedup behaviour.
    //
    // TY-306 #3: bind the source's fallback to the id's. When
    // `triggerCommentId === 0` (manual workflow_dispatch with only some
    // inputs, legacy YAML, etc.) the id falls back to the old value, so the
    // source MUST also fall back — otherwise the pair becomes
    // (id: old review_id, source: new "comment") cross-namespace garbage
    // that defeats the (id, source) dedup.
    lastProcessedTriggerSource:
      triggerCommentId !== 0
        ? (currentTriggerSource ?? state.lastProcessedTriggerSource)
        : state.lastProcessedTriggerSource,
    lastCodexReviewReceivedAt: latestCommentTime || deps.now().toISOString(),
  };

  if (findings.length === 0) {
    deps.info("[pre-fix] No findings. Marking done.");
    const doneState: ReviewState = {
      ...updatedStateBase,
      status: "done",
      stopReason: "no_findings",
      // TY-301 #1: see codex_usage_limit branch — defense-in-depth clear so a
      // stale `fixingStartedAt` carried in by a hand-edited / legacy state
      // cannot leak into a non-`fixing` status.
      fixingStartedAt: null,
    };
    if (
      !(await updateStateCommentLocked(
        doneState,
        "Could not mark LoopPilot as done.",
      ))
    )
      return;
    await deps.postCompletionComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      doneState.iterationCount,
      config.githubToken,
      {
        autoMergeOnClean: config.autoMergeOnClean,
        progress: deriveIterationProgress(
          doneState,
          config.maxReviewIterations,
        ),
        // BUG-01: surface dropped (unparseable-severity) Codex comments on the
        // completion comment so an all-unparseable review is not silently
        // reported as a clean `done`. Log-only previously (`skipped.unparseable`
        // warning above).
        unparseableComments: skipped.unparseable,
      },
    );
    if (config.autoMergeOnClean) {
      // TY-295: build the run URL from GitHub Actions env so the skip
      // notification can link back to the workflow run that decided to skip.
      // Both vars are populated by the GitHub Actions runtime; we fall back
      // to a reasonable default when running outside Actions (tests inject
      // their own postAutoMergeSkipNotification so this fallback is harmless).
      const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
      const runId = process.env.GITHUB_RUN_ID || "";
      const runUrl =
        runId !== ""
          ? `${serverUrl}/${config.repoOwner}/${config.repoName}/actions/runs/${runId}`
          : `${serverUrl}/${config.repoOwner}/${config.repoName}/actions`;
      if (skipped.unparseable > 0) {
        // BUG-01 follow-up: the `done / no_findings` result is uncertain when
        // some Codex comments could not be parsed for severity. Withhold
        // auto-merge and notify so an operator reviews the skipped comment(s)
        // before the PR merges — a Codex output-format drift must not silently
        // auto-merge a PR with un-triaged findings.
        deps.warning(
          `[pre-fix] Withholding auto-merge: ${skipped.unparseable} unparseable Codex comment(s) on a no-findings result.`,
        );
        await deps.postAutoMergeSkipNotification(
          config.repoOwner,
          config.repoName,
          config.prNumber,
          { kind: "unparseable_findings", count: skipped.unparseable },
          runUrl,
          config.githubToken,
        );
      } else {
        await deps.mergeIfChecksPass(
          config.repoOwner,
          config.repoName,
          config.prNumber,
          config.githubToken,
          { info: deps.info, warning: deps.warning },
          {
            pollIntervalMs: config.autoMergePollSeconds * 1000,
            timeoutMs: config.autoMergeTimeoutMinutes * 60 * 1000,
            postSkipNotification: (kind) =>
              deps.postAutoMergeSkipNotification(
                config.repoOwner,
                config.repoName,
                config.prNumber,
                kind,
                runUrl,
                config.githubToken,
              ),
          },
        );
      }
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
      // TY-301 #1: defense-in-depth clear (see codex_usage_limit branch).
      fixingStartedAt: null,
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
      deriveIterationProgress(stoppedState, config.maxReviewIterations),
    );
    return;
  }

  if (isLoop(findings, state.findingsHashHistory)) {
    deps.info("[pre-fix] Loop detected. Stopping.");
    const stoppedState: ReviewState = {
      ...updatedStateBase,
      status: "stopped",
      stopReason: "loop_detected",
      // TY-301 #1: defense-in-depth clear (see codex_usage_limit branch).
      fixingStartedAt: null,
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
      deriveIterationProgress(stoppedState, config.maxReviewIterations),
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

  // The workflow already checked out the PR ref before this step runs, but
  // a recovery / retry may have left the working tree on a different ref.
  //
  // TY-285 #4: validate + checkout + readHeadSha BEFORE the `fixing` state is
  // written. If any of these throw, `demoteFixingOnCrash` only rewrites
  // `status` / `stopReason` / `fixingStartedAt` and leaves `iterationCount`
  // and `findingsHashHistory` unchanged — running the validation after the
  // write therefore burns one iteration slot and appends a hash entry on
  // every replay of the same PR, eventually hitting `max_iterations`.
  //
  // TY-285 #3: the previous ASCII-only regex (`^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$`)
  // rejected legitimate non-ASCII branch names (`機能/タスク-123`,
  // `feature/한국어`). `execFileSync("git", ["checkout", ref])` does not invoke
  // a shell, so the only argv-level injection risks are a leading `-` (which
  // would be parsed as a git flag like `-rf`) and `..` path traversal in the
  // ref. An empty ref would also confuse git. Reject exactly those, accept
  // everything else.
  if (
    prHeadRef.length === 0 ||
    prHeadRef.startsWith("-") ||
    prHeadRef.includes("..")
  ) {
    throw new Error(`[pre-fix] Invalid branch name: ${prHeadRef}`);
  }
  deps.checkoutBranch(prHeadRef);
  const headSha = deps.readHeadSha();

  const fixingState: ReviewState = {
    ...updatedStateBase,
    iterationCount: newIteration,
    status: "fixing",
    lastFindingsHash: currentHash,
    findingsHashHistory: updatedHashHistory,
    // TY-273 #B4: record the actual fixing entry timestamp so the
    // stale-detector in subsequent pre-fix runs can distinguish a genuinely
    // hung `fixing` from one that legitimately resumed via /restart-review.
    fixingStartedAt: deps.now().toISOString(),
  };
  if (
    !(await updateStateCommentLocked(
      fixingState,
      "Could not claim the hidden comment state for fixing.",
    ))
  )
    return;

  // TY-291 #2 (UX-05): announce the fixing transition on the status comment so
  // operators see "Fixing — iteration N starting" during the multi-minute
  // claude-code-action run. Best-effort: a failure here only loses the
  // intermediate header update; the next post-fix entry will re-anchor
  // the snapshot.
  try {
    await deps.postFixingStartComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      newIteration,
      selection.tier,
      config.maxReviewIterations,
      findings.length,
      config.githubToken,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warning(`[pre-fix] Failed to update fixing-start status: ${message}`);
  }

  // ─── Build claude-code-action prompt ─────────────────────────────────────
  const prContext: PrContext = {
    number: config.prNumber,
    title: config.prTitle,
    branch: prHeadRef,
  };

  // TY-278: Derive the effective scope policy and surface it in the prompt so
  // claude-code-action knows which paths post-fix will revert. `buildScopePolicy`
  // is defensive and should not throw under normal config, but we wrap it so
  // any future parse-time failure simply omits the section (== pre-TY-278
  // behaviour) instead of failing the entire pre-fix run.
  let scopePolicyForPrompt: ClaudeCodeRepairScopePolicy | null = null;
  try {
    const effectivePolicy = buildScopePolicy({
      blockPathsSpec: config.autoReviewBlockPaths,
      maxFiles: config.scopeMaxFiles > 0 ? config.scopeMaxFiles : undefined,
      maxLines: config.scopeMaxLines > 0 ? config.scopeMaxLines : undefined,
    });
    scopePolicyForPrompt = {
      blockedPaths: effectivePolicy.blockPatterns.map((p) => ({
        path: p.path,
        locked: p.locked,
      })),
      maxFiles: effectivePolicy.maxFiles,
      maxLines: effectivePolicy.maxLines,
      exemptedRootDotfiles: effectivePolicy.exemptedRootDotfiles
        ? [...effectivePolicy.exemptedRootDotfiles].sort()
        : [],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.warning(
      `[pre-fix] Failed to derive scope policy for the repair prompt; the section will be omitted. Reason: ${reason}`,
    );
  }

  const repairRequest = buildClaudeCodeRepairRequest({
    prContext,
    headSha,
    findings,
    iteration: fixingState.iterationCount,
    maxIterations: config.maxReviewIterations,
    checkCommand: config.checkCommand,
    previousCheckFailure: state.previousCheckFailure ?? null,
    scopePolicy: scopePolicyForPrompt,
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
