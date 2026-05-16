import { ghApi } from "./gh.js";

export const STATUS_COMMENT_MARKER = "auto-review-status";
const STATUS_COMMENT_OPEN = `<!-- ${STATUS_COMMENT_MARKER} -->`;
const STATUS_COMMENT_DATA_OPEN = `<!-- ${STATUS_COMMENT_MARKER}-data`;
const STATUS_COMMENT_DATA_CLOSE = "-->";
const STATUS_COMMENT_VISIBLE_HEADER = "## Auto-review status";
const MAX_ENTRIES = 30;
// GitHub issue-comment body limit is 65 536 bytes. Each entry body appears
// twice in the rendered comment (visible history + hidden JSON data block), so
// we cap individual bodies to keep the total well within that limit.
const MAX_ENTRY_BODY_LENGTH = 16_000;
const ENTRY_BODY_TRUNCATION_MARKER = "\n\n_(output truncated — exceeded size limit)_";

const GITHUB_COMMENT_BODY_LIMIT = 65_536;

/** History entry kinds; carried in the JSON so future UI variants can pick. */
export type StatusEntryKind =
  | "auto_fix_applied"
  | "completed"
  | "stopped"
  | "test_failure"
  | "init_incomplete";

export interface StatusEntry {
  /** ISO-8601 timestamp at write time; rendered next to the entry title. */
  timestamp: string;
  kind: StatusEntryKind;
  /** Short title rendered as the `### ...` line for the entry. */
  title: string;
  /** Markdown body for the entry. */
  body: string;
}

export interface StatusSnapshot {
  /** One-line "current" summary rendered at the top of the comment. */
  current: string;
  /** Optional last commit SHA (short or full); `null` renders as `—`. */
  lastCommit: string | null;
  /** Open in-scope findings count (severities at or above the configured threshold); `null` renders as `—`. */
  openFindings: number | null;
  /** Suggested next human action. */
  nextAction: string;
  /** Newest entries first; capped at `MAX_ENTRIES`. */
  entries: StatusEntry[];
}

export function createInitialStatusSnapshot(): StatusSnapshot {
  return {
    current: "—",
    lastCommit: null,
    openFindings: null,
    nextAction: "—",
    entries: [],
  };
}

function renderEntry(entry: StatusEntry): string {
  return `### ${entry.title}\n*${entry.timestamp}*\n\n${entry.body}`;
}

function renderStatusCommentBodyUnchecked(snapshot: StatusSnapshot): string {
  const header = [
    STATUS_COMMENT_OPEN,
    STATUS_COMMENT_VISIBLE_HEADER,
    "",
    `**Current**: ${snapshot.current}`,
    `**Last commit**: ${snapshot.lastCommit ?? "—"}`,
    `**Open findings**: ${snapshot.openFindings ?? "—"}`,
    `**Next action**: ${snapshot.nextAction}`,
    "",
  ].join("\n");

  const historyBody =
    snapshot.entries.length === 0
      ? "_(no entries yet)_"
      : snapshot.entries.map(renderEntry).join("\n\n");

  const history = [
    "<details>",
    `<summary>History (${snapshot.entries.length} ${snapshot.entries.length === 1 ? "entry" : "entries"})</summary>`,
    "",
    historyBody,
    "",
    "</details>",
    "",
  ].join("\n");

  const data = [
    STATUS_COMMENT_DATA_OPEN,
    JSON.stringify(snapshot).replace(/-->/g, "--\\>"),
    STATUS_COMMENT_DATA_CLOSE,
  ].join("\n");

  return `${header}\n${history}\n${data}\n`;
}

export function renderStatusCommentBody(snapshot: StatusSnapshot): string {
  // Trim oldest entries (last in newest-first array) until the rendered body
  // fits within GitHub's issue-comment character limit.  Each entry appears
  // twice — once in visible history and once inside the JSON data block — so
  // the aggregate size can far exceed per-entry caps alone.
  for (let count = snapshot.entries.length; count >= 0; count--) {
    const effective: StatusSnapshot =
      count === snapshot.entries.length
        ? snapshot
        : { ...snapshot, entries: snapshot.entries.slice(0, count) };
    const body = renderStatusCommentBodyUnchecked(effective);
    if (body.length <= GITHUB_COMMENT_BODY_LIMIT) return body;
  }
  // Fallback: render with zero entries (header alone is always under the limit).
  return renderStatusCommentBodyUnchecked({ ...snapshot, entries: [] });
}

/**
 * Parse a status comment body back into its `StatusSnapshot`. Returns `null`
 * when the body is missing the data marker or has corrupted JSON. The hidden
 * JSON block is the source of truth — the rendered markdown is regenerated
 * from it on every update.
 */
export function parseStatusCommentBody(body: string): StatusSnapshot | null {
  // Scan forward through every occurrence of STATUS_COMMENT_DATA_OPEN and
  // keep the last one that yields a valid StatusSnapshot.  The data block is
  // always the final structural element, so the last successful parse is the
  // authoritative snapshot.  This correctly skips false matches inside:
  //   • visible history entry bodies (e.g. an entry whose output contains the
  //     marker string or the literal "</details>"), and
  //   • the JSON payload itself (when an entry body repeats the marker string,
  //     that string is serialised verbatim inside the JSON object).
  let result: StatusSnapshot | null = null;
  let searchFrom = 0;
  while (true) {
    const dataStart = body.indexOf(STATUS_COMMENT_DATA_OPEN, searchFrom);
    if (dataStart === -1) break;
    const afterOpen = body.slice(dataStart + STATUS_COMMENT_DATA_OPEN.length);
    const closeIdx = afterOpen.indexOf(STATUS_COMMENT_DATA_CLOSE);
    if (closeIdx !== -1) {
      const jsonRaw = afterOpen.slice(0, closeIdx).trim().replace(/--\\>/g, "-->");
      try {
        const parsed: unknown = JSON.parse(jsonRaw);
        if (isStatusSnapshot(parsed)) result = parsed;
      } catch {
        // not valid JSON at this position; continue to the next occurrence
      }
    }
    searchFrom = dataStart + 1;
  }
  return result;
}

function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.current !== "string") return false;
  if (v.lastCommit !== null && typeof v.lastCommit !== "string") return false;
  if (v.openFindings !== null && typeof v.openFindings !== "number") return false;
  if (typeof v.nextAction !== "string") return false;
  if (!Array.isArray(v.entries)) return false;
  for (const e of v.entries) {
    if (typeof e !== "object" || e === null) return false;
    const en = e as Record<string, unknown>;
    if (typeof en.timestamp !== "string") return false;
    if (typeof en.title !== "string") return false;
    if (typeof en.body !== "string") return false;
    if (
      en.kind !== "auto_fix_applied" &&
      en.kind !== "completed" &&
      en.kind !== "stopped" &&
      en.kind !== "test_failure" &&
      en.kind !== "init_incomplete"
    )
      return false;
  }
  return true;
}

export interface StatusUpdate {
  /** Optional next snapshot header fields. Each undefined field is preserved. */
  current?: string;
  lastCommit?: string | null;
  openFindings?: number | null;
  nextAction?: string;
  /** Optional entry to prepend to history (newest first). */
  newEntry?: StatusEntry;
}

function capEntryBody(body: string): string {
  if (body.length <= MAX_ENTRY_BODY_LENGTH) return body;
  return (
    body.slice(0, MAX_ENTRY_BODY_LENGTH - ENTRY_BODY_TRUNCATION_MARKER.length) +
    ENTRY_BODY_TRUNCATION_MARKER
  );
}

/**
 * Apply an update on top of an existing snapshot. Pure function; trims the
 * history at `MAX_ENTRIES`.
 */
export function applyStatusUpdate(
  snapshot: StatusSnapshot,
  update: StatusUpdate,
): StatusSnapshot {
  const cappedEntry = update.newEntry
    ? { ...update.newEntry, body: capEntryBody(update.newEntry.body) }
    : undefined;
  const entries = cappedEntry
    ? [cappedEntry, ...snapshot.entries].slice(0, MAX_ENTRIES)
    : snapshot.entries;
  return {
    current: update.current ?? snapshot.current,
    lastCommit:
      update.lastCommit === undefined ? snapshot.lastCommit : update.lastCommit,
    openFindings:
      update.openFindings === undefined
        ? snapshot.openFindings
        : update.openFindings,
    nextAction: update.nextAction ?? snapshot.nextAction,
    entries,
  };
}

interface StatusCommentRecord {
  id: number;
  body: string;
}

function isStatusCommentRecord(value: unknown): value is StatusCommentRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "number" && typeof v.body === "string";
}

/**
 * Find an existing status comment on the PR, or return `null`. Identified by
 * presence of `STATUS_COMMENT_MARKER` in the body header.
 */
export async function findStatusComment(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<StatusCommentRecord | null> {
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select(.body | startswith("${STATUS_COMMENT_OPEN}")) | {id: .id, body: .body} | @json`,
    ],
    token,
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // If duplicates exist, take the newest (last line; gh paginate returns ascending).
  const lines = trimmed.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      // `@json` in jq produces a JSON-encoded string; unwrap one level if needed.
      const value =
        typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed;
      if (isStatusCommentRecord(value)) return value;
    } catch {
      continue;
    }
  }
  return null;
}

async function createStatusCommentImpl(
  owner: string,
  name: string,
  pr: number,
  body: string,
  token: string,
): Promise<number> {
  const stdout = await ghApi(
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
    token,
  );
  const id = parseInt(stdout.trim(), 10);
  if (Number.isNaN(id)) {
    throw new Error(
      `createStatusComment: unexpected response from GitHub API: ${stdout.trim()}`,
    );
  }
  return id;
}

async function updateStatusCommentImpl(
  owner: string,
  name: string,
  commentId: number,
  body: string,
  token: string,
): Promise<void> {
  await ghApi(
    [
      "api",
      "--method",
      "PATCH",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    token,
  );
}

export interface UpsertStatusCommentDeps {
  findStatusComment: typeof findStatusComment;
  createStatusComment: (
    owner: string,
    name: string,
    pr: number,
    body: string,
    token: string,
  ) => Promise<number>;
  updateStatusComment: (
    owner: string,
    name: string,
    commentId: number,
    body: string,
    token: string,
  ) => Promise<void>;
}

const defaultDeps: UpsertStatusCommentDeps = {
  findStatusComment,
  createStatusComment: createStatusCommentImpl,
  updateStatusComment: updateStatusCommentImpl,
};

/**
 * Find-or-create the auto-review status comment and apply `update`. When the
 * comment already exists, the previous snapshot is parsed from its hidden
 * JSON block and merged with `update` before rewriting the body. Returns the
 * comment ID so callers can correlate logs / tests.
 */
export async function upsertStatusComment(
  owner: string,
  name: string,
  pr: number,
  update: StatusUpdate,
  token: string,
  deps: UpsertStatusCommentDeps = defaultDeps,
): Promise<number> {
  const existing = await deps.findStatusComment(owner, name, pr, token);
  if (existing === null) {
    const snapshot = applyStatusUpdate(createInitialStatusSnapshot(), update);
    const body = renderStatusCommentBody(snapshot);
    return deps.createStatusComment(owner, name, pr, body, token);
  }
  const previousSnapshot =
    parseStatusCommentBody(existing.body) ?? createInitialStatusSnapshot();
  const snapshot = applyStatusUpdate(previousSnapshot, update);
  const body = renderStatusCommentBody(snapshot);
  await deps.updateStatusComment(owner, name, existing.id, body, token);
  return existing.id;
}
