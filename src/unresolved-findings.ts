import { ghApi } from "./gh.js";
import { parseSeverity, isAtLeastSeverity } from "./severity-parser.js";
import type { Finding, Severity } from "./types.js";

/**
 * GraphQL query for one page of review threads enriched with the first
 * comment's author, body, path, and line — the fields
 * `fetchUnresolvedCodexFindings` needs to construct a `Finding[]`. The
 * existing `review-thread-resolver.ts` query only fetches `databaseId` (it
 * resolves by id, not content), so a separate query is necessary.
 */
const UNRESOLVED_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id
          isResolved
          path
          line
          comments(first:1){
            nodes{databaseId author{login} body}
          }
        }
      }
    }
  }
}`;

const MAX_PAGES = 50;

export interface FetchUnresolvedCodexFindingsParams {
  owner: string;
  repo: string;
  prNumber: number;
  codexBotLogin: string;
  severityThreshold: Severity;
  token: string;
}

export interface FetchUnresolvedCodexFindingsDeps {
  warning: (message: string) => void;
}

interface RawThreadNode {
  id?: unknown;
  isResolved?: unknown;
  path?: unknown;
  line?: unknown;
  comments?: {
    nodes?: Array<{
      databaseId?: unknown;
      author?: { login?: unknown };
      body?: unknown;
    }>;
  };
}

interface ParsedPage {
  findings: Finding[];
  hasNextPage: boolean;
  endCursor: string | null;
  malformed: boolean;
  skippedNonCodex: number;
  skippedResolved: number;
  skippedUnparseable: number;
  skippedBelowThreshold: number;
  skippedMalformedId: number;
}

function parsePage(
  stdout: string,
  codexBotLogin: string,
  severityThreshold: Severity,
): ParsedPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      findings: [],
      hasNextPage: false,
      endCursor: null,
      malformed: true,
      skippedNonCodex: 0,
      skippedResolved: 0,
      skippedUnparseable: 0,
      skippedBelowThreshold: 0,
      skippedMalformedId: 0,
    };
  }
  const typed = parsed as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            nodes?: unknown[];
          };
        };
      };
    };
  };
  const threads = typed.data?.repository?.pullRequest?.reviewThreads;
  if (threads === undefined || threads === null) {
    return {
      findings: [],
      hasNextPage: false,
      endCursor: null,
      malformed: true,
      skippedNonCodex: 0,
      skippedResolved: 0,
      skippedUnparseable: 0,
      skippedBelowThreshold: 0,
      skippedMalformedId: 0,
    };
  }

  const rawNodes = Array.isArray(threads.nodes) ? threads.nodes : [];
  const findings: Finding[] = [];
  let skippedNonCodex = 0;
  let skippedResolved = 0;
  let skippedUnparseable = 0;
  let skippedBelowThreshold = 0;
  let skippedMalformedId = 0;

  for (const raw of rawNodes) {
    const node = raw as RawThreadNode;
    if (node.isResolved === true) {
      skippedResolved += 1;
      continue;
    }
    const firstComment = Array.isArray(node.comments?.nodes)
      ? node.comments!.nodes[0]
      : undefined;
    if (!firstComment) continue;
    if (firstComment.author?.login !== codexBotLogin) {
      skippedNonCodex += 1;
      continue;
    }

    const body = typeof firstComment.body === "string" ? firstComment.body : "";
    const result = parseSeverity(body);
    if (result.severity === null) {
      skippedUnparseable += 1;
      continue;
    }
    if (!isAtLeastSeverity(result.severity, severityThreshold)) {
      skippedBelowThreshold += 1;
      continue;
    }

    const databaseId = firstComment.databaseId;
    if (typeof databaseId !== "number") {
      skippedMalformedId += 1;
      continue;
    }

    findings.push({
      severity: result.severity,
      commentId: databaseId,
      path: typeof node.path === "string" ? node.path : "",
      line: typeof node.line === "number" ? node.line : null,
      title: result.title,
      body: result.body,
    });
  }

  return {
    findings,
    hasNextPage: threads.pageInfo?.hasNextPage === true,
    endCursor:
      typeof threads.pageInfo?.endCursor === "string"
        ? threads.pageInfo.endCursor
        : null,
    malformed: false,
    skippedNonCodex,
    skippedResolved,
    skippedUnparseable,
    skippedBelowThreshold,
    skippedMalformedId,
  };
}

/**
 * Fetch all unresolved Codex review threads on a PR and return them as
 * `Finding[]`. Filters by `!isResolved`, Codex bot authorship, and the
 * severity threshold. Pagination follows the same strategy as
 * `review-thread-resolver.ts` (100 threads/page, max 50 pages).
 */
export async function fetchUnresolvedCodexFindings(
  params: FetchUnresolvedCodexFindingsParams,
  deps: FetchUnresolvedCodexFindingsDeps = { warning: () => {} },
): Promise<Finding[]> {
  const all: Finding[] = [];
  let cursor: string | null = null;
  let totalSkippedUnparseable = 0;
  let totalSkippedBelowThreshold = 0;
  let totalSkippedMalformedId = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-f",
      `owner=${params.owner}`,
      "-f",
      `name=${params.repo}`,
      "-F",
      `number=${params.prNumber}`,
    ];
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }
    let stdout: string;
    try {
      stdout = await ghApi(args, params.token);
    } catch (error) {
      deps.warning(
        `[unresolved-findings] Could not fetch review threads for ` +
          `${params.owner}/${params.repo}#${params.prNumber}: ${
            error instanceof Error ? error.message : String(error)
          }. Treating as zero unresolved findings.`,
      );
      return [];
    }
    const pageResult = parsePage(
      stdout,
      params.codexBotLogin,
      params.severityThreshold,
    );

    if (pageResult.malformed) {
      deps.warning(
        `[unresolved-findings] GraphQL response for ` +
          `${params.owner}/${params.repo}#${params.prNumber} (page ${page}) ` +
          `is missing the reviewThreads container or is not valid JSON; ` +
          `the token may lack access or the API shape changed. Treating as zero findings.`,
      );
      return [];
    }

    all.push(...pageResult.findings);
    totalSkippedUnparseable += pageResult.skippedUnparseable;
    totalSkippedBelowThreshold += pageResult.skippedBelowThreshold;
    totalSkippedMalformedId += pageResult.skippedMalformedId;

    if (!pageResult.hasNextPage || pageResult.endCursor === null) break;
    cursor = pageResult.endCursor;

    if (page === MAX_PAGES - 1) {
      deps.warning(
        `[unresolved-findings] Hit MAX_PAGES (${MAX_PAGES}) for ` +
          `${params.owner}/${params.repo}#${params.prNumber} with more pages remaining; ` +
          `the unresolved findings set may be incomplete.`,
      );
    }
  }

  if (totalSkippedUnparseable > 0) {
    deps.warning(
      `[unresolved-findings] Skipped ${totalSkippedUnparseable} unresolved Codex thread(s) ` +
        `with unparseable severity.`,
    );
  }
  if (totalSkippedBelowThreshold > 0) {
    deps.warning(
      `[unresolved-findings] Skipped ${totalSkippedBelowThreshold} unresolved Codex thread(s) ` +
        `below severity threshold (${params.severityThreshold}).`,
    );
  }
  if (totalSkippedMalformedId > 0) {
    deps.warning(
      `[unresolved-findings] Dropped ${totalSkippedMalformedId} unresolved Codex thread(s) ` +
        `with non-numeric databaseId; the GraphQL comment schema may have changed.`,
    );
  }

  return all;
}
