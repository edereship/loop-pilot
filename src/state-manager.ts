import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";
import type { ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

const STATE_MARKER = "auto-review-state";
const STATE_COMMENT_OPEN = "<!-- " + STATE_MARKER;
const STATE_COMMENT_OPEN_LINE = STATE_COMMENT_OPEN + "\n";
const STATE_COMMENT_CLOSE = "-->";
const STATE_COMMENT_VISIBLE_TEXT = "Auto-review state is stored in this comment.";
const MAX_HISTORY_ENTRIES = 3;
const MAX_SERIALIZED_BYTES = 65000;
const VALID_STATUSES = new Set(["initialized", "waiting_codex", "fixing", "done", "stopped"]);

/**
 * Runtime validation for deserialized state to prevent state tampering
 * via maliciously crafted PR comment bodies.
 *
 * All fields consumed downstream are validated to their expected types.
 * Nullable fields must be either the correct type or null.
 */
function validateState(obj: unknown): obj is ReviewState {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;

  if (typeof s.iterationCount !== "number" || s.iterationCount < 0) return false;
  if (typeof s.status !== "string" || !VALID_STATUSES.has(s.status)) return false;
  if (!Array.isArray(s.findingsHashHistory)) return false;

  // Validate nullable fields used in downstream comparisons and Date parsing
  if (s.lastProcessedReviewId !== null && typeof s.lastProcessedReviewId !== "number") return false;
  if (s.lastClaudeCommitSha !== null && typeof s.lastClaudeCommitSha !== "string") return false;
  if (s.lastCodexRequestCommentId !== null && typeof s.lastCodexRequestCommentId !== "number") return false;
  if (s.lastCodexReviewReceivedAt !== null && typeof s.lastCodexReviewReceivedAt !== "string") return false;
  if (s.lastFindingsHash !== null && typeof s.lastFindingsHash !== "string") return false;
  if (s.stopReason !== null && typeof s.stopReason !== "string") return false;

  // Validate each hash history entry shape
  for (const entry of s.findingsHashHistory) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.iteration !== "number" || typeof e.hash !== "string") return false;
  }

  return true;
}

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
    STATE_COMMENT_VISIBLE_TEXT + "\n\n" + STATE_COMMENT_OPEN + "\n" + json + "\n" + STATE_COMMENT_CLOSE;

  if (candidate.length <= MAX_SERIALIZED_BYTES) {
    return candidate;
  }

  // Fall back to 1 history entry if the payload is still too large
  const minimal: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-1),
  };
  const minimalJson = JSON.stringify(minimal, null, 2);
  return STATE_COMMENT_VISIBLE_TEXT + "\n\n" + STATE_COMMENT_OPEN + "\n" + minimalJson + "\n" + STATE_COMMENT_CLOSE;
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
    const parsed = JSON.parse(match[1]);
    if (!validateState(parsed)) {
      return null;
    }
    return parsed as ReviewState;
  } catch {
    return null;
  }
}

export function containsSerializedStateMarker(commentBody: string): boolean {
  return commentBody.includes(STATE_COMMENT_OPEN_LINE);
}

export type ReadStateResult =
  | { found: true; corrupted: false; state: ReviewState; commentId: number }
  | { found: false; corrupted: false; commentId: null }
  | { found: false; corrupted: true; commentId: number | null };

export function parseStateCommentRecord(line: string): { id: number; body: string } | null {
  function isRecord(value: unknown): value is { id: number; body: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).id === "number" &&
      typeof (value as Record<string, unknown>).body === "string"
    );
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string") {
      const nested = JSON.parse(parsed) as unknown;
      if (isRecord(nested)) {
        return nested;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Reads state from GitHub PR issue comments by scanning for the hidden state marker.
 * Uses gh api with --paginate to handle PRs with many comments.
 *
 * Returns a discriminated union:
 * - `{ found: true, state, commentId }` — state read successfully
 * - `{ found: false, corrupted: false, commentId: null }` — no hidden comment exists
 * - `{ found: false, corrupted: true, commentId }` — hidden comment exists but JSON is invalid
 */
export async function readState(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<ReadStateResult> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      // @json ensures each result is a single-line JSON-encoded string,
      // preventing multi-line jq pretty-printing from breaking split("\n") parsing
      `.[] | select(.body | contains("${STATE_COMMENT_OPEN_LINE}")) | {id: .id, body: .body} | @json`,
    ],
    { env: buildGhEnv(token), maxBuffer: MAX_BUFFER },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { found: false, corrupted: false, commentId: null };
  }

  // @json wraps each result as a JSON-encoded string on its own line; double-decode to get the object.
  // Take the LAST line: if duplicate state comments exist, the most recent (highest ID) is last
  // because GitHub API returns issue comments in ascending chronological order.
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1];
  const parsed = parseStateCommentRecord(lastLine);
  if (!parsed) {
    return { found: false, corrupted: true, commentId: null };
  }

  const state = deserializeState(parsed.body);
  if (!state) {
    return { found: false, corrupted: true, commentId: parsed.id };
  }

  return { found: true, corrupted: false, state, commentId: parsed.id };
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
    { env: buildGhEnv(token) },
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
    { env: buildGhEnv(token) },
  );
}
