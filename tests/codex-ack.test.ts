import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultCodexAckDeps,
  ensureCodexAck,
  type CodexAckDeps,
  type CodexAckParams,
} from "../src/codex-ack.js";

vi.mock("../src/gh.js", () => ({ ghApi: vi.fn() }));
const { ghApi } = await import("../src/gh.js");
const mockedGhApi = vi.mocked(ghApi);

const BOT = "chatgpt-codex-connector[bot]";

function baseParams(overrides: Partial<CodexAckParams> = {}): CodexAckParams {
  return {
    owner: "o",
    repo: "r",
    pr: 1,
    commentId: 100,
    requestedAt: "2026-05-24T00:00:00Z",
    codexBotLogin: BOT,
    readToken: "rt",
    token: "t",
    timeoutSeconds: 90,
    pollIntervalSeconds: 15,
    maxReposts: 2,
    ...overrides,
  };
}

/**
 * Deterministic clock: `now()` reads a counter that `sleep()` advances. This
 * lets the poll loop "wait" through whole windows synchronously.
 */
function makeDeps(over: Partial<CodexAckDeps> = {}): CodexAckDeps {
  let clock = 0;
  return {
    getEyesReactors: vi.fn().mockResolvedValue([]),
    hasNewCodexActivity: vi.fn().mockResolvedValue(false),
    postCodexReviewRequest: vi.fn().mockResolvedValue(200),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    info: vi.fn(),
    warning: vi.fn(),
    ...over,
  };
}

describe("ensureCodexAck (TY-334)", () => {
  it("#A: 👀 within the timeout → no repost, acked on first window", async () => {
    const deps = makeDeps({
      getEyesReactors: vi.fn().mockResolvedValue([BOT]),
    });

    const result = await ensureCodexAck(baseParams(), deps);

    expect(result).toEqual({
      acked: true,
      reason: "eyes",
      reposts: 0,
      lastCommentId: 100,
    });
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("#B: no 👀 first window → 1 repost → 👀 on second window → stop", async () => {
    let reposted = false;
    const deps = makeDeps({
      postCodexReviewRequest: vi.fn(async () => {
        reposted = true;
        return 200;
      }),
      getEyesReactors: vi.fn(async () => (reposted ? [BOT] : [])),
    });

    const result = await ensureCodexAck(baseParams(), deps);

    expect(result.acked).toBe(true);
    expect(result.reason).toBe("eyes");
    expect(result.reposts).toBe(1);
    expect(result.lastCommentId).toBe(200);
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
  });

  it("#C: never acked → reposts up to the cap → stopped/exhausted", async () => {
    const deps = makeDeps();

    const result = await ensureCodexAck(baseParams({ maxReposts: 2 }), deps);

    expect(result.acked).toBe(false);
    expect(result.reason).toBe("exhausted");
    expect(result.reposts).toBe(2);
    // lastCommentId reflects the final reposted comment, not the original.
    expect(result.lastCommentId).toBe(200);
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(2);
  });

  it("#D: new Codex activity since requestedAt → acked without reposting", async () => {
    const deps = makeDeps({
      hasNewCodexActivity: vi.fn().mockResolvedValue(true),
    });

    const result = await ensureCodexAck(baseParams(), deps);

    expect(result.acked).toBe(true);
    expect(result.reason).toBe("new_activity");
    expect(result.reposts).toBe(0);
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("#E: a 👀 from a non-Codex user is not an ACK", async () => {
    const deps = makeDeps({
      getEyesReactors: vi.fn().mockResolvedValue(["some-human", "another-bot"]),
    });

    // maxReposts 0 → one window then give up, so the test stays bounded.
    const result = await ensureCodexAck(baseParams({ maxReposts: 0 }), deps);

    expect(result.acked).toBe(false);
    expect(result.reason).toBe("exhausted");
    expect(deps.getEyesReactors).toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("treats timeoutSeconds <= 0 as disabled (no polling, no repost)", async () => {
    const deps = makeDeps();

    const result = await ensureCodexAck(baseParams({ timeoutSeconds: 0 }), deps);

    expect(result).toEqual({
      acked: true,
      reason: "disabled",
      reposts: 0,
      lastCommentId: 100,
    });
    expect(deps.getEyesReactors).not.toHaveBeenCalled();
    expect(deps.hasNewCodexActivity).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("a failed repost is treated as exhausted rather than thrown", async () => {
    const deps = makeDeps({
      postCodexReviewRequest: vi.fn().mockRejectedValue(new Error("403")),
    });

    const result = await ensureCodexAck(baseParams({ maxReposts: 2 }), deps);

    expect(result.acked).toBe(false);
    expect(result.reason).toBe("exhausted");
    expect(result.reposts).toBe(0);
    expect(deps.warning).toHaveBeenCalled();
  });

  it("a transient reaction-read error does not abort polling", async () => {
    let calls = 0;
    const deps = makeDeps({
      getEyesReactors: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("502 bad gateway");
        return [BOT];
      }),
    });

    const result = await ensureCodexAck(baseParams(), deps);

    expect(result.acked).toBe(true);
    expect(result.reason).toBe("eyes");
    expect(deps.warning).toHaveBeenCalled();
  });

  it("read ops use readToken, repost uses token", async () => {
    const capturedReadTokens: string[] = [];
    const capturedWriteTokens: string[] = [];
    const deps = makeDeps({
      getEyesReactors: vi.fn(async (_o, _r, _id, token) => {
        capturedReadTokens.push(token);
        return [BOT];
      }),
      hasNewCodexActivity: vi.fn(async (_o, _r, _pr, _bot, _since, token) => {
        capturedReadTokens.push(token);
        return false;
      }),
      postCodexReviewRequest: vi.fn(async (_o, _r, _pr, token) => {
        capturedWriteTokens.push(token);
        return 200;
      }),
    });

    await ensureCodexAck(baseParams({ readToken: "rt", token: "wt" }), deps);

    expect(capturedReadTokens.every((t) => t === "rt")).toBe(true);
    expect(capturedWriteTokens.every((t) => t === "wt")).toBe(true);
  });
});

describe("defaultCodexAckDeps default IO (TY-334)", () => {
  beforeEach(() => {
    mockedGhApi.mockReset();
  });

  it("getEyesReactors returns the logins that reacted 👀", async () => {
    mockedGhApi.mockResolvedValueOnce(`${BOT}\nsome-human\n`);
    const reactors = await defaultCodexAckDeps.getEyesReactors("o", "r", 100, "t");
    expect(reactors).toEqual([BOT, "some-human"]);
  });

  it("hasNewCodexActivity detects a new Codex issue comment and short-circuits", async () => {
    mockedGhApi.mockResolvedValueOnce(`${BOT}|2026-05-24T00:05:00Z\n`);
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T00:00:00.000Z",
      "t",
    );
    expect(result).toBe(true);
    // No need to query the reviews endpoint once an issue comment matches.
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
  });

  it("hasNewCodexActivity ignores an old Codex comment that was edited inside the since window (TY-339 #2)", async () => {
    // `since` filters by updated_at, so editing a pre-existing Codex comment
    // (created before the request) resurfaces it in the issue-comments fetch.
    // Gating on created_at must not treat that edit as a fresh ACK; without a
    // new comment/review the function falls through to the reviews endpoint.
    mockedGhApi
      .mockResolvedValueOnce(`${BOT}|2026-05-24T00:00:00Z\n`) // created_at BEFORE sinceIso
      .mockResolvedValueOnce(""); // no Codex review either
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T01:00:00.000Z",
      "t",
    );
    expect(result).toBe(false);
    // Both endpoints are queried because the edited-but-old comment is not an ACK.
    expect(mockedGhApi).toHaveBeenCalledTimes(2);
  });

  it("hasNewCodexActivity ignores issue comments authored by other users", async () => {
    mockedGhApi
      .mockResolvedValueOnce(`some-human|2026-05-24T00:05:00Z\n`)
      .mockResolvedValueOnce("");
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T00:00:00.000Z",
      "t",
    );
    expect(result).toBe(false);
  });

  it("hasNewCodexActivity detects a Codex PR review even with the 👀 removed", async () => {
    mockedGhApi
      .mockResolvedValueOnce("") // no new issue comments
      .mockResolvedValueOnce(`${BOT}|2026-05-24T00:05:00Z\n`);
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T00:00:00.000Z",
      "t",
    );
    expect(result).toBe(true);
    expect(mockedGhApi).toHaveBeenCalledTimes(2);
  });

  it("hasNewCodexActivity ignores a Codex review submitted before the request", async () => {
    mockedGhApi
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(`${BOT}|2026-05-24T00:00:00Z\n`);
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T01:00:00.000Z",
      "t",
    );
    expect(result).toBe(false);
  });

  it("hasNewCodexActivity ignores reviews submitted by other users", async () => {
    mockedGhApi
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(`some-human|2026-05-24T00:05:00Z\n`);
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T00:00:00.000Z",
      "t",
    );
    expect(result).toBe(false);
  });

  it("hasNewCodexActivity does not misclassify a same-second review as new when sinceIso has sub-second precision", async () => {
    // submitted_at = "...43Z" (second precision, i.e. 43.000s)
    // sinceIso     = "...43.500Z" (millisecond precision, i.e. 43.500s)
    // The review was submitted 500ms BEFORE sinceIso — must return false.
    // A lexicographic compare would incorrectly return true ("Z" > ".").
    mockedGhApi
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(`${BOT}|2026-05-24T00:00:43Z\n`);
    const result = await defaultCodexAckDeps.hasNewCodexActivity(
      "o",
      "r",
      1,
      BOT,
      "2026-05-24T00:00:43.500Z",
      "t",
    );
    expect(result).toBe(false);
  });
});
