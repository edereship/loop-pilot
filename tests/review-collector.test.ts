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

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

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

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
  });

  it("includes P2 findings", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Critical\n\nFix immediately." }),
      makeComment({ id: 2, body: "P2 Low priority\n\nCould improve later." }),
      makeComment({ id: 3, body: "P1 Important\n\nShould fix soon." }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["P0", "P2", "P1"]);
  });

  it("includes Codex image-badge P2 findings", () => {
    const comments: RawReviewComment[] = [
      makeComment({
        id: 1,
        body:
          "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Reject soft restart for exhausted/looped states**\n\nThe restart can stop again immediately.\n\nUseful? React with 👍 / 👎.",
      }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "P2",
      title: "Reject soft restart for exhausted/looped states",
      body: "The restart can stop again immediately.",
    });
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

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, lastReceivedAt, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].title).toBe("New issue");
  });

  it("includes all bot comments when lastReceivedAt is null", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Issue one", createdAt: "2024-01-01T00:00:00Z" }),
      makeComment({ id: 2, body: "P1 Issue two", createdAt: "2020-06-15T08:30:00Z" }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(2);
  });

  it("maps null line number to 0", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 File-level comment", line: null }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(0);
  });

  // --- Threshold + skip count (TY-256) ---

  describe("severity threshold (TY-256)", () => {
    it("default threshold P2 preserves prior behavior (P0/P1/P2 in, P3 in belowThreshold)", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical\n\nFix immediately." }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P2 Style" }),
        makeComment({ id: 4, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P1", "P2"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 1 });
    });

    it("threshold P3 includes everything (no belowThreshold)", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P3");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P3"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 0 });
    });

    it("threshold P1 keeps P0/P1 and counts P2/P3 in belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P2 Style" }),
        makeComment({ id: 4, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P1");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P1"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 2 });
    });

    it("threshold P0 keeps only P0 and counts everything else in belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P3 Cosmetic" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P0");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 2 });
    });

    it("reports unparseable comments separately from belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "No severity badge at all" }),
        makeComment({ id: 3, body: "Random text with no severity tag" }),
        makeComment({ id: 4, body: "P3 Cosmetic" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0"]);
      expect(result.skipped).toEqual({ unparseable: 2, belowThreshold: 1 });
    });

    it("excludes non-bot comments from skip counters", () => {
      const comments: RawReviewComment[] = [
        makeComment({
          id: 1,
          body: "P0 Critical",
          user: { login: "human-reviewer" },
        }),
        makeComment({ id: 2, body: "Random text", user: { login: "human-reviewer" } }),
        makeComment({ id: 3, body: "P2 Style" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P2"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 0 });
    });
  });
});

describe("shouldStabilizeReviewComments", () => {
  it("starts stabilization when no bot inline comments exist and summary suggests findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P2 issues that should be fixed.",
        "P2"
      )
    ).toBe(true);
  });

  it("skips stabilization when comments already exist", () => {
    expect(
      shouldStabilizeReviewComments(
        [makeComment({ id: 1, body: "P1 Existing issue" })],
        BOT_LOGIN,
        null,
        "Codex Review found P1 issues that should be fixed.",
        "P2"
      )
    ).toBe(false);
  });

  it("skips stabilization when summary says there are no findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review completed. No P0/P1/P2 findings.",
        "P2"
      )
    ).toBe(false);
  });

  it("skips stabilization when summary only mentions below-threshold severities", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 cosmetic nit.",
        "P2"
      )
    ).toBe(false);
  });

  it("starts stabilization when summary mentions at-threshold severity", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 cosmetic nit.",
        "P3"
      )
    ).toBe(true);
  });

  it("does NOT skip stabilization when 'No PX findings' coexists with in-scope findings in the same summary", () => {
    // Regression: "No P3 findings" matched the broad no-findings pattern and
    // returned false even when P2/P1 findings were also present in the body.
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "No P3 findings. Found 2 P2 issues.",
        "P2",
      ),
    ).toBe(true);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "No P3 findings. Found 1 P1 issue.",
        "P2",
      ),
    ).toBe(true);
    // "No P3 findings" alone (no in-scope mention) should still skip stabilization
    // at threshold P2, because P3 is below the threshold.
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review completed. No P3 findings.",
        "P2",
      ),
    ).toBe(false);
  });

  it("skips stabilization for 'No P0/P1/P2/P3 findings' summaries at any threshold (TY-256)", () => {
    for (const threshold of ["P0", "P1", "P2", "P3"] as const) {
      expect(
        shouldStabilizeReviewComments(
          [],
          BOT_LOGIN,
          null,
          "Codex Review completed. No P0/P1/P2/P3 findings.",
          threshold,
        ),
      ).toBe(false);
    }
  });

  it("does NOT fall back to generic 'findings'/'issues' words when summary names a below-threshold severity (TY-256)", () => {
    // P3 mentioned but threshold is P2: severitySignal = false. With the
    // generic-keyword fallback gated by "no severity mentioned", we must NOT
    // enter stabilization just because the summary contains the word "issues".
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 issues only.",
        "P2",
      ),
    ).toBe(false);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 findings.",
        "P2",
      ),
    ).toBe(false);
  });

  it("still falls back to generic keywords when no severity is named at all (TY-256)", () => {
    // No P[0-3] in body — generic "findings" / "issues" keyword is the only
    // signal we have, so stabilization must enter (conservative default).
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found some findings that need attention.",
        "P2",
      ),
    ).toBe(true);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review noted several issues.",
        "P2",
      ),
    ).toBe(true);
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
      severityThreshold: "P2",
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
      severityThreshold: "P2",
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
      severityThreshold: "P2",
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
