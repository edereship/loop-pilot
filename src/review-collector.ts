import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as core from "@actions/core";
import { parseSeverity } from "./severity-parser.js";
import { buildGhEnv } from "./gh-env.js";
import type { FetchReviewCommentsFn, Finding, RawReviewComment, SleepFn } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — default 1 MB is insufficient for large PRs

export interface StabilizeReviewCommentsOptions {
  botLogin: string;
  lastReceivedAt: string | null;
  triggerSummaryBody: string;
  intervalMs: number;
  stablePolls: number;
  maxWaitMs: number;
  fetchComments: FetchReviewCommentsFn;
  sleep: SleepFn;
  log?: (message: string) => void;
}

/**
 * Fetches PR inline review comments from GitHub API using the gh CLI.
 *
 * Why NDJSON via --jq: gh's --paginate flag accumulates pages into a single
 * JSON array by default, which can exhaust memory for large PRs. Streaming
 * one object per line (NDJSON) via .[] | {...} keeps memory usage constant.
 */
export async function fetchReviewComments(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string
): Promise<RawReviewComment[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
      "--paginate",
      "--jq",
      // @json ensures each result is a single-line JSON-encoded string,
      // preventing multi-line jq pretty-printing from breaking split("\n") parsing
      ".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at} | @json",
    ],
    { env: buildGhEnv(githubToken), maxBuffer: MAX_BUFFER }
  );

  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      const parsed = parseReviewCommentRecord(line);
      if (!parsed) {
        core.warning(`[review-collector] Skipping unparseable comment line: ${line.slice(0, 120)}`);
        return [];
      }
      return [parsed];
    });
}

export function parseReviewCommentRecord(line: string): RawReviewComment | null {
  function isRecord(value: unknown): value is RawReviewComment {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    const user = record.user as Record<string, unknown> | null;
    return (
      typeof record.id === "number" &&
      typeof user === "object" &&
      user !== null &&
      typeof user.login === "string" &&
      typeof record.body === "string" &&
      typeof record.path === "string" &&
      (typeof record.line === "number" || record.line === null) &&
      typeof record.createdAt === "string"
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
 * Filters raw review comments by bot login and timestamp, parses severity,
 * and returns only P0/P1 findings.
 *
 * Why strict greater-than for timestamp: a comment received exactly at
 * lastReceivedAt was already processed in the previous iteration.
 */
export function filterAndParseComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null
): Finding[] {
  return comments
    .filter((comment) => comment.user.login === botLogin)
    .filter(
      (comment) =>
        lastReceivedAt === null || comment.createdAt > lastReceivedAt
    )
    .flatMap((comment) => {
      const parsed = parseSeverity(comment.body);
      if (parsed.severity !== "P0" && parsed.severity !== "P1") {
        return [];
      }
      const finding: Finding = {
        severity: parsed.severity,
        path: comment.path,
        line: comment.line ?? 0,
        title: parsed.title,
        body: parsed.body,
      };
      return [finding];
    });
}

export function shouldStabilizeReviewComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  triggerSummaryBody: string
): boolean {
  return (
    countRelevantBotComments(comments, botLogin, lastReceivedAt) === 0 &&
    summaryMayContainFindings(triggerSummaryBody)
  );
}

export async function stabilizeReviewComments(
  initialComments: RawReviewComment[],
  options: StabilizeReviewCommentsOptions
): Promise<RawReviewComment[]> {
  const stablePolls = Math.max(1, options.stablePolls);
  const intervalMs = Math.max(1, options.intervalMs);
  const maxWaitMs = Math.max(intervalMs * stablePolls, options.maxWaitMs);

  if (
    !shouldStabilizeReviewComments(
      initialComments,
      options.botLogin,
      options.lastReceivedAt,
      options.triggerSummaryBody
    )
  ) {
    return initialComments;
  }

  let latestComments = initialComments;
  let lastCount = countRelevantBotComments(
    latestComments,
    options.botLogin,
    options.lastReceivedAt
  );
  let stableCount = 0;
  let waitedMs = 0;

  options.log?.(
    `[review-collector] No Codex inline comments yet; waiting for count to stabilize (${stablePolls} polls).`
  );

  while (stableCount < stablePolls && waitedMs < maxWaitMs) {
    await options.sleep(intervalMs);
    waitedMs += intervalMs;

    const nextComments = await options.fetchComments();
    const nextCount = countRelevantBotComments(
      nextComments,
      options.botLogin,
      options.lastReceivedAt
    );

    if (nextCount === lastCount) {
      stableCount += 1;
    } else {
      options.log?.(
        `[review-collector] Codex inline comment count changed ${lastCount} -> ${nextCount}; resetting stabilization count.`
      );
      stableCount = 0;
      lastCount = nextCount;
    }

    latestComments = nextComments;
  }

  options.log?.(
    `[review-collector] Stabilization finished after ${waitedMs}ms with ${lastCount} Codex inline comment(s).`
  );
  return latestComments;
}

function countRelevantBotComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null
): number {
  return comments.filter(
    (comment) =>
      comment.user.login === botLogin &&
      (lastReceivedAt === null || comment.createdAt > lastReceivedAt)
  ).length;
}

function summaryMayContainFindings(body: string): boolean {
  const normalized = body.toLowerCase();
  const noFindingsPatterns = [
    /\bno\s+p0\s*\/\s*p1\s+findings?\b/i,
    /\bno\s+findings?\b/i,
    /\b0\s+findings?\b/i,
    /\bno\s+issues?\b/i,
    /指摘なし/,
    /問題なし/,
  ];
  if (noFindingsPatterns.some((pattern) => pattern.test(body))) {
    return false;
  }

  return (
    /\bp0\b/i.test(body) ||
    /\bp1\b/i.test(body) ||
    /\bfindings?\b/.test(normalized) ||
    /\bissues?\b/.test(normalized) ||
    /指摘|問題|検出/.test(body)
  );
}
