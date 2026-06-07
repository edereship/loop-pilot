import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import type { CommentId } from "./types.js";

/**
 * A PR review thread as seen by the GraphQL API, reduced to the fields TY-360
 * needs: the node `id` (target of `resolveReviewThread`), whether it is already
 * `isResolved` (idempotency skip), and the `databaseId`s of its comments. Each
 * `databaseId` is a {@link CommentId}, so it maps directly to the id an in-scope
 * finding was parsed from.
 */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  commentDatabaseIds: CommentId[];
}

/** Outcome counters for a single `resolveFindingThreads` pass (observability). */
export interface ResolveFindingThreadsResult {
  /** Threads newly resolved by this pass. */
  resolved: number;
  /** Threads matched but already `isResolved` (idempotent skip). */
  alreadyResolved: number;
  /** Threads whose resolve mutation threw (best-effort; loop continues). */
  failed: number;
  /**
   * In-scope comment ids with no matching thread. Expected to be 0 in normal
   * operation; a non-zero value means a finding's thread was not in the fetched
   * page set (e.g. a finding parsed from a non-thread comment), surfaced for
   * logging only.
   */
  unmatched: number;
}

/**
 * GraphQL query for one page of review threads. `reviewThreads` is paginated
 * (first:100) because a large PR can accumulate more than a single page; each
 * thread's `comments(first:50)` exposes the `databaseId`s we match against the
 * in-scope finding comment ids. `isResolved` drives the idempotency skip.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id
          isResolved
          comments(first:50){nodes{databaseId}}
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){
    thread{id isResolved}
  }
}`;

/**
 * Hard cap on review-thread pages fetched per pass. 100 threads/page × 50 pages
 * = 5,000 threads is far beyond any realistic PR; the bound only exists so a
 * malformed `pageInfo.hasNextPage` (always true) cannot spin the loop forever.
 */
const MAX_REVIEW_THREAD_PAGES = 50;

interface ReviewThreadsPage {
  nodes: ReviewThread[];
  hasNextPage: boolean;
  endCursor: string | null;
  /**
   * True when the `reviewThreads` container was absent from an otherwise
   * well-formed (HTTP 200, parseable JSON) response — e.g. `data.repository`
   * is null because the token cannot see the PR. Distinguished from a real
   * empty PR (container present, `nodes: []`) so `fetchReviewThreads` can warn
   * instead of silently treating a permission/shape regression as "no threads".
   */
  malformed: boolean;
}

function parseReviewThreadsResponse(stdout: string): ReviewThreadsPage {
  const parsed = JSON.parse(stdout) as unknown;
  const threads = (parsed as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            nodes?: unknown;
          };
        };
      };
    };
  }).data?.repository?.pullRequest?.reviewThreads;

  const malformed = threads === undefined || threads === null;
  const rawNodes = Array.isArray(threads?.nodes) ? threads!.nodes : [];
  const nodes: ReviewThread[] = [];
  for (const node of rawNodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as {
      id?: unknown;
      isResolved?: unknown;
      comments?: { nodes?: unknown };
    };
    if (typeof n.id !== "string") continue;
    const commentNodes = Array.isArray(n.comments?.nodes) ? n.comments!.nodes : [];
    const commentDatabaseIds: number[] = [];
    for (const c of commentNodes) {
      const dbId = (c as { databaseId?: unknown })?.databaseId;
      if (typeof dbId === "number") commentDatabaseIds.push(dbId);
    }
    nodes.push({
      id: n.id,
      isResolved: n.isResolved === true,
      commentDatabaseIds,
    });
  }

  const hasNextPage = threads?.pageInfo?.hasNextPage === true;
  const endCursorRaw = threads?.pageInfo?.endCursor;
  const endCursor = typeof endCursorRaw === "string" ? endCursorRaw : null;
  return { nodes, hasNextPage, endCursor, malformed };
}

/**
 * Fetch every review thread on a PR via paginated GraphQL. Uses the shared
 * `ghApi` wrapper (which injects auth + the unified maxBuffer), so this resolves
 * threads created by Codex even though they are authored by a bot — the
 * GraphQL `resolveReviewThread` requirement is `pull-requests:write` on the
 * caller's token, not authorship.
 */
export async function fetchReviewThreads(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  warn: (message: string) => void = (m) => core.warning(m),
): Promise<ReviewThread[]> {
  const all: ReviewThread[] = [];
  let cursor: string | null = null;
  let moreRemaining = false;
  for (let page = 0; page < MAX_REVIEW_THREAD_PAGES; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${repo}`,
      "-F",
      `number=${prNumber}`,
    ];
    // First page: omit `cursor` entirely so the `$cursor` variable is null
    // (GraphQL treats an absent nullable variable as null). Subsequent pages
    // pass the previous `endCursor`.
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }
    const stdout = await ghApi(args, token);
    const pageResult = parseReviewThreadsResponse(stdout);
    // A well-formed HTTP 200 whose `reviewThreads` container is missing (e.g.
    // `data.repository` null because the token cannot see the PR) would
    // otherwise look identical to an empty PR. Surface it so a permission /
    // schema regression is visible rather than silently resolving nothing.
    if (pageResult.malformed) {
      warn(
        `[review-thread-resolver] GraphQL returned no reviewThreads container for ${owner}/${repo}#${prNumber} ` +
          `(page ${page}); the token may lack access to the PR or the API shape changed. Treating as zero threads.`,
      );
      break;
    }
    all.push(...pageResult.nodes);
    if (!pageResult.hasNextPage || pageResult.endCursor === null) break;
    cursor = pageResult.endCursor;
    // Set only when the loop is about to exit via the `page` counter rather
    // than the break above — i.e. there are still more pages at the cap.
    moreRemaining = page === MAX_REVIEW_THREAD_PAGES - 1;
  }
  // Hitting the page cap with more pages remaining means the returned set is
  // truncated — exactly the malformed-`hasNextPage` / runaway-pagination case
  // the cap guards against. Warn so it is not mistaken for a complete fetch.
  if (moreRemaining) {
    warn(
      `[review-thread-resolver] Hit MAX_REVIEW_THREAD_PAGES (${MAX_REVIEW_THREAD_PAGES}) for ${owner}/${repo}#${prNumber} ` +
        `with more pages remaining; the resolved set may be incomplete.`,
    );
  }
  return all;
}

/** Resolve a single review thread via the `resolveReviewThread` mutation. */
export async function resolveReviewThread(
  threadId: string,
  token: string,
): Promise<void> {
  await ghApi(
    [
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_THREAD_MUTATION}`,
      "-f",
      `threadId=${threadId}`,
    ],
    token,
  );
}

/**
 * Pure mapping step (no I/O): given the fetched threads and the in-scope
 * finding comment ids, return the thread node ids that should be resolved —
 * a thread is selected when one of its comment `databaseId`s matches an
 * in-scope comment id AND the thread is not already resolved. Also reports
 * how many were already resolved (idempotent skip) and how many in-scope ids
 * matched no thread at all.
 */
export function selectThreadsToResolve(
  threads: readonly ReviewThread[],
  commentIds: readonly CommentId[],
): { toResolve: string[]; alreadyResolved: number; unmatched: number } {
  const wanted = new Set(commentIds);
  if (wanted.size === 0) {
    return { toResolve: [], alreadyResolved: 0, unmatched: 0 };
  }
  const toResolve: string[] = [];
  let alreadyResolved = 0;
  const matchedCommentIds = new Set<CommentId>();
  for (const thread of threads) {
    const matchedHere = thread.commentDatabaseIds.filter((id) => wanted.has(id));
    if (matchedHere.length === 0) continue;
    for (const id of matchedHere) matchedCommentIds.add(id);
    if (thread.isResolved) {
      alreadyResolved += 1;
    } else {
      toResolve.push(thread.id);
    }
  }
  const unmatched = [...wanted].filter((id) => !matchedCommentIds.has(id)).length;
  return { toResolve, alreadyResolved, unmatched };
}

export interface ResolveFindingThreadsParams {
  owner: string;
  repo: string;
  prNumber: number;
  /** In-scope finding comment ids for the iteration (state.currentIterationFindingCommentIds). */
  commentIds: readonly CommentId[];
  /** Token with `pull-requests:write` — the github-token, NOT the push token (TY-360). */
  token: string;
}

export interface ResolveFindingThreadsDeps {
  fetchReviewThreads: typeof fetchReviewThreads;
  resolveReviewThread: typeof resolveReviewThread;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const defaultDeps: ResolveFindingThreadsDeps = {
  fetchReviewThreads,
  resolveReviewThread,
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
};

/**
 * Best-effort resolve of the Codex review threads for an iteration's in-scope
 * findings (TY-360 / A案). The caller invokes this only after CHECK_COMMAND
 * succeeded and the repair commit was pushed, so a resolve here means "this
 * iteration's in-scope findings were fixed and committed".
 *
 * Best-effort contract: this NEVER throws. A failure to fetch threads, or to
 * resolve any individual thread, is logged as a warning and the loop continues
 * (commit / `@codex review` re-request / state transition are unaffected).
 * Already-resolved threads are skipped (idempotent). Only the comment ids in
 * `commentIds` — i.e. in-scope findings at/above the severity threshold — are
 * targeted, so below-threshold / unparseable Codex threads are never resolved.
 */
export async function resolveFindingThreads(
  params: ResolveFindingThreadsParams,
  deps: ResolveFindingThreadsDeps = defaultDeps,
): Promise<ResolveFindingThreadsResult> {
  const empty: ResolveFindingThreadsResult = {
    resolved: 0,
    alreadyResolved: 0,
    failed: 0,
    unmatched: 0,
  };
  if (params.commentIds.length === 0) return empty;

  let threads: ReviewThread[];
  try {
    threads = await deps.fetchReviewThreads(
      params.owner,
      params.repo,
      params.prNumber,
      params.token,
    );
  } catch (error) {
    deps.warning(
      `[review-thread-resolver] Could not fetch review threads to resolve fixed findings: ${
        error instanceof Error ? error.message : String(error)
      }. Continuing — threads will remain open.`,
    );
    return empty;
  }

  const { toResolve, alreadyResolved, unmatched } = selectThreadsToResolve(
    threads,
    params.commentIds,
  );

  let resolved = 0;
  let failed = 0;
  for (const threadId of toResolve) {
    try {
      await deps.resolveReviewThread(threadId, params.token);
      resolved += 1;
    } catch (error) {
      failed += 1;
      deps.warning(
        `[review-thread-resolver] Failed to resolve review thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }. Continuing.`,
      );
    }
  }

  if (resolved > 0 || alreadyResolved > 0 || failed > 0 || unmatched > 0) {
    const summary =
      `[review-thread-resolver] Resolved ${resolved} review thread(s) for fixed findings ` +
      `(already-resolved: ${alreadyResolved}, failed: ${failed}, unmatched: ${unmatched}).`;
    // `failed` / `unmatched` signal a real problem: a resolve mutation was
    // denied, or an in-scope finding had no matching thread (the id↔thread
    // assumption broke). Surface those at warning severity so GitHub Actions
    // highlights them; the all-success case stays at info.
    if (failed > 0 || unmatched > 0) {
      deps.warning(summary);
    } else {
      deps.info(summary);
    }
  }
  return { resolved, alreadyResolved, failed, unmatched };
}
