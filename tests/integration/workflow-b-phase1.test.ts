import { describe, it, expect } from "vitest";
import { filterAndParseComments } from "../../src/review-collector.js";
import { computeFindingsHash } from "../../src/findings-hash.js";
import { isLoop } from "../../src/loop-detector.js";
import type { RawReviewComment, FindingsHashEntry } from "../../src/types.js";
import multipleCodexFindings from "../fixtures/multiple-codex-findings.json";

describe("Workflow B Phase 1: review collection → findings → loop check", () => {
  const codexBot = "chatgpt-codex-connector[bot]";

  const mockComments: RawReviewComment[] = [
    {
      id: 100,
      user: { login: codexBot },
      body: "[P0] Token refresh path can bypass expiry validation\n\nThe token refresh logic skips expiry check when the token is marked as 'auto-renew'. This allows expired sessions to persist indefinitely.\n\nUseful? React with 👍 / 👎.",
      path: "src/auth/session.ts",
      line: 84,
      createdAt: "2026-03-20T11:05:00Z",
    },
    {
      id: 101,
      user: { login: codexBot },
      body: "P1 Unauthenticated requests reach protected handler\n\nUnder the else branch, requests without a valid session cookie are forwarded to the protected handler without any check.\n\nUseful? React with 👍 / 👎.",
      path: "src/auth/middleware.ts",
      line: 42,
      createdAt: "2026-03-20T11:05:30Z",
    },
    {
      id: 102,
      user: { login: codexBot },
      body: "P2 Consider using const instead of let\n\nMinor style suggestion.\n\nUseful? React with 👍 / 👎.",
      path: "src/utils.ts",
      line: 10,
      createdAt: "2026-03-20T11:06:00Z",
    },
    {
      id: 103,
      user: { login: "human-reviewer" },
      body: "P0 This looks wrong to me",
      path: "src/app.ts",
      line: 5,
      createdAt: "2026-03-20T11:07:00Z",
    },
  ];

  it("extracts P0/P1/P2 findings from Codex bot, ignoring humans", () => {
    const { findings } = filterAndParseComments(mockComments, codexBot, null, "P2");
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].path).toBe("src/auth/session.ts");
    expect(findings[0].title).toBe("Token refresh path can bypass expiry validation");
    expect(findings[0].body).not.toContain("Useful?");
    expect(findings[1].severity).toBe("P1");
    expect(findings[2].severity).toBe("P2");
  });

  it("filters by time when lastReceivedAt is provided", () => {
    const { findings } = filterAndParseComments(mockComments, codexBot, "2026-03-20T11:05:15Z", "P2");
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("P1");
    expect(findings[1].severity).toBe("P2");
  });

  it("computes hash and detects no loop on first iteration", () => {
    const { findings } = filterAndParseComments(mockComments, codexBot, null, "P2");
    const hash = computeFindingsHash(findings);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(isLoop(findings, [])).toBe(false);
  });

  it("detects loop when same findings reappear", () => {
    const { findings } = filterAndParseComments(mockComments, codexBot, null, "P2");
    const hash = computeFindingsHash(findings);
    const history: FindingsHashEntry[] = [{ iteration: 1, hash }];
    expect(isLoop(findings, history)).toBe(true);
  });

  it("extracts multiple same-file and multi-file P0/P1/P2 fixture findings", () => {
    const { findings } = filterAndParseComments(
      multipleCodexFindings as RawReviewComment[],
      codexBot,
      null,
      "P2",
    );

    expect(findings.map((finding) => ({
      severity: finding.severity,
      path: finding.path,
      title: finding.title,
    }))).toEqual([
      {
        severity: "P1",
        path: "src/same.ts",
        title: "Same-file guard can be bypassed",
      },
      {
        severity: "P0",
        path: "src/same.ts",
        title: "Same-file unsafe default remains enabled",
      },
      {
        severity: "P2",
        path: "src/other.ts",
        title: "Cross-file cleanup is missing",
      },
    ]);
  });
});
