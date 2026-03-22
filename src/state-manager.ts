import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);

const STATE_MARKER = "auto-review-state";
const STATE_COMMENT_OPEN = "<!-- " + STATE_MARKER;
const STATE_COMMENT_CLOSE = "-->";
const MAX_HISTORY_ENTRIES = 3;
const MAX_SERIALIZED_BYTES = 65000;

export function createInitialState(): ReviewState {
  return {
    iterationCount: 0,
    lastProcessedReviewId: null,
    lastClaudeCommitSha: null,
    lastCodexRequestCommentId: null,
    lastCodexReviewReceivedAt: null,
    lastFindingsHash: null,
    findingsHashHistory: [],
    status: "initialized",
    stopReason: null,
  };
}

/**
 * Wraps ReviewState JSON in a hidden HTML comment for storage in GitHub PR comments.
 * Trims findingsHashHistory to at most 3 entries (most recent). If the result
 * still exceeds 65000 chars, trims further to 1 entry to stay within GitHub limits.
 */
export function serializeState(state: ReviewState): string {
  const trimmed: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-MAX_HISTORY_ENTRIES),
  };

  const json = JSON.stringify(trimmed, null, 2);
  const candidate =
    STATE_COMMENT_OPEN + "\n" + json + "\n" + STATE_COMMENT_CLOSE;

  if (candidate.length <= MAX_SERIALIZED_BYTES) {
    return candidate;
  }

  // Fall back to 1 history entry if the payload is still too large
  const minimal: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-1),
  };
  const minimalJson = JSON.stringify(minimal, null, 2);
  return STATE_COMMENT_OPEN + "\n" + minimalJson + "\n" + STATE_COMMENT_CLOSE;
}

/**
 * Extracts ReviewState from a GitHub comment body that contains the hidden state marker.
 * Returns null if the marker is absent or the embedded JSON is invalid.
 */
export function deserializeState(commentBody: string): ReviewState | null {
  // Escape special regex chars in the open/close delimiters
  const escapedOpen = STATE_COMMENT_OPEN.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const escapedClose = STATE_COMMENT_CLOSE.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const pattern = new RegExp(
    escapedOpen + "\\n([\\s\\S]*?)\\n" + escapedClose,
  );

  const match = commentBody.match(pattern);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as ReviewState;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads state from GitHub PR issue comments by scanning for the hidden state marker.
 * Uses gh api with --paginate to handle PRs with many comments.
 * Returns null if no state comment is found.
 */
export async function readState(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<{ state: ReviewState; commentId: number } | null> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select(.body | contains("${STATE_COMMENT_OPEN}")) | {id: .id, body: .body}`,
    ],
    { env: { ...process.env, GH_TOKEN: token } },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // --paginate with --jq emits one JSON object per line; take the first match
  const firstLine = trimmed.split("\n")[0];
  let parsed: { id: number; body: string };
  try {
    parsed = JSON.parse(firstLine) as { id: number; body: string };
  } catch {
    return null;
  }

  const state = deserializeState(parsed.body);
  if (!state) {
    return null;
  }

  return { state, commentId: parsed.id };
}

/**
 * Creates a new issue comment on the PR containing the serialized state.
 * Returns the new comment's numeric ID.
 */
export async function createStateComment(
  owner: string,
  name: string,
  pr: number,
  state: ReviewState,
  token: string,
): Promise<number> {
  const body = serializeState(state);
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    { env: { ...process.env, GH_TOKEN: token } },
  );

  const commentId = parseInt(stdout.trim(), 10);
  if (isNaN(commentId)) {
    throw new Error(
      `createStateComment: unexpected response from GitHub API: ${stdout.trim()}`,
    );
  }
  return commentId;
}

/**
 * Updates an existing issue comment with the serialized state via PATCH.
 */
export async function updateStateComment(
  owner: string,
  name: string,
  commentId: number,
  state: ReviewState,
  token: string,
): Promise<void> {
  const body = serializeState(state);
  await execFileAsync(
    "gh",
    [
      "api",
      "--method",
      "PATCH",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--field",
      `body=${body}`,
    ],
    { env: { ...process.env, GH_TOKEN: token } },
  );
}
