import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchReviewThreads,
  resolveFindingThreads,
  resolveReviewThread,
  selectThreadsToResolve,
  type ResolveFindingThreadsDeps,
  type ReviewThread,
} from "../src/review-thread-resolver.js";

vi.mock("../src/gh.js", () => ({ ghApi: vi.fn() }));
const { ghApi } = await import("../src/gh.js");
const mockedGhApi = vi.mocked(ghApi);

beforeEach(() => {
  mockedGhApi.mockReset();
});

function thread(
  id: string,
  isResolved: boolean,
  commentDatabaseIds: number[],
): ReviewThread {
  return { id, isResolved, commentDatabaseIds };
}

function makeDeps(
  overrides: Partial<ResolveFindingThreadsDeps> = {},
): ResolveFindingThreadsDeps & {
  resolveCalls: string[];
  warnings: string[];
  infos: string[];
} {
  const resolveCalls: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const deps: ResolveFindingThreadsDeps = {
    fetchReviewThreads: vi.fn().mockResolvedValue([]),
    resolveReviewThread: vi.fn(async (threadId: string) => {
      resolveCalls.push(threadId);
    }),
    info: (m) => infos.push(m),
    warning: (m) => warnings.push(m),
    ...overrides,
  };
  return Object.assign(deps, { resolveCalls, warnings, infos });
}

describe("selectThreadsToResolve", () => {
  it("selects unresolved threads whose comment databaseId matches an in-scope id", () => {
    const threads = [
      thread("PRRT_1", false, [101]),
      thread("PRRT_2", false, [202]),
      thread("PRRT_3", false, [303]),
    ];
    const result = selectThreadsToResolve(threads, [101, 303]);
    expect(result.toResolve).toEqual(["PRRT_1", "PRRT_3"]);
    expect(result.alreadyResolved).toBe(0);
    expect(result.unmatched).toBe(0);
  });

  it("matches strictly by databaseId — no path/line fuzziness", () => {
    const threads = [thread("PRRT_1", false, [999])];
    const result = selectThreadsToResolve(threads, [101]);
    expect(result.toResolve).toEqual([]);
    expect(result.unmatched).toBe(1);
  });

  it("skips threads that are already resolved (idempotent)", () => {
    const threads = [
      thread("PRRT_1", true, [101]),
      thread("PRRT_2", false, [202]),
    ];
    const result = selectThreadsToResolve(threads, [101, 202]);
    expect(result.toResolve).toEqual(["PRRT_2"]);
    expect(result.alreadyResolved).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  it("matches a thread when ANY of its comments matches an in-scope id", () => {
    // A thread accumulates a Codex finding comment plus follow-up replies; the
    // finding comment's databaseId is what we match on.
    const threads = [thread("PRRT_1", false, [500, 101, 600])];
    const result = selectThreadsToResolve(threads, [101]);
    expect(result.toResolve).toEqual(["PRRT_1"]);
    expect(result.unmatched).toBe(0);
  });

  it("returns empty for an empty in-scope id set without scanning threads", () => {
    const threads = [thread("PRRT_1", false, [101])];
    const result = selectThreadsToResolve(threads, []);
    expect(result).toEqual({ toResolve: [], alreadyResolved: 0, unmatched: 0 });
  });

  it("counts an in-scope id with no matching thread as unmatched", () => {
    const threads = [thread("PRRT_1", false, [101])];
    const result = selectThreadsToResolve(threads, [101, 404]);
    expect(result.toResolve).toEqual(["PRRT_1"]);
    expect(result.unmatched).toBe(1);
  });
});

describe("resolveFindingThreads", () => {
  it("short-circuits (no fetch) when there are no in-scope ids", async () => {
    const deps = makeDeps();
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 1, commentIds: [], token: "t" },
      deps,
    );
    expect(result).toEqual({ resolved: 0, alreadyResolved: 0, failed: 0, unmatched: 0 });
    expect(deps.fetchReviewThreads).not.toHaveBeenCalled();
    expect(deps.resolveReviewThread).not.toHaveBeenCalled();
  });

  it("resolves matched, unresolved threads and reports counts", async () => {
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockResolvedValue([
        thread("PRRT_1", false, [101]),
        thread("PRRT_2", true, [202]),
        thread("PRRT_3", false, [303]),
      ]),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101, 202, 303], token: "ght" },
      deps,
    );
    expect(deps.resolveCalls).toEqual(["PRRT_1", "PRRT_3"]);
    expect(result).toEqual({ resolved: 2, alreadyResolved: 1, failed: 0, unmatched: 0 });
    expect(deps.resolveReviewThread).toHaveBeenCalledWith("PRRT_1", "ght");
  });

  it("does NOT resolve below-threshold/unparseable threads (only the passed ids)", async () => {
    // commentIds only contains the in-scope finding id 101. The below-threshold
    // comment (202) shares a fetched thread but is never targeted.
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockResolvedValue([
        thread("PRRT_inscope", false, [101]),
        thread("PRRT_belowthreshold", false, [202]),
      ]),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101], token: "t" },
      deps,
    );
    expect(deps.resolveCalls).toEqual(["PRRT_inscope"]);
    expect(result.resolved).toBe(1);
  });

  it("is best-effort on fetch failure: returns empty, no throw, warns", async () => {
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockRejectedValue(new Error("graphql 502")),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101], token: "t" },
      deps,
    );
    expect(result).toEqual({ resolved: 0, alreadyResolved: 0, failed: 0, unmatched: 0 });
    expect(deps.resolveReviewThread).not.toHaveBeenCalled();
    expect(deps.warnings.join("\n")).toContain("graphql 502");
  });

  it("is best-effort per thread: a failed resolve is counted, the rest continue", async () => {
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockResolvedValue([
        thread("PRRT_1", false, [101]),
        thread("PRRT_2", false, [202]),
      ]),
      resolveReviewThread: vi.fn(async (threadId: string) => {
        if (threadId === "PRRT_1") throw new Error("resolve denied");
      }),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101, 202], token: "t" },
      deps,
    );
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(1);
    expect(deps.warnings.join("\n")).toContain("PRRT_1");
  });

  it("is best-effort when the GraphQL body is not valid JSON (parse throw)", async () => {
    // Drive the REAL fetchReviewThreads (whose JSON.parse throws on a non-JSON
    // body, e.g. an HTML 502) through resolveFindingThreads to confirm the
    // parse throw is caught and does not escape.
    mockedGhApi.mockResolvedValueOnce("<html>502 Bad Gateway</html>");
    const deps = makeDeps({
      fetchReviewThreads: (owner, repo, prNumber, token) =>
        fetchReviewThreads(owner, repo, prNumber, token),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101], token: "t" },
      deps,
    );
    expect(result).toEqual({ resolved: 0, alreadyResolved: 0, failed: 0, unmatched: 0 });
    expect(deps.resolveReviewThread).not.toHaveBeenCalled();
    expect(deps.warnings.length).toBeGreaterThan(0);
  });

  it("logs the summary at warning severity when there are unmatched ids", async () => {
    // An in-scope id with no matching thread signals the id↔thread assumption
    // broke; it must surface as a warning, not be buried in info.
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockResolvedValue([thread("PRRT_1", false, [101])]),
    });
    const result = await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101, 999], token: "t" },
      deps,
    );
    expect(result.resolved).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(deps.warnings.join("\n")).toContain("unmatched: 1");
    expect(deps.infos).toEqual([]);
  });

  it("logs the summary at info severity on a clean all-success pass", async () => {
    const deps = makeDeps({
      fetchReviewThreads: vi.fn().mockResolvedValue([thread("PRRT_1", false, [101])]),
    });
    await resolveFindingThreads(
      { owner: "o", repo: "r", prNumber: 7, commentIds: [101], token: "t" },
      deps,
    );
    expect(deps.infos.join("\n")).toContain("Resolved 1 review thread");
    expect(deps.warnings).toEqual([]);
  });
});

describe("fetchReviewThreads (GraphQL wiring)", () => {
  it("paginates and aggregates threads across pages", async () => {
    mockedGhApi
      .mockResolvedValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "CUR1" },
                  nodes: [
                    { id: "PRRT_1", isResolved: false, comments: { nodes: [{ databaseId: 101 }] } },
                  ],
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "PRRT_2", isResolved: true, comments: { nodes: [{ databaseId: 202 }] } },
                  ],
                },
              },
            },
          },
        }),
      );

    const threads = await fetchReviewThreads("o", "r", 9, "tok");
    expect(threads).toEqual([
      { id: "PRRT_1", isResolved: false, commentDatabaseIds: [101] },
      { id: "PRRT_2", isResolved: true, commentDatabaseIds: [202] },
    ]);
    expect(mockedGhApi).toHaveBeenCalledTimes(2);
    // First page: no cursor arg. Second page: cursor passed.
    const firstArgs = mockedGhApi.mock.calls[0][0];
    const secondArgs = mockedGhApi.mock.calls[1][0];
    expect(firstArgs).toContain("graphql");
    expect(firstArgs.some((a) => a.startsWith("cursor="))).toBe(false);
    expect(secondArgs).toContain("cursor=CUR1");
    // Numeric PR number passed via -F (typed).
    expect(firstArgs).toContain("number=9");
  });

  it("tolerates a malformed/empty response shape", async () => {
    mockedGhApi.mockResolvedValueOnce(JSON.stringify({ data: {} }));
    const threads = await fetchReviewThreads("o", "r", 9, "tok");
    expect(threads).toEqual([]);
  });

  it("warns when the reviewThreads container is absent (e.g. token cannot see the PR)", async () => {
    // HTTP 200 + parseable JSON but `data.repository` null — must not be
    // silently treated as an empty PR.
    mockedGhApi.mockResolvedValueOnce(
      JSON.stringify({ data: { repository: null } }),
    );
    const warnings: string[] = [];
    const threads = await fetchReviewThreads("o", "r", 9, "tok", (m) =>
      warnings.push(m),
    );
    expect(threads).toEqual([]);
    expect(warnings.join("\n")).toContain("no reviewThreads container");
  });

  it("does NOT warn for a genuinely empty PR (container present, zero nodes)", async () => {
    mockedGhApi.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      }),
    );
    const warnings: string[] = [];
    const threads = await fetchReviewThreads("o", "r", 9, "tok", (m) =>
      warnings.push(m),
    );
    expect(threads).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("stops at MAX_REVIEW_THREAD_PAGES and warns when hasNextPage never clears", async () => {
    // Simulate a malformed/runaway pagination: every page claims another page.
    // The cap must bound the calls AND surface a truncation warning rather than
    // silently returning a partial set.
    mockedGhApi.mockImplementation(async () =>
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: "NEXT" },
                nodes: [
                  { id: "PRRT_x", isResolved: false, comments: { nodes: [{ databaseId: 1 }] } },
                ],
              },
            },
          },
        },
      }),
    );
    const warnings: string[] = [];
    const threads = await fetchReviewThreads("o", "r", 9, "tok", (m) =>
      warnings.push(m),
    );
    expect(mockedGhApi).toHaveBeenCalledTimes(50);
    expect(threads).toHaveLength(50);
    expect(warnings.join("\n")).toContain("MAX_REVIEW_THREAD_PAGES");
  });

  it("stops after one page when hasNextPage is true but endCursor is null (no cap warning)", async () => {
    // A malformed page that claims another page yet supplies no cursor must
    // break cleanly rather than re-fetch with a null cursor (which would refetch
    // page 1 forever until the cap). It is NOT the cap-truncation case, so no
    // MAX_REVIEW_THREAD_PAGES warning should fire.
    mockedGhApi.mockResolvedValue(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: null },
                nodes: [
                  { id: "PRRT_1", isResolved: false, comments: { nodes: [{ databaseId: 101 }] } },
                ],
              },
            },
          },
        },
      }),
    );
    const warnings: string[] = [];
    const threads = await fetchReviewThreads("o", "r", 9, "tok", (m) =>
      warnings.push(m),
    );
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    expect(threads).toEqual([
      { id: "PRRT_1", isResolved: false, commentDatabaseIds: [101] },
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns (separately from unmatched) when a thread node lacks a usable id", async () => {
    mockedGhApi.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: "PRRT_1", isResolved: false, comments: { nodes: [{ databaseId: 101 }] } },
                  // No string `id` — cannot be resolved; must be dropped + warned.
                  { isResolved: false, comments: { nodes: [{ databaseId: 202 }] } },
                ],
              },
            },
          },
        },
      }),
    );
    const warnings: string[] = [];
    const threads = await fetchReviewThreads("o", "r", 9, "tok", (m) =>
      warnings.push(m),
    );
    expect(threads).toEqual([
      { id: "PRRT_1", isResolved: false, commentDatabaseIds: [101] },
    ]);
    expect(warnings.join("\n")).toContain("lacking a usable id");
  });

  it("warns when a thread's comments page is truncated (>50 comments)", async () => {
    mockedGhApi.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRRT_1",
                    isResolved: false,
                    comments: {
                      pageInfo: { hasNextPage: true },
                      nodes: [{ databaseId: 101 }],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const warnings: string[] = [];
    await fetchReviewThreads("o", "r", 9, "tok", (m) => warnings.push(m));
    expect(warnings.join("\n")).toContain("more than 50 comments");
  });
});

describe("resolveReviewThread (GraphQL wiring)", () => {
  it("invokes the resolveReviewThread mutation with the thread node id", async () => {
    mockedGhApi.mockResolvedValueOnce("{}");
    await resolveReviewThread("PRRT_42", "tok");
    const args = mockedGhApi.mock.calls[0][0];
    expect(args).toContain("graphql");
    expect(args).toContain("threadId=PRRT_42");
    expect(args.some((a) => a.includes("resolveReviewThread"))).toBe(true);
    expect(mockedGhApi.mock.calls[0][1]).toBe("tok");
  });
});
