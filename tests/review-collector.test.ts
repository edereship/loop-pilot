import { describe, it, expect } from "vitest";
import {
  filterAndParseComments,
  parseReviewCommentRecord,
  shouldStabilizeReviewComments,
  stabilizeReviewComments,
} from "../src/review-collector";
import type { RawReviewComment } from "../src/types";

const BOT_LOGIN = "openai-codex[bot]";

function makeComment(
  overrides: Partial<RawReviewComment> & { body: string }
): RawReviewComment {
  return {
    id: 1,
    user: { login: BOT_LOGIN },
    body: overrides.body,
    path: "src/foo.ts",
    line: 10,
    createdAt: "2024-01-10T00:00:00Z",
    ...overrides,
  };
}

describe("parseReviewCommentRecord", () => {
  it("parses a single JSON object line emitted by gh --jq", () => {
    const comment = makeComment({ id: 10, body: "P1 Existing issue" });
    const line = JSON.stringify(comment);

    const parsed = parseReviewCommentRecord(line);

    expect(parsed).toEqual(comment);
  });

  it("parses a JSON-encoded string line for compatibility", () => {
    const comment = makeComment({ id: 11, body: "P1 Existing issue" });
    const line = JSON.stringify(JSON.stringify(comment));

    const parsed = parseReviewCommentRecord(line);

    expect(parsed).toEqual(comment);
  });
});

describe("filterAndParseComments", () => {
  it("extracts P0, P1, and P2 findings from Codex bot comments", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Null dereference\n\nFix the null check." }),
      makeComment({ id: 2, body: "P1 Missing type annotation\n\nAdd return type." }),
      makeComment({ id: 3, body: "P2 Style issue\n\nPrefer a smaller helper." }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, null);

    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].title).toBe("Null dereference");
    expect(findings[0].body).toBe("Fix the null check.");
    expect(findings[0].path).toBe("src/foo.ts");
    expect(findings[0].line).toBe(10);
    expect(findings[1].severity).toBe("P1");
    expect(findings[1].title).toBe("Missing type annotation");
    expect(findings[2].severity).toBe("P2");
    expect(findings[2].title).toBe("Style issue");
  });

  it("filters out comments from non-Codex bot users", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Critical bug", user: { login: "human-reviewer" } }),
      makeComment({ id: 2, body: "P1 Minor issue", user: { login: BOT_LOGIN } }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, null);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
  });

  it("includes P2 findings", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Critical\n\nFix immediately." }),
      makeComment({ id: 2, body: "P2 Low priority\n\nCould improve later." }),
      makeComment({ id: 3, body: "P1 Important\n\nShould fix soon." }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, null);

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["P0", "P2", "P1"]);
  });

  it("filters by createdAt when lastReceivedAt is provided", () => {
    const lastReceivedAt = "2024-01-10T12:00:00Z";
    const comments: RawReviewComment[] = [
      makeComment({
        id: 1,
        body: "P0 Old issue",
        createdAt: "2024-01-10T10:00:00Z", // before threshold — excluded
      }),
      makeComment({
        id: 2,
        body: "P1 New issue",
        createdAt: "2024-01-10T13:00:00Z", // after threshold — included
      }),
      makeComment({
        id: 3,
        body: "P0 Exactly at threshold",
        createdAt: "2024-01-10T12:00:00Z", // equal — excluded (must be strictly after)
      }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, lastReceivedAt);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].title).toBe("New issue");
  });

  it("includes all bot comments when lastReceivedAt is null", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Issue one", createdAt: "2024-01-01T00:00:00Z" }),
      makeComment({ id: 2, body: "P1 Issue two", createdAt: "2020-06-15T08:30:00Z" }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, null);

    expect(findings).toHaveLength(2);
  });

  it("maps null line number to 0", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 File-level comment", line: null }),
    ];

    const findings = filterAndParseComments(comments, BOT_LOGIN, null);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(0);
  });
});

describe("shouldStabilizeReviewComments", () => {
  it("starts stabilization when no bot inline comments exist and summary suggests findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P2 issues that should be fixed."
      )
    ).toBe(true);
  });

  it("skips stabilization when comments already exist", () => {
    expect(
      shouldStabilizeReviewComments(
        [makeComment({ id: 1, body: "P1 Existing issue" })],
        BOT_LOGIN,
        null,
        "Codex Review found P1 issues that should be fixed."
      )
    ).toBe(false);
  });

  it("skips stabilization when summary says there are no findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review completed. No P0/P1/P2 findings."
      )
    ).toBe(false);
  });
});

describe("stabilizeReviewComments", () => {
  it("waits until comment count increases and then stabilizes", async () => {
    const first = [] as RawReviewComment[];
    const second = [makeComment({ id: 2, body: "P1 New issue" })];
    const fetches = [second, second, second];
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments(first, {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      intervalMs: 10,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => fetches.shift() ?? second,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result).toEqual(second);
    expect(sleepCalls).toEqual([10, 10, 10]);
  });

  it("returns zero comments after zero count is stable", async () => {
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments([], {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => [],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result).toEqual([]);
    expect(sleepCalls).toEqual([5, 5]);
  });

  it("does not poll when stabilization is not needed", async () => {
    let fetchCount = 0;
    const initial = [makeComment({ id: 1, body: "P1 Existing issue" })];

    const result = await stabilizeReviewComments(initial, {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => {
        fetchCount += 1;
        return [];
      },
      sleep: async () => {},
    });

    expect(result).toEqual(initial);
    expect(fetchCount).toBe(0);
  });
});
