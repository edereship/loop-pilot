import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";
import type { ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

const STATE_MARKER = "auto-review-state";
const STATE_COMMENT_OPEN = "<!-- " + STATE_MARKER;
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
  // previousCheckFailure was added after the initial release; tolerate both
  // missing and explicit-null/string shapes. Missing is normalized to null below.
  if (
    "previousCheckFailure" in s &&
    s.previousCheckFailure !== null &&
    typeof s.previousCheckFailure !== "string"
  ) {
    return false;
  }

  // Validate each hash history entry shape
  for (const entry of s.findingsHashHistory) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.iteration !== "number" || typeof e.hash !== "string") return false;
    // modelTier was added by TY-243. Missing is tolerated for backward
    // compatibility (treated as `"escalated"` by `loop-detector`); present
    // values must be one of the known tiers.
    if (
      "modelTier" in e &&
      e.modelTier !== undefined &&
      e.modelTier !== "base" &&
      e.modelTier !== "escalated"
    ) {
      return false;
    }
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
    previousCheckFailure: null,
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
    // Normalize fields added after the initial release so consumers
    // can rely on them being present (null when absent in old state comments).
    const normalized: ReviewState = {
      ...(parsed as ReviewState),
      previousCheckFailure:
        (parsed as { previousCheckFailure?: string | null }).previousCheckFailure ?? null,
    };
    return normalized;
  } catch {
    return null;
  }
}

export function containsSerializedStateMarker(commentBody: string): boolean {
  // Anchor on the visible header so documentation/linkback comments that quote
  // the marker inline (e.g., inside backticks) are not misidentified as state
  // comments. The marker check defends against the rare case where someone
  // writes a comment that legitimately starts with the visible text.
  return (
    commentBody.startsWith(STATE_COMMENT_VISIBLE_TEXT) &&
    commentBody.includes(STATE_COMMENT_OPEN)
  );
}

export type ReadStateResult =
  | { found: true; corrupted: false; state: ReviewState; commentId: number; commentUpdatedAt: string }
  | { found: false; corrupted: false; commentId: null }
  | { found: false; corrupted: true; commentId: number | null; commentUpdatedAt?: string };

type StateCommentRecord = { id: number; body: string; updatedAt: string };

export interface UpdateStateCommentOptions {
  expectedUpdatedAt?: string;
}

export interface UpdateStateCommentResult {
  updatedAt: string;
}

export class StateUpdateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUpdateConflictError";
  }
}

export function parseStateCommentRecord(line: string): StateCommentRecord | null {
  function isRecord(value: unknown): value is { id: number; body: string; updated_at: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).id === "number" &&
      typeof (value as Record<string, unknown>).body === "string" &&
      typeof (value as Record<string, unknown>).updated_at === "string"
    );
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      return { id: parsed.id, body: parsed.body, updatedAt: parsed.updated_at };
    }
    if (typeof parsed === "string") {
      const nested = JSON.parse(parsed) as unknown;
      if (isRecord(nested)) {
        return { id: nested.id, body: nested.body, updatedAt: nested.updated_at };
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
      // Filter to genuine state comments by anchoring on the visible header.
      // Using `startswith(VISIBLE_TEXT)` rather than the marker line keeps two
      // properties:
      //   1. Comments that merely mention `<!-- auto-review-state` inline
      //      (e.g., the Linear linkback that quotes it in backticks) are
      //      excluded — they do not start with the visible header.
      //   2. State comments where the trailing newline after the marker has
      //      been stripped (manual edits / formatter mangling) are still
      //      surfaced — `deserializeState` then determines whether the JSON
      //      is recoverable, so corruption recovery and `/restart-review` can
      //      proceed instead of silent skip.
      // The additional `contains(MARKER)` guards against the rare case where a
      // user writes a comment that legitimately begins with the visible text
      // but is not a state comment.
      // @json emits each match as a single-line JSON-encoded string so
      // split("\n") parsing below stays correct.
      `.[] | select(.body | startswith("${STATE_COMMENT_VISIBLE_TEXT}")) | select(.body | contains("${STATE_COMMENT_OPEN}")) | {id: .id, body: .body, updated_at: .updated_at} | @json`,
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
    return { found: false, corrupted: true, commentId: parsed.id, commentUpdatedAt: parsed.updatedAt };
  }

  return { found: true, corrupted: false, state, commentId: parsed.id, commentUpdatedAt: parsed.updatedAt };
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
  options: UpdateStateCommentOptions = {},
): Promise<UpdateStateCommentResult> {
  const body = serializeState(state);
  const trimmedState = deserializeState(body);
  if (!trimmedState) {
    throw new Error("updateStateComment: serializeState produced an undeserializable payload");
  }
  const expectedUpdatedAt = options.expectedUpdatedAt;

  if (expectedUpdatedAt !== undefined) {
    const latest = await fetchStateComment(owner, name, commentId, token);
    if (latest.updatedAt !== expectedUpdatedAt) {
      throw new StateUpdateConflictError(
        `Hidden comment updated_at changed before PATCH (expected ${expectedUpdatedAt}, actual ${latest.updatedAt})`,
      );
    }
  }

  const patched = await patchStateComment(owner, name, commentId, body, token, expectedUpdatedAt);
  const patchedState = deserializeState(patched.body);
  if (!patchedState || JSON.stringify(patchedState) !== JSON.stringify(trimmedState)) {
    throw new Error("PATCH response did not contain the expected hidden comment state");
  }

  return { updatedAt: patched.updatedAt };
}

async function fetchStateComment(
  owner: string,
  name: string,
  commentId: number,
  token: string,
): Promise<{ body: string; updatedAt: string }> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--jq",
      "{body: .body, updated_at: .updated_at} | @json",
    ],
    { env: buildGhEnv(token), maxBuffer: MAX_BUFFER },
  );
  return parseCommentSnapshot(stdout.trim(), "fetchStateComment");
}

/**
 * Convert an ISO 8601 timestamp (e.g. `2026-05-14T21:42:19Z`) — the form
 * GitHub's `updated_at` field returns — into the RFC 7231 IMF-fixdate
 * (`Thu, 14 May 2026 21:42:19 GMT`) required by the HTTP
 * `If-Unmodified-Since` header. Passing the raw ISO string makes GitHub
 * reject the PATCH with a 4xx, which propagates as a workflow failure
 * instead of the intended optimistic-lock 412 round-trip.
 */
export function toHttpDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toHttpDate: invalid timestamp ${isoTimestamp}`);
  }
  return date.toUTCString();
}

async function patchStateComment(
  owner: string,
  name: string,
  commentId: number,
  body: string,
  token: string,
  expectedUpdatedAt?: string,
): Promise<{ body: string; updatedAt: string }> {
  const args = [
    "api",
    "--method",
    "PATCH",
    `repos/${owner}/${name}/issues/comments/${commentId}`,
    "--field",
    `body=${body}`,
    "--jq",
    "{body: .body, updated_at: .updated_at} | @json",
  ];

  // Note: TY-139 originally added an `If-Unmodified-Since` header here for
  // server-side conflict detection, but GitHub's issue-comment PATCH does
  // not appear to honour this conditional reliably (real dogfood on PR #33
  // produced a 4xx on every state mutation, leaving the loop deadlocked at
  // `waiting_codex`). The preflight GET in `updateStateComment` still catches
  // the common multi-second race window; if a sub-second TOCTOU race occurs
  // the worst case is one stale write that the next iteration overwrites,
  // not silent corruption. Re-introducing server-side enforcement requires a
  // GitHub mechanism that actually works for this endpoint (e.g. ETag /
  // If-Match if it ever ships).

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", args, { env: buildGhEnv(token), maxBuffer: MAX_BUFFER }));
  } catch (err: unknown) {
    // gh exits non-zero with the API response body on stdout/stderr;
    // surface both so failure modes are visible in the workflow log.
    const errIO = err as { stderr?: unknown; stdout?: unknown; message?: string };
    const stderrText = errIO.stderr ? String(errIO.stderr) : "";
    const stdoutText = errIO.stdout ? String(errIO.stdout) : "";
    const baseMessage = errIO.message ?? (err instanceof Error ? err.message : String(err));
    const fullMessage = [
      baseMessage,
      stderrText && `stderr: ${stderrText.trim()}`,
      stdoutText && `stdout: ${stdoutText.trim()}`,
    ]
      .filter(Boolean)
      .join("\n");

    // Treat 412 as a concurrent-modification signal whether it surfaces in
    // err.message, stderr (gh's HTTP error line), or stdout (response body).
    if (
      expectedUpdatedAt !== undefined &&
      (fullMessage.includes("412") || fullMessage.includes("Precondition Failed"))
    ) {
      throw new StateUpdateConflictError(
        `Hidden comment was modified concurrently (expectedUpdatedAt=${expectedUpdatedAt}): ${fullMessage}`,
      );
    }
    throw new Error(fullMessage);
  }

  return parseCommentSnapshot(stdout.trim(), "patchStateComment");
}

function parseCommentSnapshot(stdout: string, context: string): { body: string; updatedAt: string } {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const value = typeof parsed === "string" ? JSON.parse(parsed) as unknown : parsed;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).body === "string" &&
      typeof (value as Record<string, unknown>).updated_at === "string"
    ) {
      return {
        body: (value as { body: string; updated_at: string }).body,
        updatedAt: (value as { body: string; updated_at: string }).updated_at,
      };
    }
  } catch {
    // Fall through to uniform error below.
  }
  throw new Error(`${context}: unexpected response from GitHub API: ${stdout}`);
}
