import { describe, it, expect } from "vitest";
import {
  createInitialState,
  serializeState,
  deserializeState,
} from "../src/state-manager.js";
import type { ReviewState, FindingsHashEntry } from "../src/types.js";

const STATE_MARKER = "auto-review-state";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    ...overrides,
  };
}

describe("serializeState", () => {
  it("serializes to hidden comment format (contains marker + JSON + closing)", () => {
    const state = makeState();
    const serialized = serializeState(state);

    expect(serialized).toContain(`<!-- ${STATE_MARKER}`);
    expect(serialized).toContain("-->");
    // The JSON content should be parseable
    const jsonMatch = serialized.match(
      /<!-- auto-review-state\n([\s\S]*?)\n-->/,
    );
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toMatchObject({ iterationCount: 0 });
  });

  it("round-trip: serialize then deserialize preserves state", () => {
    const original = makeState({
      iterationCount: 3,
      lastProcessedReviewId: 42,
      lastClaudeCommitSha: "abc123",
      lastCodexRequestCommentId: 7,
      lastCodexReviewReceivedAt: "2026-01-01T00:00:00Z",
      lastFindingsHash: "hash1",
      findingsHashHistory: [
        { iteration: 1, hash: "aaa" },
        { iteration: 2, hash: "bbb" },
        { iteration: 3, hash: "ccc" },
      ],
      status: "fixing",
      stopReason: null,
    });

    const serialized = serializeState(original);
    const restored = deserializeState(serialized);

    expect(restored).not.toBeNull();
    expect(restored!.iterationCount).toBe(3);
    expect(restored!.lastProcessedReviewId).toBe(42);
    expect(restored!.lastClaudeCommitSha).toBe("abc123");
    expect(restored!.lastCodexRequestCommentId).toBe(7);
    expect(restored!.lastCodexReviewReceivedAt).toBe("2026-01-01T00:00:00Z");
    expect(restored!.lastFindingsHash).toBe("hash1");
    expect(restored!.status).toBe("fixing");
    expect(restored!.stopReason).toBeNull();
    expect(restored!.findingsHashHistory).toHaveLength(3);
  });

  it("trims findingsHashHistory to max 3 entries on serialization", () => {
    const longHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: "aaa" },
      { iteration: 2, hash: "bbb" },
      { iteration: 3, hash: "ccc" },
      { iteration: 4, hash: "ddd" },
      { iteration: 5, hash: "eee" },
    ];
    const state = makeState({ findingsHashHistory: longHistory });
    const serialized = serializeState(state);
    const restored = deserializeState(serialized);

    expect(restored).not.toBeNull();
    // Should keep only the most recent 3 entries
    expect(restored!.findingsHashHistory).toHaveLength(3);
    expect(restored!.findingsHashHistory[0].hash).toBe("ccc");
    expect(restored!.findingsHashHistory[1].hash).toBe("ddd");
    expect(restored!.findingsHashHistory[2].hash).toBe("eee");
  });
});

describe("deserializeState", () => {
  it("returns null for a comment body without the state marker", () => {
    const body = "This is just a regular PR comment with no state.";
    expect(deserializeState(body)).toBeNull();
  });

  it("returns null for a comment body with corrupted JSON", () => {
    const corruptedBody = `<!-- auto-review-state\n{not valid json\n-->`;
    expect(deserializeState(corruptedBody)).toBeNull();
  });
});

describe("createInitialState", () => {
  it("returns a ReviewState with correct initial defaults", () => {
    const state = createInitialState();

    expect(state.iterationCount).toBe(0);
    expect(state.lastProcessedReviewId).toBeNull();
    expect(state.lastClaudeCommitSha).toBeNull();
    expect(state.lastCodexRequestCommentId).toBeNull();
    expect(state.lastCodexReviewReceivedAt).toBeNull();
    expect(state.lastFindingsHash).toBeNull();
    expect(state.findingsHashHistory).toEqual([]);
    expect(state.status).toBe("initialized");
    expect(state.stopReason).toBeNull();
  });
});
