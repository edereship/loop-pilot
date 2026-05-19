import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import {
  PREVIOUS_CHECK_FAILURE_MAX_CHARS,
  truncatePreviousCheckFailure,
} from "./claude-code-repair-request.js";
import type { ReviewState } from "./types.js";

/**
 * Safety-margin upper bound for `previousCheckFailure` length on the read
 * path (TY-275 #9). Writes go through `truncatePreviousCheckFailure` and
 * are capped at `PREVIOUS_CHECK_FAILURE_MAX_CHARS`; a hand-edited or legacy
 * state comment can carry more. We reject anything beyond 2× that cap so
 * downstream `serializeState` cannot blow through the GitHub comment-body
 * limit (65,536 chars) and we surface tampering instead of silently
 * accepting an oversized blob.
 */
const PREVIOUS_CHECK_FAILURE_READ_LIMIT = PREVIOUS_CHECK_FAILURE_MAX_CHARS * 2;

const STATE_MARKER = "auto-review-state";
const STATE_COMMENT_OPEN = "<!-- " + STATE_MARKER;
const STATE_COMMENT_CLOSE = "-->";
const STATE_COMMENT_VISIBLE_TEXT = "Auto-review state is stored in this comment.";
const MAX_HISTORY_ENTRIES = 3;
const MAX_SERIALIZED_BYTES = 65000;
const VALID_STATUSES = new Set(["initialized", "waiting_codex", "fixing", "done", "stopped"]);

// TY-272 #A: trust-boundary author filter for the hidden state comment.
//
// Public PRs let any commenter post a body that contains our hidden state
// marker. The body-only jq filter would happily pick the attacker's comment as
// the "latest" state (gh paginate is ascending, the last match wins) and an
// adversary could stuff `{"status":"done"}` to silently stop auto-review.
//
// State comments are always created by the workflow's `GITHUB_TOKEN` /
// `secrets.AUTO_REVIEW_PUSH_TOKEN`-equivalent identity, so the author is
// `github-actions[bot]` (or whatever bot the deployment runs as). Deployments
// using a GitHub App / machine user may add their own author via the env var
// below; the default still covers the standard `GITHUB_TOKEN` flow.
const DEFAULT_TRUSTED_STATE_AUTHOR = "github-actions[bot]";
const TRUSTED_STATE_AUTHORS_ENV = "AUTO_REVIEW_STATE_COMMENT_AUTHORS";

export function getTrustedStateCommentAuthors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Check the action input first (highest priority) so operators can set the
  // value via a repository variable mapped through the action's
  // `auto-review-state-comment-authors` input without also needing to inject
  // the env var directly. Outside GitHub Actions, core.getInput returns "".
  const fromInput = core.getInput("auto-review-state-comment-authors");
  const raw = fromInput !== "" ? fromInput : (env[TRUSTED_STATE_AUTHORS_ENV] ?? "");
  const parsed = raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  return parsed.length > 0 ? parsed : [DEFAULT_TRUSTED_STATE_AUTHOR];
}

export function buildTrustedAuthorJqFilter(authors: string[]): string {
  // The jq expression must be safe to splice into the larger filter. GitHub
  // usernames are restricted to `[A-Za-z0-9_-]` plus the `[bot]` suffix on bot
  // accounts; no jq metacharacters can appear, but we still validate
  // defensively so a future env-driven author cannot inject jq syntax.
  const safe = authors.filter((a) => /^[A-Za-z0-9_\-]+(?:\[bot\])?$/.test(a));
  if (safe.length === 0) return "false";
  return safe.map((a) => `.user.login == "${a}"`).join(" or ");
}

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

  // TY-275 #5: `typeof Infinity === "number"` and `Number.isInteger(1e308) === true`
  // both pass the naive checks, so a hand-edited state with `Infinity` / `NaN` /
  // `1e308` would slip through and force-trigger `max_iterations` immediately.
  // `Number.isSafeInteger` rejects non-finite, fractional, AND values outside
  // [-2^53+1, 2^53-1] (which `Number.isInteger` accepts).
  if (!Number.isSafeInteger(s.iterationCount) || (s.iterationCount as number) < 0) return false;
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
  // TY-275 #9: writes go through `truncatePreviousCheckFailure` (cap
  // PREVIOUS_CHECK_FAILURE_MAX_CHARS), but a hand-edited or legacy state
  // comment can carry an oversized blob that would push `serializeState`
  // over the 65,536-char GitHub comment-body limit. Reject upstream.
  if (
    typeof s.previousCheckFailure === "string" &&
    s.previousCheckFailure.length > PREVIOUS_CHECK_FAILURE_READ_LIMIT
  ) {
    return false;
  }
  // TY-273 #B4: fixingStartedAt was added after the initial release; tolerate
  // missing and explicit-null/string shapes. Missing is normalized to null
  // below so legacy state comments still satisfy the type.
  if (
    "fixingStartedAt" in s &&
    s.fixingStartedAt !== null &&
    typeof s.fixingStartedAt !== "string"
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
    fixingStartedAt: null,
  };
}

/**
 * `previousCheckFailure` is the largest variable-size field — write-time
 * `truncatePreviousCheckFailure` caps it at `PREVIOUS_CHECK_FAILURE_MAX_CHARS`
 * but legacy / hand-edited state can carry up to `PREVIOUS_CHECK_FAILURE_READ_LIMIT`
 * (2× that cap). When the body is still over `MAX_SERIALIZED_BYTES` after
 * trimming `findingsHashHistory` to one entry, re-truncate
 * `previousCheckFailure` to this smaller budget before giving up on it.
 */
const PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS = 4000;

/**
 * Wraps ReviewState JSON in a hidden HTML comment for storage in GitHub PR comments.
 *
 * The serialized body is bounded by `MAX_SERIALIZED_BYTES` so the eventual
 * `updateStateComment` PATCH never trips GitHub's 65,536-char comment-body
 * limit. The pre-TY-287 fallback only trimmed `findingsHashHistory` to 1
 * entry, leaving a 35,000-char legacy `previousCheckFailure` capable of
 * pushing the minimal body past the limit and crashing pre-fix with a
 * non-actionable `state_corrupted` (the PATCH returns 422, which is not a
 * `StateUpdateConflictError`, so it propagates past `updateStateCommentLocked`).
 *
 * The TY-287 fallback chain (each step only runs when the previous one is
 * still over budget):
 *
 *   1. Trim `findingsHashHistory` to `MAX_HISTORY_ENTRIES` (normal path).
 *   2. Trim history to 1 entry and re-truncate `previousCheckFailure` to
 *      `PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS` using the existing head/tail
 *      `truncatePreviousCheckFailure` helper, which preserves the most
 *      actionable lines (first errors + last assertion).
 *   3. Drop `previousCheckFailure` to `null` so the body shape is bounded
 *      by the remaining fixed-size fields. This is the floor — every other
 *      field is fixed-size or already bounded by `validateState`.
 */
export function serializeState(state: ReviewState): string {
  const wrap = (s: ReviewState): string => {
    const json = JSON.stringify(s, null, 2);
    return (
      STATE_COMMENT_VISIBLE_TEXT +
      "\n\n" +
      STATE_COMMENT_OPEN +
      "\n" +
      json +
      "\n" +
      STATE_COMMENT_CLOSE
    );
  };

  // Step 1: normal path — keep up to MAX_HISTORY_ENTRIES of history.
  const step1: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-MAX_HISTORY_ENTRIES),
  };
  const body1 = wrap(step1);
  if (body1.length <= MAX_SERIALIZED_BYTES) return body1;

  // Step 2: shrink history to 1 entry AND aggressively trim a legacy
  // oversized previousCheckFailure to the fallback budget.
  const step2: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-1),
    previousCheckFailure: state.previousCheckFailure
      ? truncatePreviousCheckFailure(
          state.previousCheckFailure,
          PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS,
        )
      : null,
  };
  const body2 = wrap(step2);
  if (body2.length <= MAX_SERIALIZED_BYTES) return body2;

  // Step 3: pathological floor — drop previousCheckFailure entirely. Every
  // other field is fixed-size (or bounded by validateState upstream), so
  // this guarantees the body fits.
  const step3: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-1),
    previousCheckFailure: null,
  };
  return wrap(step3);
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
      fixingStartedAt:
        (parsed as { fixingStartedAt?: string | null }).fixingStartedAt ?? null,
    };
    return normalized;
  } catch {
    return null;
  }
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
  const authorFilter = buildTrustedAuthorJqFilter(getTrustedStateCommentAuthors());
  const stdout = await ghApi(
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
      // The `.user.login` author filter (TY-272 #A) discards comments posted
      // by anyone other than the trusted writer identity so a third-party
      // commenter on a public PR cannot inject a forged "latest" state.
      // @json emits each match as a single-line JSON-encoded string so
      // split("\n") parsing below stays correct.
      `.[] | select(${authorFilter}) | select(.body | startswith("${STATE_COMMENT_VISIBLE_TEXT}")) | select(.body | contains("${STATE_COMMENT_OPEN}")) | {id: .id, body: .body, updated_at: .updated_at} | @json`,
    ],
    token,
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
  const stdout = await ghApi(
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      // TY-269: see comment-poster.ts; `--raw-field` avoids gh CLI's
      // `@<value>` file-read interpretation for state-comment bodies.
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
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--jq",
      "{body: .body, updated_at: .updated_at} | @json",
    ],
    token,
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
    // TY-269: see comment-poster.ts; `--raw-field` skips gh CLI's `@<value>`
    // file-read interpretation so state-comment bodies cannot be mis-parsed
    // if they ever start with `@`.
    "--raw-field",
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
    stdout = await ghApi(args, token);
  } catch (err: unknown) {
    // `ghApi` always rejects with an Error whose message combines
    // err.message / stderr / stdout, so 412 can surface in any of the three.
    const fullMessage = err instanceof Error ? err.message : String(err);
    if (
      expectedUpdatedAt !== undefined &&
      (fullMessage.includes("412") || fullMessage.includes("Precondition Failed"))
    ) {
      throw new StateUpdateConflictError(
        `Hidden comment was modified concurrently (expectedUpdatedAt=${expectedUpdatedAt}): ${fullMessage}`,
      );
    }
    throw err instanceof Error ? err : new Error(fullMessage);
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
