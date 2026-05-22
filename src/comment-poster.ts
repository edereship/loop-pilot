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
      return "Auto-review is complete; merge when ready.";
    case "max_iterations":
      return "Review history, then `/restart-review --hard` to clear the iteration count.";
    case "loop_detected":
      return "Same finding repeated at the escalated tier; review the diff manually before `/restart-review --hard`.";
    case "secret_leak_suspected":
      return "Audit the diff for leaked credentials, then `/restart-review --hard` (soft is rejected).";
    case "scope_violation":
      return "Review the stop detail above for the specific violation; revert if needed, adjust `AUTO_REVIEW_BLOCK_PATHS` if the path should be unblocked, then `/restart-review`.";
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
 * Terminal auto-review events (`done` / `stopped` / `init_incomplete`) for
 * which we post an additional top-level PR comment alongside the status
 * comment upsert. Iteration progress events are intentionally excluded — they
 * stay aggregated in the status comment (TY-228 / TY-259).
 */
export type TerminalNotificationKind =
  | { kind: "done"; iterations: number }
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
    case "done":
      return [
        `✅ **Auto-review completed** — no findings remaining (${kind.iterations} iteration${kind.iterations === 1 ? "" : "s"}).`,
        "",
        `See the [status comment](${permalink}) for the full history.`,
      ].join("\n");
    case "stopped": {
      const label = STOP_REASON_LABELS[kind.stopReason];
      const actionLine =
        kind.remainingFindings !== undefined
          ? `Open in-scope findings remaining: ${kind.remainingFindings}. Manual intervention required.`
          : "Manual intervention required.";
      return [
        `🛑 **Auto-review stopped** — ${label}.`,
        "",
        actionLine,
        `See the [status comment](${permalink}) for the full history.`,
      ].join("\n");
    }
    case "init_incomplete":
      return [
        "⚠️ **Auto-review initialization incomplete**",
        "",
        "Re-run Workflow A or manually post `@codex review`.",
        `See the [status comment](${permalink}) for context.`,
      ].join("\n");
  }
}

/**
 * Best-effort: post a new top-level PR comment summarizing a terminal
 * auto-review event. The status comment remains the single source of truth;
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
 * Records a successful claude-code-action repair iteration in the PR's
 * auto-review status comment (creating it if missing). Returns the status
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
 * Marks the auto-review as completed in the PR's status comment. Returns the
 * status comment's ID.
 *
 * TY-291 #4 (UX-11): `nextAction` branches on `autoMergeOnClean` so the row
 * carries an imperative the operator can act on (merge / wait for auto-merge)
 * instead of restating that auto-review is done.
 */
export async function postCompletionComment(
  owner: string,
  name: string,
  pr: number,
  iterations: number,
  token: string,
  options?: { autoMergeOnClean?: boolean; progress?: IterationProgress },
): Promise<number> {
  const autoMergeOnClean = options?.autoMergeOnClean ?? false;
  const nextAction = autoMergeOnClean
    ? "Auto-merge will be attempted — the PR will squash-merge once all other CI checks pass; merge manually if it does not."
    : "Review the changes and merge manually.";
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
        `Auto-review completed (${iterations} iterations)`,
        "All in-scope findings (at or above the configured severity threshold) have been resolved.",
      ),
    },
    token,
  );
  await postTerminalNotification(
    owner,
    name,
    pr,
    statusCommentId,
    { kind: "done", iterations },
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
 * Creates the initial auto-review status comment when Workflow A completes
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
      current: "Init incomplete",
      nextAction: "Re-run Workflow A or manually post '@codex review'.",
      newEntry: entry(
        "init_incomplete",
        "Auto-review initialization incomplete",
        "Workflow A may have failed before posting the initial review request.",
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
