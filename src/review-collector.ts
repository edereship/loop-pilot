import * as core from "@actions/core";
import { isAtLeastSeverity, parseSeverity } from "./severity-parser.js";
import { ghApi } from "./gh.js";
import type {
  FetchReviewCommentsFn,
  Finding,
  RawReviewComment,
  Severity,
  SleepFn,
} from "./types.js";

/**
 * `filterAndParseComments` の戻り値。`skipped` は observability 用のカウンタで、
 * Codex finding を `unparseable` (severity 不明) と `belowThreshold` (threshold 未達) に
 * 区別して提供する。両者は pre-fix 側でログレベルを使い分けるため別カウンタになっている。
 */
export interface FilteredComments {
  findings: Finding[];
  skipped: {
    unparseable: number;
    belowThreshold: number;
  };
}

export interface StabilizeReviewCommentsOptions {
  botLogin: string;
  lastReceivedAt: string | null;
  triggerSummaryBody: string;
  severityThreshold: Severity;
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
  const stdout = await ghApi(
    [
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
      "--paginate",
      "--jq",
      // @json ensures each result is a single-line JSON-encoded string,
      // preventing multi-line jq pretty-printing from breaking split("\n") parsing
      ".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at} | @json",
    ],
    githubToken,
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
 * and returns findings whose severity is at least the given threshold.
 *
 * Why strict greater-than for timestamp: a comment received exactly at
 * lastReceivedAt was already processed in the previous iteration.
 *
 * Observability (TY-256): skipped comments are reported via the `skipped`
 * counter, split into `unparseable` (severity could not be parsed) and
 * `belowThreshold` (parsed severity is less urgent than the threshold).
 * Callers use the breakdown to log warnings vs informational messages.
 */
export function filterAndParseComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  threshold: Severity,
): FilteredComments {
  const findings: Finding[] = [];
  let unparseable = 0;
  let belowThreshold = 0;

  for (const comment of comments) {
    if (comment.user.login !== botLogin) continue;
    if (lastReceivedAt !== null && !(comment.createdAt > lastReceivedAt)) continue;

    const parsed = parseSeverity(comment.body);
    if (parsed.severity === null) {
      unparseable += 1;
      continue;
    }
    if (!isAtLeastSeverity(parsed.severity, threshold)) {
      belowThreshold += 1;
      continue;
    }
    findings.push({
      severity: parsed.severity,
      path: comment.path,
      line: comment.line ?? 0,
      title: parsed.title,
      body: parsed.body,
    });
  }

  return {
    findings,
    skipped: { unparseable, belowThreshold },
  };
}

export function shouldStabilizeReviewComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  triggerSummaryBody: string,
  threshold: Severity
): boolean {
  return (
    countRelevantBotComments(comments, botLogin, lastReceivedAt, threshold) === 0 &&
    summaryMayContainFindings(triggerSummaryBody, threshold)
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
      options.triggerSummaryBody,
      options.severityThreshold
    )
  ) {
    return initialComments;
  }

  let latestComments = initialComments;
  let lastCount = countRelevantBotComments(
    latestComments,
    options.botLogin,
    options.lastReceivedAt,
    options.severityThreshold
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
      options.lastReceivedAt,
      options.severityThreshold
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
  lastReceivedAt: string | null,
  threshold: Severity
): number {
  return comments.filter((comment) => {
    if (comment.user.login !== botLogin) return false;
    if (lastReceivedAt !== null && !(comment.createdAt > lastReceivedAt)) return false;
    const parsed = parseSeverity(comment.body);
    return parsed.severity !== null && isAtLeastSeverity(parsed.severity, threshold);
  }).length;
}

function summaryMayContainFindings(body: string, threshold: Severity): boolean {
  const normalized = body.toLowerCase();
  const noFindingsPatterns = [
    /\bno\s+findings?\b/i,
    /\b0\s+findings?\b/i,
    /\bno\s+issues?\b/i,
    /指摘なし/,
    /問題なし/,
  ];
  if (noFindingsPatterns.some((pattern) => pattern.test(body))) {
    return false;
  }

  // "No PX findings" requires threshold-aware handling: "No P3 findings" is not
  // a global no-findings signal when the threshold is P2 and the body also
  // mentions in-scope severities like P1/P2. Collect every negated severity
  // from all "No P… findings" clauses in the body, then only return false when
  // no un-negated in-scope severity also appears elsewhere in the text.
  const specificNoFindingsMatches = [
    ...body.matchAll(/\bno\s+(p[0-3](?:\s*\/\s*p[0-3])*)\s+findings?\b/gi),
  ];
  if (specificNoFindingsMatches.length > 0) {
    const negatedSeverities = new Set(
      specificNoFindingsMatches.flatMap((m) =>
        (m[1].match(/p[0-3]/gi) ?? []).map((s) => s.toUpperCase()),
      ),
    );
    const hasUnNegatedInScopeSignal = (["P0", "P1", "P2", "P3"] as Severity[])
      .filter((s) => isAtLeastSeverity(s, threshold) && !negatedSeverities.has(s))
      .some((s) => new RegExp(`\\b${s}\\b`, "i").test(body));
    if (!hasUnNegatedInScopeSignal) {
      return false;
    }
    // An un-negated in-scope severity appears in the body — fall through to the
    // severitySignal block so it can be detected as a positive signal.
  }

  // Only treat an explicit severity label as a positive signal if it is at or
  // above the threshold — a P3-only mention must not trigger stabilization
  // polling when the threshold is P2, because those findings will be filtered
  // out anyway (TY-256).
  const severitySignal =
    (isAtLeastSeverity("P0", threshold) && /\bp0\b/i.test(body)) ||
    (isAtLeastSeverity("P1", threshold) && /\bp1\b/i.test(body)) ||
    (isAtLeastSeverity("P2", threshold) && /\bp2\b/i.test(body)) ||
    (isAtLeastSeverity("P3", threshold) && /\bp3\b/i.test(body));

  // When the summary explicitly names a severity, the severity signal is the
  // authoritative answer — falling back to generic "findings"/"issues" words
  // when the named severity is below threshold would re-introduce the
  // unnecessary polling the threshold gate was meant to avoid (TY-256). The
  // generic-keyword fallback applies only when no severity is named, which
  // is the conservative case (e.g., Codex summary changes its format and
  // omits explicit severities — we still want to enter stabilization).
  const mentionsAnySeverity = /\bp[0-3]\b/i.test(body);
  if (mentionsAnySeverity) {
    return severitySignal;
  }

  return (
    /\bfindings?\b/.test(normalized) ||
    /\bissues?\b/.test(normalized) ||
    /指摘|問題|検出/.test(body)
  );
}
