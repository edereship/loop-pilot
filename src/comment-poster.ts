import { ghApi } from "./gh.js";
import type { StopReason } from "./types.js";

const STOP_REASON_LABELS: Record<StopReason, string> = {
  no_findings: "no P0/P1/P2 findings",
  max_iterations: "reached max iterations (MAX_REVIEW_ITERATIONS)",
  loop_detected: "same findings detected in loop",
  claude_api_error: "Claude API error",
  test_failure: "CHECK_COMMAND failed after fix",
  manual_stop: "manual stop requested",
  state_corrupted: "hidden comment state corrupted",
  state_conflict: "hidden comment state changed concurrently",
  action_timeout: "Claude Code Action workflow timeout",
  action_failure: "Claude Code Action exited with a non-zero status",
  scope_violation: "repair touched paths or exceeded the size budget allowed for auto-fix",
  max_turns_exceeded: "Claude Code Action exhausted the configured --max-turns budget",
  codex_usage_limit: "Codex reported usage / quota limits; no review was performed",
};

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
      "-X",
      "POST",
      "-f",
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

/**
 * Posts a summary comment after a successful claude-code-action repair iteration.
 */
export async function postClaudeCodeActionFixSummary(
  owner: string,
  name: string,
  pr: number,
  iteration: number,
  changedPaths: string[],
  token: string,
): Promise<number> {
  const fileLines =
    changedPaths.length > 0
      ? changedPaths.map((path) => `- \`${path}\``).join("\n")
      : "_(no files changed)_";

  const body = `**Auto-fix applied (iteration ${iteration})**\n\n${fileLines}`;

  return postComment(owner, name, pr, body, token);
}

/**
 * Posts a completion comment when all P0/P1/P2 findings have been resolved.
 */
export async function postCompletionComment(
  owner: string,
  name: string,
  pr: number,
  iterations: number,
  token: string,
): Promise<number> {
  const body = `Auto-review completed.\n\nIterations: ${iterations}\nAll P0/P1/P2 findings have been resolved.`;

  return postComment(owner, name, pr, body, token);
}

/**
 * Posts a stop comment when automation is halted for a specific reason.
 *
 * @param stopReason - The reason automation was stopped
 * @param reviewId - The ID of the last processed Codex review comment
 * @param remainingFindings - Count of open P0/P1/P2 findings at the time of stopping
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
    "Automation stopped.",
    "",
    `Reason: ${formattedReason}`,
    `Last processed Codex review: #${reviewId}`,
    `Open P0/P1/P2 findings remaining: ${remainingFindings}`,
    `Detail: ${detail}`,
    "Recommendation: manual intervention required.",
  ].join("\n");

  return postComment(owner, name, pr, body, token);
}

/**
 * Posts a comment when the CHECK_COMMAND fails after a fix is applied.
 * The fix changes are rolled back before this comment is posted.
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
  // Escape triple-backtick sequences in output to prevent Markdown code fence breakout
  const safeOutput = checkOutput.replace(/`{3,}/g, "``");
  const body = `**Auto-fix stopped: CHECK_COMMAND failed**\n\n\`\`\`\n${safeOutput}\n\`\`\`\n\nChanges have been rolled back. Manual intervention required.`;

  return postComment(owner, name, pr, body, token);
}

/**
 * Posts a comment when Workflow A did not complete initialization,
 * prompting the user to re-run or manually post the review request.
 */
export async function postInitIncompleteComment(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<number> {
  const body =
    "Auto-review initialization incomplete. Workflow A may have failed before posting the initial review request. Please re-run Workflow A or manually post '@codex review'.";

  return postComment(owner, name, pr, body, token);
}

/**
 * Posts a '@codex review' comment to trigger a Codex review on the PR.
 * Returns the numeric ID of the newly created comment.
 */
export async function postCodexReviewRequest(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<number> {
  return postComment(owner, name, pr, "@codex review", token);
}
