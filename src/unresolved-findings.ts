import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import { parseSeverity, isAtLeastSeverity } from "./severity-parser.js";
import type { CommentId, Finding, Severity } from "./types.js";

/**
 * GraphQL query that fetches review threads with the first comment's author
 * and body. Unlike `review-thread-resolver.ts` (which only needs `databaseId`),
 * this query projects `path`, `line`, `author.login`, and `body` so we can
 * reconstruct a `Finding` from each unresolved Codex thread.
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

interface ThreadsPageResult {
  rawNodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
  malformed: boolean;
}

function parseThreadsResponse(stdout: string): ThreadsPageResult {
  const parsed = JSON.parse(stdout) as {
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

  const threads = parsed?.data?.repository?.pullRequest?.reviewThreads;
  const malformed = threads === undefined || threads === null;
  const rawNodes = Array.isArray(threads?.nodes) ? threads!.nodes : [];
  const hasNextPage = threads?.pageInfo?.hasNextPage === true;
  const endCursorRaw = threads?.pageInfo?.endCursor;
  const endCursor = typeof endCursorRaw === "string" ? endCursorRaw : null;

  return { rawNodes, hasNextPage, endCursor, malformed };
}

export interface FetchUnresolvedCodexFindingsDeps {
  ghApi: typeof ghApi;
  warn: (message: string) => void;
}

const defaultDeps: FetchUnresolvedCodexFindingsDeps = {
  ghApi,
  warn: (message) => core.warning(message),
};

/**
 * Fetch all unresolved Codex review threads on a PR and return them as
 * `Finding[]` after applying the severity threshold filter.
 *
 * Unlike `review-collector.ts` (REST-based, timestamp-scoped to the latest
 * review), this function returns ALL unresolved Codex threads regardless of
 * when they were posted. TY-360's thread-resolve logic ensures that threads
 * fixed in previous iterations are already resolved, so unresolved = unfixed.
 */
export async function fetchUnresolvedCodexFindings(
  owner: string,
  repo: string,
  prNumber: number,
  codexBotLogin: string,
  severityThreshold: Severity,
  token: string,
  deps: FetchUnresolvedCodexFindingsDeps = defaultDeps,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${repo}`,
      "-F",
      `number=${prNumber}`,
    ];
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }

    const stdout = await deps.ghApi(args, token);
    const result = parseThreadsResponse(stdout);

    if (result.malformed) {
      deps.warn(
        `[unresolved-findings] GraphQL returned no reviewThreads container for ${owner}/${repo}#${prNumber} ` +
          `(page ${page}); the token may lack access or the API shape changed. Treating as zero threads.`,
      );
      break;
    }

    for (const rawNode of result.rawNodes) {
      const node = rawNode as {
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
      };

      if (node.isResolved === true) continue;
      if (typeof node.id !== "string") continue;

      const firstComment = Array.isArray(node.comments?.nodes)
        ? node.comments!.nodes[0]
        : undefined;
      if (!firstComment) continue;

      if (
        typeof firstComment.author?.login !== "string" ||
        firstComment.author.login !== codexBotLogin
      )
        continue;

      const databaseId = firstComment.databaseId;
      if (typeof databaseId !== "number") continue;

      const body = typeof firstComment.body === "string" ? firstComment.body : "";
      const parsed = parseSeverity(body);
      if (parsed.severity === null) continue;
      if (!isAtLeastSeverity(parsed.severity, severityThreshold)) continue;

      const path = typeof node.path === "string" ? node.path : "";
      const line = typeof node.line === "number" ? node.line : null;

      findings.push({
        severity: parsed.severity,
        commentId: databaseId as CommentId,
        path,
        line,
        title: parsed.title,
        body: parsed.body,
      });
    }

    if (!result.hasNextPage || result.endCursor === null) break;
    cursor = result.endCursor;

    if (page === MAX_PAGES - 1) {
      deps.warn(
        `[unresolved-findings] Hit MAX_PAGES (${MAX_PAGES}) for ${owner}/${repo}#${prNumber} ` +
          `with more pages remaining; the unresolved findings set may be incomplete.`,
      );
    }
  }

  return findings;
}

/**
 * Determine whether the PR head has been pushed since the last Codex review.
 *
 * False negatives (push missed): Case B fires and repairs unresolved findings
 * before `@codex review` — harmless (at worst one extra repair round).
 *
 * False positives (push falsely detected): the existing `@codex review` flow
 * runs — identical to the pre-ES-413 behaviour.
 */
export function hasPushSinceLastReview(
  lastCodexReviewReceivedAt: string | null,
  latestCommitDate: string,
): boolean {
  if (lastCodexReviewReceivedAt === null) return false;
  return latestCommitDate > lastCodexReviewReceivedAt;
}

/**
 * Fetch the committer date of the PR's head commit. Used by Case B detection
 * to determine whether a push occurred after the last Codex review.
 */
export async function fetchPrHeadCommitDate(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const headShaStdout = await ghApi(
    [
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}`,
      "--jq",
      ".head.sha",
    ],
    token,
  );
  const headSha = headShaStdout.trim();
  if (!headSha) return "";

  const commitStdout = await ghApi(
    [
      "api",
      `repos/${owner}/${repo}/commits/${headSha}`,
      "--jq",
      ".commit.committer.date",
    ],
    token,
  );
  return commitStdout.trim();
}
