import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import {
  upsertStatusComment,
  type StatusEntry,
  type StatusUpdate,
} from "./status-comment.js";
import { STOP_REASON_LABELS, type StopReason } from "./types.js";

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
 * Terminal auto-review events (`done` / `stopped` / `init_incomplete`) for
 * which we post an additional top-level PR comment alongside the status
 * comment upsert. Iteration progress events are intentionally excluded — they
 * stay aggregated in the status comment (TY-228 / TY-259).
 */
export type TerminalNotificationKind =
  | { kind: "done"; iterations: number }
  | { kind: "stopped"; stopReason: StopReason; remainingFindings: number }
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
      return [
        `🛑 **Auto-review stopped** — ${label}.`,
        "",
        `Open in-scope findings remaining: ${kind.remainingFindings}. Manual intervention required.`,
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
 */
export async function postClaudeCodeActionFixSummary(
  owner: string,
  name: string,
  pr: number,
  iteration: number,
  changedPaths: string[],
  lastCommit: string | null | undefined,
  token: string,
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
      current: `Fixing — iteration ${iteration} applied`,
      nextAction: "Awaiting next Codex review.",
      lastCommit,
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
 */
export async function postCompletionComment(
  owner: string,
  name: string,
  pr: number,
  iterations: number,
  token: string,
): Promise<number> {
  const statusCommentId = await applyStatusUpdate(
    owner,
    name,
    pr,
    {
      current: "Completed",
      openFindings: 0,
      nextAction: "All in-scope findings (at or above the configured severity threshold) have been resolved.",
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
      nextAction: "Manual intervention required.",
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
      current: "Stopped — CHECK_COMMAND failed after fix",
      nextAction: "Manual intervention required.",
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
