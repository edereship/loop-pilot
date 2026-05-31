import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import {
  upsertStatusComment,
  type StatusEntry,
  type StatusUpdate,
} from "./status-comment.js";
import {
  STOP_REASON_LABELS,
  type ReviewState,
  type StopReason,
} from "./types.js";

/** Returns an ISO-8601 timestamp at second resolution (UTC). */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Posts a comment to a GitHub PR issue and returns the new comment's numeric ID.
 */
export async function postComment(
  owner: string,
  name: string,
  pr: number,
  body: string,
  token: string,
): Promise<number> {
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      // TY-276 #5: prefer the long-form `--method` over `-X` to match
      // state-manager.ts and reduce stylistic drift across gh invocations.
      "--method",
      "POST",
      // TY-269: use `--raw-field` for body. Plain `--field` (= `-f`)
      // interprets a leading `@` as a file-read directive, which silently
      // corrupts payloads like `@codex review` (the body
      // `postCodexReviewRequest` sends — gh would try to open a file named
      // `codex review`). `--raw-field` (= `-F`) passes the value through as a
      // literal string with no `@` interpretation.
      "--raw-field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    token,
  );
  const commentId = parseInt(stdout.trim(), 10);
  if (isNaN(commentId)) {
    throw new Error(
      `postComment: unexpected response from GitHub API: ${stdout.trim()}`
    );
  }
  return commentId;
}

function entry(
  kind: StatusEntry["kind"],
  title: string,
  body: string,
): StatusEntry {
  return { kind, title, body, timestamp: nowIso() };
}

/**
 * Iteration / cost progress carried through status-comment writes (TY-291 #3,
 * UX-09). Callers in pre-fix / post-fix populate this from `config` and
 * `state`; callers that have no useful context (crash-recovery,
 * `/restart-review`) omit it so the existing header rows are preserved.
 */
export interface IterationProgress {
  /** Current iteration count (post-increment, matches `state.iterationCount`). */
  iterationCount: number;
  /** Configured cap (`config.maxReviewIterations`). */
  maxIterations: number;
  /** Tier of the most recent repair iteration; `null` when no iteration has run yet. */
  lastModelTier: "base" | "escalated" | null;
}

function progressUpdate(progress: IterationProgress | undefined): StatusUpdate {
  if (progress === undefined) return {};
  return {
    iterationCount: progress.iterationCount,
    maxIterations: progress.maxIterations,
    lastModelTier: progress.lastModelTier,
  };
}

/**
 * Derives the iteration progress headers from the hidden `ReviewState` and the
 * configured cap. Callers in pre-fix / post-fix use this to pass consistent
 * progress info into `postClaudeCodeActionFixSummary` / `postCompletionComment`
 * / `postStopComment` without having to remember which fields live where.
 *
 * Legacy state pre-TY-243 may have `modelTier === undefined` on history
 * entries; surface that as `escalated` to match `loop-detector.ts` (TY-243)
 * rather than `null`, so the visible header reflects the conservative tier
 * the loop detector has assumed all along.
 */
export function deriveIterationProgress(
  state: ReviewState,
  maxIterations: number,
): IterationProgress {
  const lastEntry =
    state.findingsHashHistory.length > 0
      ? state.findingsHashHistory[state.findingsHashHistory.length - 1]
      : null;
  return {
    iterationCount: state.iterationCount,
    maxIterations,
    lastModelTier: lastEntry === null ? null : lastEntry.modelTier ?? "escalated",
  };
}

async function applyStatusUpdate(
  owner: string,
  name: string,
  pr: number,
  update: StatusUpdate,
  token: string,
): Promise<number> {
  return upsertStatusComment(owner, name, pr, update, token);
}

/**
 * Operator-imperative next-action text per stop reason (TY-291 #4, UX-11).
 *
 * Surfaced in the status comment `Next action` row when `postStopComment`
 * runs. Together with the TY-292 `STOP_REASON_LABELS` rewrite, the label
 * carries the cause ("max iterations reached") and this string carries the
 * follow-up step ("`/restart-review --hard` to retry"). Keeping them in
 * separate fields avoids the same imperative appearing twice in the same
 * comment, and lets future label tweaks stay decoupled from operator
 * guidance.
 */
export function nextActionForStopReason(reason: StopReason): string {
  switch (reason) {
    case "no_findings":
      return "LoopPilot is complete; merge when ready.";
    case "max_iterations":
      return "Review history, then `/restart-review --hard` to clear the iteration count.";
    case "loop_detected":
      return "Same finding repeated at the escalated tier; review the diff manually before `/restart-review --hard`.";
    case "secret_leak_suspected":
      return "Audit the diff for leaked credentials, then `/restart-review --hard` (soft is rejected).";
    case "scope_violation":
      return "Review the stop detail above for the specific violation; revert if needed, adjust `LOOPPILOT_BLOCK_PATHS` if the path should be unblocked, then `/restart-review`.";
    case "test_failure":
      return "Fix the underlying CHECK_COMMAND failure, push, then `/restart-review`.";
    case "codex_usage_limit":
      return "Wait for the Codex quota to reset, then `/restart-review`.";
    case "codex_request_failed":
      return "Verify Codex auth / connectivity, then `/restart-review`.";
    case "max_turns_exceeded":
      return "`/restart-review` to retry; the next iteration auto-escalates to the higher tier.";
    case "workflow_crashed":
      return "`/restart-review` to resume; add `--hard` if iteration history needs clearing.";
    case "action_no_op":
      return "Review the Codex findings manually; `/restart-review` if you believe the next iteration can resolve them.";
    case "state_corrupted":
    case "state_conflict":
      return "See docs/operations/stop-and-recovery.md for the recovery procedure.";
    case "action_failure":
    case "action_timeout":
      return "Check the workflow run logs, then `/restart-review`.";
  }
}

/**
 * Terminal LoopPilot events (`done` / `stopped` / `init_incomplete`) for
 * which we post an additional top-level PR comment alongside the status
 * comment upsert. Iteration progress events are intentionally excluded — they
 * stay aggregated in the status comment (TY-228 / TY-259).
 */
export type TerminalNotificationKind =
  | { kind: "done"; iterations: number; unparseableComments?: number }
  | { kind: "stopped"; stopReason: StopReason; remainingFindings?: number }
  | { kind: "init_incomplete" };

/**
 * Build the GitHub permalink to a specific issue comment on a PR. Used so
 * terminal notifications can link back to the consolidated status comment
 * for full history.
 */
export function buildStatusCommentPermalink(
  owner: string,
  name: string,
  pr: number,
  statusCommentId: number,
): string {
  return `https://github.com/${owner}/${name}/pull/${pr}#issuecomment-${statusCommentId}`;
}

/**
 * Render the markdown body for a terminal-notification top-level comment.
 * Exported for tests; production code goes through `postTerminalNotification`.
 */
export function buildTerminalNotificationBody(
  kind: TerminalNotificationKind,
  permalink: string,
): string {
  switch (kind.kind) {
    case "done": {
      const lines = [
        `✅ **LoopPilot completed** — no findings remaining (${kind.iterations} iteration${kind.iterations === 1 ? "" : "s"}).`,
      ];
      // BUG-01: when Codex posted inline comments the severity parser could not
      // classify, `filterAndParseComments` drops them and the loop reports
      // `done / no_findings`. Surface the dropped count here (not log-only) so a
      // Codex output-format drift cannot silently report a clean PR while real
      // findings were skipped.
      if (kind.unparseableComments !== undefined && kind.unparseableComments > 0) {
        lines.push(
          "",
          `⚠️ ${kind.unparseableComments} Codex comment(s) could not be parsed for severity and were skipped — review them manually in case a finding was missed (possible Codex output-format drift).`,
        );
      }
      lines.push("", `See the [status comment](${permalink}) for the full history.`);
      return lines.join("\n");
    }
    case "stopped": {
      const label = STOP_REASON_LABELS[kind.stopReason];
      const actionLine =
        kind.remainingFindings !== undefined
          ? `Open in-scope findings remaining: ${kind.remainingFindings}. Manual intervention required.`
          : "Manual intervention required.";
      return [
        `🛑 **LoopPilot stopped** — ${label}.`,
        "",
        actionLine,
        `See the [status comment](${permalink}) for the full history.`,
      ].join("\n");
    }
    case "init_incomplete":
      // TY-293 #3 (UX-10): align the in-process notification with the YAML
      // fail-safe in `looppilot-init.yml` so operators see the same three
      // concrete recovery steps regardless of which path caught the failure.
      // The old single-line text ("Re-run Workflow A or manually post
      // `@codex review`") was abstract enough that operators had to leave
      // GitHub to figure out how to act on it.
      return [
        "⚠️ **LoopPilot init incomplete** — the initial `@codex review` was never posted.",
        "",
        "LoopPilot is not active on this PR until init runs successfully. Either:",
        "- Re-run the Workflow A run from the Actions tab, or",
        "- Re-trigger init by removing and re-adding the gate label (or closing / reopening the PR in full-auto mode).",
        "",
        `See the [status comment](${permalink}) for context.`,
      ].join("\n");
  }
}

/**
 * Best-effort: post a new top-level PR comment summarizing a terminal
 * LoopPilot event. The status comment remains the single source of truth;
 * this helper exists solely to restore GitHub notifications, which `edit`
 * operations on the status comment do not trigger (TY-259).
 *
 * Failures are swallowed with a warning so they never roll back the
 * caller's status-comment upsert. Callers continue to return the status
 * comment ID regardless of whether the notification succeeded.
 */
export async function postTerminalNotification(
  owner: string,
  name: string,
  pr: number,
  statusCommentId: number,
  kind: TerminalNotificationKind,
  token: string,
): Promise<void> {
  try {
    const permalink = buildStatusCommentPermalink(owner, name, pr, statusCommentId);
    const body = buildTerminalNotificationBody(kind, permalink);
    await postComment(owner, name, pr, body, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `[comment-poster] Failed to post terminal notification: ${message}`,
    );
  }
}

/**
 * Reasons `mergeIfChecksPass` (TY-295) declines to auto-merge a PR after
 * `done / no_findings`. Each variant carries the fields needed to render an
 * operator-facing PR comment that explains *why* auto-merge was skipped and
 * *what to do next* — without forcing the operator to dig into the Actions
 * run logs.
 *
 * The eleven skip paths in `mergeIfChecksPass` map onto these seven kinds:
 *   - `transient_error`     — getPrHeadSha (initial / re-read), listWorkflowRuns (×2),
 *                             getPrMergeSha failures
 *   - `head_empty`          — initial HEAD sha read returned empty
 *   - `head_changed`        — PR was force-pushed or had a new commit pushed during the CI wait
 *   - `ci_failed`           — one or more non-self CI runs ended with a failed conclusion
 *   - `timeout_no_runs`     — the wait budget elapsed before any non-self CI run appeared
 *   - `timeout_pending`     — the wait budget elapsed with CI runs still pending
 *   - `merge_sha_unsettled` — the wait budget elapsed with CI green but GitHub never produced a
 *                             merge commit sha (PR likely has base-branch conflicts). Distinct
 *                             from `timeout_pending` so the notification does not contradictorily
 *                             claim "0 runs still pending".
 *   - `merge_call_failed`   — `gh pr merge --auto --squash` itself was rejected (commonly because
 *                             Repository Settings → "Allow auto-merge" is disabled — see TY-288)
 */
export type AutoMergeSkipKind =
  | { kind: "transient_error"; detail: string }
  | { kind: "head_empty" }
  | { kind: "head_changed"; oldSha: string; newSha: string }
  | { kind: "ci_failed"; failures: ReadonlyArray<{ name: string; conclusion: string }> }
  | { kind: "timeout_no_runs"; timeoutMinutes: number }
  | { kind: "timeout_pending"; timeoutMinutes: number; pending: ReadonlyArray<string> }
  | { kind: "merge_sha_unsettled"; timeoutMinutes: number }
  | { kind: "merge_call_failed"; detail: string }
  // BUG-01 follow-up: not emitted by `mergeIfChecksPass`. Pre-fix posts this
  // (instead of calling the merger at all) when the `done / no_findings` result
  // is based on a review where some Codex comments could not be parsed for
  // severity — auto-merging an uncertain "clean" result would defeat the manual
  // review the dropped comments warrant.
  | { kind: "unparseable_findings"; count: number };

/**
 * Marker prefix used by every auto-merge skip notification. Operators can
 * grep for it, and the dedup query in `recentAutoMergeSkipExists` uses the
 * same prefix to recognise its own past output.
 */
export const AUTO_MERGE_SKIP_PREFIX = "⏸️ **Auto-merge skipped**";

/**
 * TY-295 / TY-282 #2B: dedup window for the auto-merge skip notification.
 * A second invocation within this window suppresses the post; on API
 * failure we fall open so a missed dedup is better than a missed signal.
 */
const AUTO_MERGE_SKIP_DEDUP_WINDOW_MS = 90 * 1000;

/**
 * Render the markdown body for an auto-merge skip notification. Exported
 * for tests; production code goes through `postAutoMergeSkipNotification`.
 */
export function buildAutoMergeSkipBody(
  kind: AutoMergeSkipKind,
  runUrl: string,
): string {
  switch (kind.kind) {
    case "ci_failed":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — ${kind.failures.length} CI run(s) failed:`,
        "",
        ...kind.failures.map((f) => `- \`${f.name}\` (\`${f.conclusion}\`)`),
        "",
        "LoopPilot completed cleanly but other CI checks did not pass. Resolve the failing checks and merge manually, or push a fix to re-run.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "timeout_pending":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — timed out after ${kind.timeoutMinutes} min waiting for CI to complete.`,
        "",
        `${kind.pending.length} CI run(s) still pending: ${kind.pending.map((n) => `\`${n}\``).join(", ")}.`,
        "",
        "Wait for CI to finish and merge manually, or bump `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` if your CI is consistently slow.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "merge_sha_unsettled":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — timed out after ${kind.timeoutMinutes} min: CI on HEAD is green but GitHub has not produced a merge commit for this PR.`,
        "",
        "GitHub reports no merge commit sha while a PR is unmergeable, so this usually means the PR has conflicts with its base branch (or mergeability is still being computed). Resolve the conflicts (or wait for mergeability to settle) and merge manually.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "timeout_no_runs":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — timed out after ${kind.timeoutMinutes} min waiting for any non-self CI run to appear.`,
        "",
        "Either this repository has no CI configured (in which case auto-merge will not happen at this threshold), or CI runs are queued but not visible to the GitHub API. Merge manually after confirming CI status.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "head_changed":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — PR HEAD changed during CI wait (\`${kind.oldSha}\` → \`${kind.newSha}\`).`,
        "",
        "The new commit needs its own review/CI cycle. Use `/restart-review` to resume LoopPilot on the latest HEAD.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "head_empty":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — PR HEAD sha is empty (PR may have been deleted or force-pushed to nothing).`,
        "",
        "Investigate the PR state manually.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "transient_error":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — transient error: ${kind.detail}.`,
        "",
        "This is usually a temporary GitHub API issue. Retry by re-running the workflow, or merge manually if CI is green.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "merge_call_failed":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — \`gh pr merge\` was rejected: ${kind.detail}.`,
        "",
        "Most common cause: Repository Settings → General → \"Allow auto-merge\" is disabled (TY-288). Enable it and re-run, or merge manually. Branch protection rules can also reject the merge — check the workflow run logs for the exact gh error.",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
    case "unparseable_findings":
      return [
        `${AUTO_MERGE_SKIP_PREFIX} — ${kind.count} Codex comment(s) could not be parsed for severity.`,
        "",
        "LoopPilot found no parseable findings, but because some Codex comments could not be classified this \"clean\" result is uncertain. Auto-merge was withheld. Review the unparseable comment(s) manually and merge if appropriate (possible Codex output-format drift).",
        "",
        `Workflow run: ${runUrl}`,
      ].join("\n");
  }
}

/**
 * Best-effort dedup check (TY-282 #2B pattern). Returns true if any
 * `${AUTO_MERGE_SKIP_PREFIX}` comment exists on the PR within the last
 * `AUTO_MERGE_SKIP_DEDUP_WINDOW_MS`. On API failure returns false
 * (fall-open) so a transient error doesn't permanently suppress
 * notifications.
 */
async function recentAutoMergeSkipExists(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<boolean> {
  try {
    const sinceIso = new Date(
      Date.now() - AUTO_MERGE_SKIP_DEDUP_WINDOW_MS,
    ).toISOString();
    const stdout = await ghApi(
      [
        "api",
        // TY-310 #1: `--paginate` walks every comment in the `since=` window.
        // The old `per_page=30` (no pagination) returned only the *oldest* 30
        // comments — GitHub serves issue comments in ascending chronological
        // order — so on a high-traffic PR the most recent skip comment we want
        // to dedup against could fall outside the page, silently bypassing
        // dedup and emitting a duplicate notification. `since=` already bounds
        // the range, so no `per_page` is needed.
        `repos/${owner}/${name}/issues/${pr}/comments?since=${encodeURIComponent(sinceIso)}`,
        "--paginate",
        "--jq",
        ".[].body",
      ],
      token,
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith(AUTO_MERGE_SKIP_PREFIX)) return true;
    }
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `[comment-poster] Auto-merge skip dedup query failed (fall-open): ${message}`,
    );
    return false;
  }
}

/**
 * Post a top-level PR comment explaining why `mergeIfChecksPass` declined
 * to auto-merge. Best-effort: on dedup hit (recent identical-prefix
 * comment within 90s) or post failure, the function returns without
 * throwing so the merger's existing skip-with-warning behavior is
 * preserved (TY-295).
 */
export async function postAutoMergeSkipNotification(
  owner: string,
  name: string,
  pr: number,
  kind: AutoMergeSkipKind,
  runUrl: string,
  token: string,
): Promise<void> {
  try {
    if (await recentAutoMergeSkipExists(owner, name, pr, token)) {
      core.info(
        `[comment-poster] Suppressing duplicate auto-merge skip notification for PR #${pr} (within ${AUTO_MERGE_SKIP_DEDUP_WINDOW_MS / 1000}s window).`,
      );
      return;
    }
    const body = buildAutoMergeSkipBody(kind, runUrl);
    await postComment(owner, name, pr, body, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `[comment-poster] Failed to post auto-merge skip notification: ${message}`,
    );
  }
}

/**
 * Records a successful claude-code-action repair iteration in the PR's
 * LoopPilot status comment (creating it if missing). Returns the status
 * comment's ID.
 *
 * TY-291 #1 (UX-04): post-fix calls this after committing + pushing the repair
 * but before the hidden state has transitioned to `waiting_codex` and before
 * the @codex re-review request is posted. The visible `Current` text must
 * therefore describe the in-progress transition ("queuing Codex re-review")
 * rather than claiming the review is already waiting — if the subsequent state
 * update or review request fails, the status comment would otherwise show a
 * false "Waiting for Codex review" while the hidden state is still `fixing`
 * and no re-review has been queued.
 */
export async function postClaudeCodeActionFixSummary(
  owner: string,
  name: string,
  pr: number,
  iteration: number,
  changedPaths: string[],
  lastCommit: string | null | undefined,
  token: string,
  progress?: IterationProgress,
): Promise<number> {
  const fileLines =
    changedPaths.length > 0
      ? changedPaths.map((path) => `- \`${path}\``).join("\n")
      : "_(no files changed)_";

  return applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: `Fix committed (iteration ${iteration}) — queuing Codex re-review`,
      nextAction:
        "Codex re-review is being queued; no operator action needed.",
      lastCommit,
      ...progressUpdate(progress),
      newEntry: entry(
        "auto_fix_applied",
        `Iteration ${iteration} — Auto-fix applied`,
        fileLines,
      ),
    },
    token,
  );
}

/**
 * Marks the LoopPilot as completed in the PR's status comment. Returns the
 * status comment's ID.
 *
 * TY-291 #4 (UX-11): `nextAction` branches on `autoMergeOnClean` so the row
 * carries an imperative the operator can act on (merge / wait for auto-merge)
 * instead of restating that LoopPilot is done.
 */
export async function postCompletionComment(
  owner: string,
  name: string,
  pr: number,
  iterations: number,
  token: string,
  options?: {
    autoMergeOnClean?: boolean;
    progress?: IterationProgress;
    /**
     * BUG-01: count of Codex inline comments whose severity the parser could
     * not classify (`skipped.unparseable`). When > 0 the completion comment
     * surfaces a caution so an all-unparseable review (Codex format drift) is
     * not silently reported as a clean `done`. The state transition is
     * unchanged — this only adds operator-visible context.
     */
    unparseableComments?: number;
  },
): Promise<number> {
  const autoMergeOnClean = options?.autoMergeOnClean ?? false;
  const unparseableComments = options?.unparseableComments ?? 0;
  // When unparseable comments are present, auto-merge is withheld (main-pre-fix
  // calls postAutoMergeSkipNotification instead of mergeIfChecksPass), so the
  // nextAction must always instruct manual merge in that case regardless of the
  // autoMergeOnClean setting.
  const baseNextAction =
    autoMergeOnClean && unparseableComments === 0
      ? "Auto-merge will be attempted — the PR will squash-merge once all other CI checks pass; merge manually if it does not."
      : "Review the changes and merge manually.";
  const nextAction =
    unparseableComments > 0
      ? `${unparseableComments} Codex comment(s) could not be parsed for severity and were skipped — review them manually before relying on this result. ${baseNextAction}`
      : baseNextAction;
  const completionBody =
    unparseableComments > 0
      ? `All parseable in-scope findings (at or above the configured severity threshold) have been resolved.\n\n⚠️ ${unparseableComments} Codex comment(s) could not be parsed for severity and were skipped — review them manually in case a finding was missed (possible Codex output-format drift).`
      : "All in-scope findings (at or above the configured severity threshold) have been resolved.";
  const statusCommentId = await applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: "Completed",
      openFindings: 0,
      nextAction,
      ...progressUpdate(options?.progress),
      newEntry: entry(
        "completed",
        `LoopPilot completed (${iterations} iterations)`,
        completionBody,
      ),
    },
    token,
  );
  await postTerminalNotification(
    owner,
    name,
    pr,
    statusCommentId,
    {
      kind: "done",
      iterations,
      unparseableComments: unparseableComments > 0 ? unparseableComments : undefined,
    },
    token,
  );
  return statusCommentId;
}

/**
 * Records a stop event in the PR's status comment. Returns the status
 * comment's ID.
 *
 * @param stopReason - The reason automation was stopped
 * @param reviewId - The ID of the last processed Codex review comment
 * @param remainingFindings - Count of open in-scope findings (at or above the
 *                            configured severity threshold) at the time of stopping
 * @param detail - Additional detail about why automation stopped
 */
export async function postStopComment(
  owner: string,
  name: string,
  pr: number,
  stopReason: StopReason,
  reviewId: number,
  remainingFindings: number,
  detail: string,
  token: string,
  progress?: IterationProgress,
): Promise<number> {
  const formattedReason = STOP_REASON_LABELS[stopReason];
  const body = [
    `Reason: ${formattedReason}`,
    `Last processed Codex review: #${reviewId}`,
    `Open in-scope findings remaining: ${remainingFindings}`,
    `Detail: ${detail}`,
  ].join("\n");

  const statusCommentId = await applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: `Stopped — ${formattedReason}`,
      openFindings: remainingFindings,
      // TY-291 #4 (UX-11): stopReason-specific imperative replaces the generic
      // "Manual intervention required." line so the row tells the operator
      // exactly which recovery command to run.
      nextAction: nextActionForStopReason(stopReason),
      ...progressUpdate(progress),
      newEntry: entry("stopped", `Automation stopped — ${formattedReason}`, body),
    },
    token,
  );
  await postTerminalNotification(
    owner,
    name,
    pr,
    statusCommentId,
    { kind: "stopped", stopReason, remainingFindings },
    token,
  );
  return statusCommentId;
}

/**
 * Records a CHECK_COMMAND failure in the PR's status comment. The fix
 * changes are rolled back before this entry is added. Returns the status
 * comment's ID.
 *
 * @param checkOutput - The stdout/stderr output from the failed check command
 */
export async function postTestFailureComment(
  owner: string,
  name: string,
  pr: number,
  checkOutput: string,
  token: string,
  progress?: IterationProgress,
): Promise<number> {
  // TY-275 #8: pick a backtick fence longer than ANY backtick / tilde run in
  // the payload. GitHub Markdown treats both `` ``` `` and `~~~` as code-fence
  // openers, so a payload containing either could escape the outer fence and
  // start interpreting CHECK_COMMAND output as markdown (headings, lists,
  // links pulling images). Following the same nonce-fence pattern as
  // `serializeStatusComment` keeps the output safely opaque.
  //
  // Cap (Codex review on PR #95, r3257188563): if the raw payload contains
  // a backtick / tilde run longer than `MAX_FENCE_RUN_CHARS`, GitHub's
  // 65,536-char comment body limit can be blown out by two ~60k-char
  // fences. Truncate over-long runs in the payload BEFORE computing the
  // fence so neither the fence nor the body explodes. CHECK_COMMAND output
  // with 100+ consecutive backticks is pathological (binary garbage,
  // adversarial test output); collapsing it preserves the ability to post
  // the stop comment at all, which is the higher-value invariant.
  const MAX_FENCE_RUN_CHARS = 100;
  const cappedRun = (ch: "`" | "~"): RegExp =>
    new RegExp(`${ch === "`" ? "`" : "~"}{${MAX_FENCE_RUN_CHARS + 1},}`, "g");
  const truncatedPayload = checkOutput
    .replace(cappedRun("`"), "`".repeat(MAX_FENCE_RUN_CHARS))
    .replace(cappedRun("~"), "~".repeat(MAX_FENCE_RUN_CHARS));
  const runs: number[] = [];
  for (const m of truncatedPayload.matchAll(/`+|~+/g)) {
    runs.push(m[0].length);
  }
  const longestRun = runs.length === 0 ? 2 : Math.max(...runs);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = `${fence}\n${truncatedPayload}\n${fence}\n\nChanges have been rolled back.`;

  return applyStatusUpdate(
    owner,
    name,
    pr,
    {
      // TY-291 #4 (UX-11): align with the post-TY-292 test_failure label and
      // share the stopReason-specific imperative with `postStopComment` so the
      // status row and the eventual top-level notification agree on the
      // recovery step.
      current: `Stopped — ${STOP_REASON_LABELS.test_failure}`,
      nextAction: nextActionForStopReason("test_failure"),
      ...progressUpdate(progress),
      newEntry: entry(
        "test_failure",
        "Auto-fix stopped: CHECK_COMMAND failed",
        body,
      ),
    },
    token,
  );
}

/**
 * Creates the initial LoopPilot status comment when Workflow A completes
 * successfully (TY-291 #2, UX-05). Without this hook the PR has no visible
 * status comment until the first post-fix iteration commits — operators can
 * not tell from the PR alone whether the loop is running, especially during
 * the 5-15 minute window before Codex returns its first review. Returns the
 * status comment's ID.
 */
export async function postInitialStatusComment(
  owner: string,
  name: string,
  pr: number,
  maxIterations: number,
  token: string,
): Promise<number> {
  return applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: "Initialized — waiting for first Codex review",
      nextAction:
        "Codex will reply to the `@codex review` request above; no operator action needed.",
      openFindings: null,
      iterationCount: 0,
      maxIterations,
      lastModelTier: null,
    },
    token,
  );
}

/**
 * Refreshes the status comment when pre-fix transitions into `fixing`
 * (TY-291 #2, UX-05). Without this update the visible `Current` row stays on
 * the previous iteration's value while claude-code-action runs for several
 * minutes — operators glancing at the PR would see "Waiting for Codex
 * review" even though the repair has already started. Returns the status
 * comment's ID.
 */
export async function postFixingStartComment(
  owner: string,
  name: string,
  pr: number,
  iteration: number,
  modelTier: "base" | "escalated",
  maxIterations: number,
  openFindings: number,
  token: string,
): Promise<number> {
  return applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: `Fixing — iteration ${iteration} starting (model: ${modelTier})`,
      nextAction:
        "Claude Code Action is running; no operator action needed.",
      iterationCount: iteration,
      maxIterations,
      lastModelTier: modelTier,
      openFindings,
    },
    token,
  );
}

/**
 * Records a Workflow A initialization failure in the PR's status comment,
 * prompting the user to re-run or manually post the review request. Returns
 * the status comment's ID.
 */
export async function postInitIncompleteComment(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<number> {
  const statusCommentId = await applyStatusUpdate(
    owner,
    name,
    pr,
    {
      // TY-293 #3 (UX-10): same three operator actions as the YAML fail-safe
      // in `looppilot-init.yml` and the in-process top-level notification
      // (`buildTerminalNotificationBody.init_incomplete`). Keeping the
      // language identical across the three surfaces lets operators recognise
      // the failure mode regardless of which path posted the comment.
      current: "Init incomplete — initial `@codex review` not posted",
      nextAction:
        "Re-run Workflow A from the Actions tab, or remove and re-add the gate label.",
      newEntry: entry(
        "init_incomplete",
        "LoopPilot initialization incomplete",
        "Workflow A may have failed before posting the initial `@codex review`. Re-run from the Actions tab, or remove and re-add the gate label (or close / reopen the PR in full-auto mode).",
      ),
    },
    token,
  );
  await postTerminalNotification(
    owner,
    name,
    pr,
    statusCommentId,
    { kind: "init_incomplete" },
    token,
  );
  return statusCommentId;
}

/**
 * Posts a '@codex review' comment to trigger a Codex review on the PR.
 * Returns the numeric ID of the newly created comment.
 *
 * Stays as a separate top-level comment because Codex relies on the trigger
 * comment being its own conversation entry; folding it into the status
 * comment would suppress the trigger.
 */
export async function postCodexReviewRequest(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<number> {
  return postComment(owner, name, pr, "@codex review", token);
}
