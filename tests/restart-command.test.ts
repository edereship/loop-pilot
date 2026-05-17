import { describe, expect, it, vi } from "vitest";
import {
  applyRestartToState,
  handleRestartCommand,
  isRestartCommandLike,
  parseRestartCommand,
  type RestartCommandDeps,
} from "../src/restart-command.js";
import { createInitialState, type ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    status: "done",
    stopReason: "no_findings",
    iterationCount: 4,
    lastProcessedReviewId: 111,
    lastClaudeCommitSha: "abc123",
    lastCodexRequestCommentId: 222,
    lastCodexReviewReceivedAt: "2026-05-07T01:00:00Z",
    lastFindingsHash: "hash-a",
    findingsHashHistory: [{ iteration: 4, hash: "hash-a" }],
    ...overrides,
  };
}

function foundState(state: ReviewState): ReadStateResult {
  return {
    found: true,
    corrupted: false,
    state,
    commentId: 999,
    commentUpdatedAt: "2026-05-07T00:00:00Z",
  };
}

function makeDeps() {
  return {
    getPrAuthor: vi.fn<RestartCommandDeps["getPrAuthor"]>(async () => "pr-author"),
    getCollaboratorPermission: vi.fn<RestartCommandDeps["getCollaboratorPermission"]>(
      async () => "write",
    ),
    updateStateComment: vi.fn<RestartCommandDeps["updateStateComment"]>(async () => undefined),
    postComment: vi.fn<RestartCommandDeps["postComment"]>(async () => 12345),
    postCodexReviewRequest: vi.fn<RestartCommandDeps["postCodexReviewRequest"]>(
      async () => 45678,
    ),
    addEyesReaction: vi.fn<RestartCommandDeps["addEyesReaction"]>(async () => undefined),
  };
}

describe("parseRestartCommand", () => {
  it("parses soft and hard restart commands", () => {
    expect(parseRestartCommand("/restart-review")).toEqual({ isRestart: true, mode: "soft" });
    expect(parseRestartCommand("/restart-review --hard")).toEqual({ isRestart: true, mode: "hard" });
    expect(parseRestartCommand("/Restart-Review")).toEqual({ isRestart: true, mode: "soft" });
    expect(parseRestartCommand("/restart-review now")).toEqual({
      isRestart: true,
      invalidReason: "unsupported_option",
    });
  });

  it("detects restart-like comments for workflow/runtime dispatch", () => {
    expect(isRestartCommandLike("/restart-review")).toBe(true);
    expect(isRestartCommandLike("/restart-review --hard")).toBe(true);
    expect(isRestartCommandLike("/restart-reviewing")).toBe(false);
    expect(isRestartCommandLike("@bot /restart-review")).toBe(false);
  });
});

describe("applyRestartToState", () => {
  it("soft-restarts done(no_findings), preserving counters, timestamp baseline, and stopReason (TY-258)", () => {
    const state = makeState();

    const result = applyRestartToState(state, "soft", 45678);

    // TY-258: stopReason is now preserved across restart so pre-fix can read
    // `state.stopReason === "max_turns_exceeded"` on the next iteration.
    // Post-fix clears it on the next clean-commit transition to
    // `waiting_codex` (one-shot).
    expect(result).toEqual({
      ok: true,
      nextState: {
        ...state,
        status: "waiting_codex",
        stopReason: "no_findings",
        lastProcessedReviewId: null,
        lastCodexRequestCommentId: 45678,
      },
      previousStopReason: "no_findings",
    });
  });

  it("hard-restarts by clearing iteration count and findings history but preserves stopReason (TY-258)", () => {
    const state = makeState();

    const result = applyRestartToState(state, "hard", 45678);

    if (!result.ok) throw new Error("expected hard restart to succeed");
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      // TY-258: stopReason persists across both soft and hard restart so
      // operators can force a fresh iteration count without losing the
      // signal that the last attempt hit `max_turns_exceeded`.
      stopReason: "no_findings",
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastProcessedReviewId: null,
      lastCodexReviewReceivedAt: state.lastCodexReviewReceivedAt,
      lastCodexRequestCommentId: 45678,
    });
  });

  it("preserves max_turns_exceeded stopReason across soft restart so pre-fix escalates (TY-258)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "max_turns_exceeded",
    });

    const result = applyRestartToState(state, "soft", 45678);

    if (!result.ok) throw new Error("expected soft restart to succeed");
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      stopReason: "max_turns_exceeded",
      lastProcessedReviewId: null,
      lastCodexRequestCommentId: 45678,
    });
  });

  it("rejects states that should not be soft-restarted", () => {
    expect(applyRestartToState(makeState({ status: "initialized", stopReason: null }), "soft", 1)).toEqual({
      ok: false,
      reason: "unsupported_status",
    });
    expect(applyRestartToState(makeState({ status: "fixing", stopReason: null }), "soft", 1)).toEqual({
      ok: false,
      reason: "unsupported_status",
    });
    expect(applyRestartToState(makeState({ status: "stopped", stopReason: "state_corrupted" }), "hard", 1)).toEqual({
      ok: false,
      reason: "state_corrupted",
    });
  });

  it("hard-restarts fixing states for operator recovery", () => {
    const state = makeState({
      status: "fixing",
      stopReason: null,
      iterationCount: 3,
      findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });

    const result = applyRestartToState(state, "hard", 45678);

    if (!result.ok) throw new Error("expected hard restart to succeed");
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      stopReason: null,
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastProcessedReviewId: null,
      lastCodexRequestCommentId: 45678,
    });
  });
});

describe("handleRestartCommand", () => {
  it("posts @codex review, updates state, comments an audit record, and reacts with eyes", async () => {
    const deps = makeDeps();
    const state = makeState();

    const result = await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "team-yubune",
      "test-auto-ai-review",
      999,
      {
        ...state,
        status: "waiting_codex",
        // TY-258: stopReason persists across restart.
        stopReason: "no_findings",
        lastProcessedReviewId: null,
        lastCodexRequestCommentId: null,
      },
      "token",
    );
    expect(deps.postCodexReviewRequest).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      18,
      "codex-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "team-yubune",
      "test-auto-ai-review",
      999,
      {
        ...state,
        status: "waiting_codex",
        stopReason: "no_findings",
        lastProcessedReviewId: null,
        lastCodexRequestCommentId: 45678,
      },
      "token",
    );
    expect(deps.updateStateComment.mock.invocationCallOrder[0]).toBeLessThan(
      deps.postCodexReviewRequest.mock.invocationCallOrder[0],
    );
    expect(deps.postCodexReviewRequest.mock.invocationCallOrder[0]).toBeLessThan(
      deps.updateStateComment.mock.invocationCallOrder[1],
    );
    expect(deps.postComment.mock.calls[0][3]).toContain("🟢 Auto-review restarted by @operator.");
    expect(deps.postComment.mock.calls[0][3]).toContain("mode: soft");
    expect(deps.postComment.mock.calls[0][3]).toContain("from: no_findings");
    expect(deps.postComment.mock.calls[0][3]).toContain("reviewRequestCommentId: 45678");
    expect(deps.addEyesReaction).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      777,
      "token",
    );
  });

  it("hard-restarts waiting_codex and replaces the review request comment id", async () => {
    const deps = makeDeps();
    const state = makeState({
      status: "waiting_codex",
      stopReason: null,
      iterationCount: 4,
      findingsHashHistory: [{ iteration: 4, hash: "hash-a" }],
    });

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.updateStateComment.mock.calls[1][3]).toMatchObject({
      status: "waiting_codex",
      // Source state has stopReason: null (waiting_codex), so it stays null.
      stopReason: null,
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastCodexRequestCommentId: 45678,
    });
  });

  it("restarts stopped states and preserves the timestamp baseline so stale comments are not reprocessed", async () => {
    const deps = makeDeps();
    const state = makeState({
      status: "stopped",
      stopReason: "test_failure",
      lastCodexReviewReceivedAt: "2026-05-07T12:34:56Z",
    });

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.updateStateComment.mock.calls[1][3]).toMatchObject({
      status: "waiting_codex",
      // TY-258: stopReason carries through restart for tier escalation.
      stopReason: "test_failure",
      lastCodexReviewReceivedAt: "2026-05-07T12:34:56Z",
      lastProcessedReviewId: null,
      lastCodexRequestCommentId: 45678,
    });
  });

  it("rejects fixing soft restart before posting @codex review", async () => {
    const deps = makeDeps();
    const state = makeState({ status: "fixing", stopReason: null });

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Restart cannot apply: current review status is not restartable.",
    );
  });

  it("hard-restarts fixing states", async () => {
    const deps = makeDeps();
    const state = makeState({
      status: "fixing",
      stopReason: null,
      iterationCount: 3,
      findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      18,
      "codex-token",
    );
    expect(deps.updateStateComment.mock.calls[1][3]).toMatchObject({
      status: "waiting_codex",
      // Source state had stopReason: null (fixing); hard restart keeps null.
      stopReason: null,
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastProcessedReviewId: null,
      lastCodexRequestCommentId: 45678,
    });
  });

  it("allows the PR author even when collaborator permission is read", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "pr-author",
        restartRoles: "author",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.updateStateComment).toHaveBeenCalled();
  });

  it("rejects insufficient permission without posting @codex review", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleRestartCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "reader",
        restartRoles: "author,write",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Restart rejected: insufficient permission.",
    );
  });
});
