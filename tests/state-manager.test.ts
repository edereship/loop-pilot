import { describe, it, expect } from "vitest";
import {
  createInitialState,
  serializeState,
  deserializeState,
  parseStateCommentRecord,
  updateStateComment,
  StateUpdateConflictError,
  toHttpDate,
} from "../src/state-manager.js";
import type { ReviewState, FindingsHashEntry } from "../src/types.js";
import { execFile } from "node:child_process";
import { beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const STATE_MARKER = "auto-review-state";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    ...overrides,
  };
}

function mockExecFileOnce(stdout: string): void {
  mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
    (callback as unknown as (e: unknown, v: { stdout: string; stderr: string }) => void)(
      null,
      { stdout, stderr: "" },
    );
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

function mockExecFileErrorOnce(opts: {
  message?: string;
  stderr?: string;
  stdout?: string;
}): void {
  mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
    const err = new Error(opts.message ?? "exec failed") as Error & {
      stderr?: string;
      stdout?: string;
    };
    if (opts.stderr !== undefined) err.stderr = opts.stderr;
    if (opts.stdout !== undefined) err.stdout = opts.stdout;
    (callback as (err: Error) => void)(err);
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

describe("serializeState", () => {
  it("includes visible text so GitHub does not render it as an empty comment", () => {
    const state = makeState();
    const serialized = serializeState(state);

    expect(serialized.startsWith("Auto-review state is stored in this comment.")).toBe(true);
  });

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

describe("parseStateCommentRecord", () => {
  it("parses a single JSON object line emitted by gh --jq", () => {
    const body = serializeState(makeState({ status: "waiting_codex" }));
    const line = JSON.stringify({ id: 123, body, updated_at: "2026-05-09T00:00:00Z" });

    const parsed = parseStateCommentRecord(line);

    expect(parsed).toEqual({ id: 123, body, updatedAt: "2026-05-09T00:00:00Z" });
  });

  it("parses a JSON-encoded string line for compatibility", () => {
    const body = serializeState(makeState({ status: "waiting_codex" }));
    const line = JSON.stringify(JSON.stringify({ id: 456, body, updated_at: "2026-05-09T00:00:01Z" }));

    const parsed = parseStateCommentRecord(line);

    expect(parsed).toEqual({ id: 456, body, updatedAt: "2026-05-09T00:00:01Z" });
  });
});

describe("updateStateComment", () => {
  it("does not patch when the hidden comment updated_at changed before PATCH", async () => {
    const state = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:02Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, state, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][1]).toContain("repos/owner/repo/issues/comments/123");
    expect(mockedExecFile.mock.calls[0][1]).not.toContain("PATCH");
  });

  it("fails immediately instead of retrying with a state derived from a stale read", async () => {
    const state = makeState({ status: "fixing", iterationCount: 1 });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:02Z",
      body: serializeState(makeState({ status: "waiting_codex", iterationCount: 2 })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, state, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    for (const call of mockedExecFile.mock.calls) {
      expect(call[1]).not.toContain("PATCH");
    }
  });

  it("converts a 412 PATCH response into StateUpdateConflictError", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileErrorOnce({
      message: "gh: api failed",
      stderr: "HTTP 412: Precondition Failed",
      stdout: "",
    });

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);
  });

  it("propagates non-conflict gh failures verbatim", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileErrorOnce({
      message: "gh: api failed",
      stderr: "HTTP 500: server error",
      stdout: "",
    });

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.not.toBeInstanceOf(StateUpdateConflictError);
  });

  it("fails when the PATCH response body does not contain the expected state", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:03Z",
      body: serializeState(makeState({ status: "done" })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toThrow("PATCH response did not contain the expected hidden comment state");
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
    expect(state.previousCheckFailure).toBeNull();
  });
});

describe("deserializeState (forward compatibility)", () => {
  it("normalizes a state comment that predates the previousCheckFailure field", () => {
    // Hand-crafted body shaped like a pre-extension state comment to verify
    // existing PRs still deserialize cleanly after the field is added.
    const legacyBody = [
      "Auto-review state is stored in this comment.",
      "",
      "<!-- auto-review-state",
      JSON.stringify(
        {
          iterationCount: 1,
          lastProcessedReviewId: 42,
          lastClaudeCommitSha: "abc",
          lastCodexRequestCommentId: 7,
          lastCodexReviewReceivedAt: "2026-01-01T00:00:00Z",
          lastFindingsHash: "hash1",
          findingsHashHistory: [],
          status: "waiting_codex",
          stopReason: null,
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");

    const restored = deserializeState(legacyBody);
    expect(restored).not.toBeNull();
    expect(restored!.previousCheckFailure).toBeNull();
    expect(restored!.status).toBe("waiting_codex");
  });
});

describe("toHttpDate", () => {
  it("converts an ISO 8601 timestamp to RFC 7231 IMF-fixdate", () => {
    // GitHub returns updated_at like "2026-05-14T21:42:19Z"; the
    // If-Unmodified-Since header requires "Thu, 14 May 2026 21:42:19 GMT".
    // Without the conversion the PATCH gets rejected before the 412
    // optimistic-lock path can run.
    expect(toHttpDate("2026-05-14T21:42:19Z")).toBe(
      "Thu, 14 May 2026 21:42:19 GMT",
    );
  });

  it("preserves UTC when the source has a non-UTC offset", () => {
    expect(toHttpDate("2026-05-14T23:42:19+02:00")).toBe(
      "Thu, 14 May 2026 21:42:19 GMT",
    );
  });

  it("throws on unparseable input rather than emit `Invalid Date`", () => {
    expect(() => toHttpDate("not-a-date")).toThrow(/invalid timestamp/);
  });
});
