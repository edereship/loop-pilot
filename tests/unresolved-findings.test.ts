import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUnresolvedCodexFindings } from "../src/unresolved-findings.js";

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
  databaseId?: number;
}) {
  return {
    id: `thread-${opts.databaseId ?? 1}`,
    isResolved: opts.isResolved ?? false,
    path: opts.path ?? "src/index.ts",
    line: opts.line === undefined ? 10 : opts.line,
    comments: {
      nodes: [
        {
          databaseId: opts.databaseId ?? 1,
          author: { login: opts.authorLogin ?? "codex-bot" },
          body: opts.body ?? "P1 Memory leak in parser",
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

  it("warns and returns empty on malformed response (no reviewThreads container)", async () => {
    const warn = vi.fn();
    mockGhApi.mockResolvedValueOnce(
      JSON.stringify({ data: { repository: null } }),
    );

    const findings = await fetchUnresolvedCodexFindings(defaultParams, {
      warning: warn,
    });

    expect(findings).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("missing the reviewThreads container"),
    );
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
