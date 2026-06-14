import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchUnresolvedCodexFindings,
  UnresolvedFindingsFetchError,
} from "../src/unresolved-findings.js";

vi.mock("../src/gh.js", () => ({
  ghApi: vi.fn(),
}));

import { ghApi } from "../src/gh.js";
const mockGhApi = vi.mocked(ghApi);

function makeGraphQLResponse(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
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
  isResolved?: boolean;
  path?: string;
  line?: number | null;
  authorLogin?: string;
  body?: string;
  databaseId?: number | null;
  fullDatabaseId?: string | null;
  createdAt?: string;
}) {
  return {
    id: `thread-${opts.databaseId ?? 1}`,
    isResolved: opts.isResolved ?? false,
    path: opts.path ?? "src/index.ts",
    line: opts.line === undefined ? 10 : opts.line,
    comments: {
      nodes: [
        {
          databaseId: opts.databaseId === undefined ? 1 : opts.databaseId,
          fullDatabaseId:
            opts.fullDatabaseId === undefined ? null : opts.fullDatabaseId,
          author: { login: opts.authorLogin ?? "codex-bot" },
          body: opts.body ?? "P1 Memory leak in parser",
          createdAt: opts.createdAt ?? "2026-05-10T08:00:00Z",
        },
      ],
    },
  };
}

const defaultParams = {
  owner: "team-yubune",
  repo: "loop-pilot",
  prNumber: 99,
  codexBotLogin: "codex-bot",
  severityThreshold: "P2" as const,
  token: "github-token",
};

describe("fetchUnresolvedCodexFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unresolved Codex findings above threshold", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 101, body: "P0 Critical security bug", path: "src/auth.ts", line: 42 }),
        makeThread({ databaseId: 102, body: "P1 Memory leak", path: "src/cache.ts", line: 15 }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: "P0",
      commentId: 101,
      path: "src/auth.ts",
      line: 42,
      title: "Critical security bug",
    });
    expect(findings[1]).toMatchObject({
      severity: "P1",
      commentId: 102,
      path: "src/cache.ts",
      line: 15,
      title: "Memory leak",
    });
  });

  it("skips resolved threads", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 201, body: "P1 Bug fixed", isResolved: true }),
        makeThread({ databaseId: 202, body: "P1 Still open" }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(202);
  });

  it("skips threads not authored by Codex bot", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 301, body: "P1 Human comment", authorLogin: "human-user" }),
        makeThread({ databaseId: 302, body: "P1 Bot comment" }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(302);
  });

  it("matches Codex bot login with or without [bot] suffix (GraphQL omits it)", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          databaseId: 350,
          body: "P1 GraphQL login without [bot]",
          authorLogin: "chatgpt-codex-connector",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings({
      ...defaultParams,
      codexBotLogin: "chatgpt-codex-connector[bot]",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(350);
  });

  it("applies severity threshold filter", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 401, body: "P1 Above threshold" }),
        makeThread({ databaseId: 402, body: "P3 Below threshold" }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(401);
  });

  it("skips comments with unparseable severity", async () => {
    const warn = vi.fn();
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 501, body: "No severity badge here" }),
        makeThread({ databaseId: 502, body: "P1 Has severity" }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams, {
      warning: warn,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(502);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unparseable severity"),
    );
  });

  it("paginates through multiple pages", async () => {
    mockGhApi
      .mockResolvedValueOnce(
        makeGraphQLResponse(
          [makeThread({ databaseId: 601, body: "P1 Page 1 finding" })],
          true,
          "cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          makeThread({ databaseId: 602, body: "P1 Page 2 finding" }),
        ]),
      );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(2);
    expect(findings[0].commentId).toBe(601);
    expect(findings[1].commentId).toBe(602);
    expect(mockGhApi).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no threads exist", async () => {
    mockGhApi.mockResolvedValueOnce(makeGraphQLResponse([]));

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(0);
  });

  it("throws (fail closed) on malformed response (no reviewThreads container)", async () => {
    mockGhApi.mockResolvedValueOnce(
      JSON.stringify({ data: { repository: null } }),
    );

    await expect(fetchUnresolvedCodexFindings(defaultParams)).rejects.toThrow(
      UnresolvedFindingsFetchError,
    );
  });

  it("throws (fail closed) when the GraphQL query itself fails", async () => {
    mockGhApi.mockRejectedValueOnce(new Error("502 Bad Gateway"));

    await expect(fetchUnresolvedCodexFindings(defaultParams)).rejects.toThrow(
      UnresolvedFindingsFetchError,
    );
  });

  it("skips null/malformed thread nodes without throwing", async () => {
    const warn = vi.fn();
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        null,
        makeThread({ databaseId: 801, body: "P1 Real finding" }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams, {
      warning: warn,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(801);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("null/malformed"),
    );
  });

  it("uses fullDatabaseId when databaseId is null (64-bit ids)", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          databaseId: null,
          fullDatabaseId: "9007199254740000",
          body: "P1 64-bit id finding",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(9007199254740000);
  });

  it("prefers fullDatabaseId over the deprecated databaseId", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          databaseId: 111,
          fullDatabaseId: "222",
          body: "P1 Both ids present",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(222);
  });

  it("drops a thread when both databaseId and fullDatabaseId are unusable", async () => {
    const warn = vi.fn();
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          databaseId: null,
          fullDatabaseId: null,
          body: "P1 No id",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams, {
      warning: warn,
    });

    expect(findings).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("databaseId/fullDatabaseId"),
    );
  });

  it("carries the comment created_at on each finding", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({
          databaseId: 901,
          body: "P1 With timestamp",
          createdAt: "2026-05-12T03:04:05Z",
        }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].createdAt).toBe("2026-05-12T03:04:05Z");
  });

  it("handles null line (file-level comment)", async () => {
    mockGhApi.mockResolvedValueOnce(
      makeGraphQLResponse([
        makeThread({ databaseId: 701, body: "P1 File-level issue", line: null }),
      ]),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeNull();
  });
});
