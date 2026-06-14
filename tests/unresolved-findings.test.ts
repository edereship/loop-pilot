import { describe, expect, it, vi } from "vitest";
import {
  fetchUnresolvedCodexFindings,
  hasPushSinceLastReview,
  type FetchUnresolvedCodexFindingsDeps,
} from "../src/unresolved-findings.js";

function makeGraphQLResponse(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  });
}

function makeThread(opts: {
  id?: string;
  isResolved?: boolean;
  path?: string;
  line?: number | null;
  databaseId?: number;
  authorLogin?: string;
  body?: string;
}) {
  return {
    id: opts.id ?? "thread-1",
    isResolved: opts.isResolved ?? false,
    path: opts.path ?? "src/foo.ts",
    line: opts.line === undefined ? 10 : opts.line,
    comments: {
      nodes: [
        {
          databaseId: opts.databaseId ?? 100,
          author: { login: opts.authorLogin ?? "chatgpt-codex-connector[bot]" },
          body: opts.body ?? "P1 Missing null guard\n\nGuard the dereference.",
        },
      ],
    },
  };
}

function makeDeps(): FetchUnresolvedCodexFindingsDeps {
  return {
    ghApi: vi.fn<FetchUnresolvedCodexFindingsDeps["ghApi"]>(),
    warn: vi.fn<FetchUnresolvedCodexFindingsDeps["warn"]>(),
  };
}

describe("fetchUnresolvedCodexFindings", () => {
  it("returns findings from unresolved Codex threads at or above threshold", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          id: "t1",
          isResolved: false,
          path: "src/auth.ts",
          line: 42,
          databaseId: 200,
          body: "P0 Token bypass\n\nThe middleware skips auth.",
        }),
        makeThread({
          id: "t2",
          isResolved: false,
          path: "src/cache.ts",
          line: 7,
          databaseId: 201,
          body: "P2 Minor nit\n\nWording is unclear.",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: "P0",
      commentId: 200,
      path: "src/auth.ts",
      line: 42,
      title: "Token bypass",
    });
    expect(findings[1]).toMatchObject({
      severity: "P2",
      commentId: 201,
      path: "src/cache.ts",
      line: 7,
      title: "Minor nit",
    });
  });

  it("skips resolved threads", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ id: "t1", isResolved: true, databaseId: 100 }),
        makeThread({ id: "t2", isResolved: false, databaseId: 101 }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(101);
  });

  it("skips non-Codex threads", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          id: "t1",
          authorLogin: "human-reviewer",
          body: "P0 Critical issue\n\nSomething.",
        }),
        makeThread({
          id: "t2",
          authorLogin: "chatgpt-codex-connector[bot]",
          databaseId: 201,
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(201);
  });

  it("applies severity threshold filter", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          id: "t1",
          databaseId: 100,
          body: "P0 Critical\n\nDetails.",
        }),
        makeThread({
          id: "t2",
          databaseId: 101,
          body: "P3 Cosmetic\n\nMinor style.",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P1",
      "token",
      deps,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P0");
  });

  it("skips threads with unparseable severity", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          id: "t1",
          databaseId: 100,
          body: "General observation about naming conventions.",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(0);
  });

  it("handles pagination across multiple pages", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi)
      .mockResolvedValueOnce(
        makeGraphQLResponse(
          [makeThread({ id: "t1", databaseId: 100 })],
          true,
          "cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        makeGraphQLResponse(
          [makeThread({ id: "t2", databaseId: 101 })],
          false,
        ),
      );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(2);
    expect(deps.ghApi).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(deps.ghApi).mock.calls[1][0] as string[];
    const cursorIdx = secondCallArgs.indexOf("cursor=cursor-1");
    expect(cursorIdx).toBeGreaterThan(-1);
  });

  it("warns and returns empty on malformed GraphQL response", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      JSON.stringify({ data: { repository: null } }),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(0);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("no reviewThreads container"),
    );
  });

  it("returns empty when there are no review threads", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(makeGraphQLResponse([]));

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(0);
  });

  it("handles file-level findings (null line)", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          id: "t1",
          databaseId: 100,
          line: null,
          path: "src/config.ts",
          body: "P1 Missing validation\n\nFile lacks input validation.",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeNull();
    expect(findings[0].path).toBe("src/config.ts");
  });

  it("skips nodes without a string id", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ghApi).mockResolvedValueOnce(
      makeGraphQLResponse([
        { isResolved: false, path: "src/foo.ts", comments: { nodes: [] } },
        makeThread({ id: "t2", databaseId: 200 }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(
      "owner",
      "repo",
      1,
      "chatgpt-codex-connector[bot]",
      "P2",
      "token",
      deps,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(200);
  });
});

describe("hasPushSinceLastReview", () => {
  it("returns false when lastCodexReviewReceivedAt is null", () => {
    expect(hasPushSinceLastReview(null, "2026-06-01T12:00:00Z")).toBe(false);
  });

  it("returns true when commit date is after last review", () => {
    expect(
      hasPushSinceLastReview("2026-06-01T10:00:00Z", "2026-06-01T12:00:00Z"),
    ).toBe(true);
  });

  it("returns false when commit date equals last review", () => {
    expect(
      hasPushSinceLastReview("2026-06-01T12:00:00Z", "2026-06-01T12:00:00Z"),
    ).toBe(false);
  });

  it("returns false when commit date is before last review", () => {
    expect(
      hasPushSinceLastReview("2026-06-01T12:00:00Z", "2026-06-01T10:00:00Z"),
    ).toBe(false);
  });
});
