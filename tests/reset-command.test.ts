import { describe, expect, it, vi } from "vitest";
import {
  applyResetToState,
  handleResetCommand,
  isResetCommandLike,
  parseResetCommand,
  pickPermission,
} from "../src/reset-command.js";
import { createInitialState, type ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    status: "stopped",
    stopReason: "claude_api_error",
    iterationCount: 3,
    lastProcessedReviewId: 111,
    lastClaudeCommitSha: "abc123",
    lastCodexRequestCommentId: 222,
    lastCodexReviewReceivedAt: "2026-05-07T01:00:00Z",
    lastFindingsHash: "hash-a",
    findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
    ...overrides,
  };
}

function foundState(state: ReviewState): ReadStateResult {
  return { found: true, corrupted: false, state, commentId: 999 };
}

function makeDeps() {
  return {
    getPrAuthor: vi.fn(async () => "pr-author"),
    getCollaboratorPermission: vi.fn(async () => "write"),
    updateStateComment: vi.fn(async () => undefined),
    postComment: vi.fn(async () => 12345),
    addEyesReaction: vi.fn(async () => undefined),
  };
}

describe("parseResetCommand", () => {
  it("parses soft and hard reset commands only when they are standalone lines", () => {
    expect(parseResetCommand("/reset-review")).toEqual({ isReset: true, mode: "soft" });
    expect(parseResetCommand("/reset-review --hard")).toEqual({ isReset: true, mode: "hard" });
    expect(parseResetCommand("/Reset-Review")).toEqual({ isReset: true, mode: "soft" });
    expect(parseResetCommand("/RESET-REVIEW --hard")).toEqual({ isReset: true, mode: "hard" });
    expect(parseResetCommand("please /reset-review")).toEqual({ isReset: false });
    expect(parseResetCommand("/reset-review now")).toEqual({
      isReset: true,
      invalidReason: "unsupported_option",
    });
  });

  it("tolerates trailing newlines that GitHub may append to comment bodies", () => {
    expect(parseResetCommand("/reset-review\n")).toEqual({ isReset: true, mode: "soft" });
    expect(parseResetCommand("/reset-review --hard\r\n")).toEqual({ isReset: true, mode: "hard" });
  });

  it("rejects forms that Workflow B's `if:` would not trigger on, to avoid runtime/workflow drift", () => {
    // Workflow B accepts only `body == '/reset-review'` or `startsWith(body, '/reset-review ')`
    // (single literal space, no leading whitespace). Forms below would be parsed as commands
    // here but never reach the runtime, leaving the user without an audit reply.
    expect(parseResetCommand(" /reset-review")).toEqual({ isReset: false });
    expect(parseResetCommand(" /reset-review ")).toEqual({ isReset: false });
    expect(parseResetCommand("/reset-review\t--hard")).toEqual({ isReset: false });
    // An interior newline breaks `startsWith('/reset-review ')` on the workflow side.
    expect(parseResetCommand("/reset-review\n--hard")).toEqual({ isReset: false });
  });

  it("detects reset-like comments broadly for workflow/runtime dispatch", () => {
    expect(isResetCommandLike("/reset-review")).toBe(true);
    expect(isResetCommandLike("/Reset-Review")).toBe(true);
    expect(isResetCommandLike("/reset-review --hard")).toBe(true);
    expect(isResetCommandLike("/reset-review --force")).toBe(true);
    expect(isResetCommandLike("/reset-reviewing")).toBe(false);
    expect(isResetCommandLike("@bot /reset-review")).toBe(false);
  });

  it("isResetCommandLike rejects whitespace forms that Workflow B would not trigger on", () => {
    expect(isResetCommandLike(" /reset-review")).toBe(false);
    expect(isResetCommandLike("/reset-review\t--hard")).toBe(false);
  });
});

describe("pickPermission", () => {
  it("prefers role_name when it matches a built-in tier so maintain/triage are not collapsed", () => {
    expect(pickPermission("maintain", "write")).toBe("maintain");
    expect(pickPermission("triage", "read")).toBe("triage");
    expect(pickPermission("admin", "admin")).toBe("admin");
  });

  it("falls back to base permission when role_name is a custom role outside the built-in tiers", () => {
    // GitHub Enterprise / orgs with custom roles return arbitrary role_name
    // values while still reporting the underlying base permission. Reset
    // recovery must keep working in that case.
    expect(pickPermission("Reviewer", "write")).toBe("write");
    expect(pickPermission("auto-review-admin", "admin")).toBe("admin");
    expect(pickPermission("Spectator", "read")).toBe("read");
  });

  it("returns 'none' when both fields are missing or unrecognized", () => {
    expect(pickPermission(null, null)).toBe("none");
    expect(pickPermission("CustomRole", null)).toBe("none");
    expect(pickPermission("CustomRole", "garbage")).toBe("none");
  });
});

describe("applyResetToState", () => {
  it("soft-resets recoverable stopped state while preserving counters and history", () => {
    const state = makeState({ stopReason: "claude_api_error" });

    const result = applyResetToState(state, "soft");

    expect(result).toEqual({
      ok: true,
      nextState: {
        ...state,
        status: "waiting_codex",
        stopReason: null,
      },
      previousStopReason: "claude_api_error",
    });
  });

  it("hard-resets max_iterations by clearing iteration count and findings history", () => {
    const state = makeState({
      stopReason: "max_iterations",
      iterationCount: 20,
      findingsHashHistory: [{ iteration: 20, hash: "loop" }],
    });

    const result = applyResetToState(state, "hard");

    expect(result.ok).toBe(true);
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      stopReason: null,
      iterationCount: 0,
      findingsHashHistory: [],
    });
  });

  it("rejects soft reset for max_iterations because iteration count must be cleared", () => {
    const result = applyResetToState(makeState({ stopReason: "max_iterations" }), "soft");

    expect(result).toEqual({ ok: false, reason: "hard_required" });
  });

  it("keeps waiting_codex idempotent without changing state", () => {
    const state = makeState({ status: "waiting_codex", stopReason: null });

    const result = applyResetToState(state, "soft");

    expect(result).toEqual({ ok: true, nextState: state, noChange: true, previousStopReason: null });
  });

  it("rejects done and state_corrupted states", () => {
    expect(applyResetToState(makeState({ status: "done", stopReason: "no_findings" }), "hard")).toEqual({
      ok: false,
      reason: "already_done",
    });
    expect(applyResetToState(makeState({ stopReason: "state_corrupted" }), "hard")).toEqual({
      ok: false,
      reason: "state_corrupted",
    });
  });

  it("rejects non-terminal in-progress states except waiting_codex idempotency", () => {
    expect(applyResetToState(makeState({ status: "initialized", stopReason: null }), "soft")).toEqual({
      ok: false,
      reason: "unsupported_status",
    });
    expect(applyResetToState(makeState({ status: "fixing", stopReason: null }), "hard")).toEqual({
      ok: false,
      reason: "unsupported_status",
    });
  });
});

describe("handleResetCommand", () => {
  it("updates state, comments an audit record, and reacts with eyes when accepted", async () => {
    const deps = makeDeps();
    const state = makeState({ stopReason: "claude_api_error" });

    const result = await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "operator",
        resetRoles: "author,write,maintain,admin",
        githubToken: "token",
        stateResult: foundState(state),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      999,
      { ...state, status: "waiting_codex", stopReason: null },
      "token",
    );
    expect(deps.postComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      14,
      expect.stringContaining("🟢 Auto-review reset accepted by @operator."),
      "token",
    );
    expect(deps.postComment.mock.calls[0][3]).toContain("mode: soft");
    expect(deps.postComment.mock.calls[0][3]).toContain("from: claude_api_error");
    expect(deps.addEyesReaction).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      777,
      "token",
    );
  });

  it("allows the PR author even when collaborator permission is read", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "pr-author",
        resetRoles: "author",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.updateStateComment).toHaveBeenCalled();
  });

  it("accepts maintain-role users when AUTO_REVIEW_RESET_ROLES includes maintain", async () => {
    // Regression: prior to using `.role_name`, the GitHub permission API
    // collapsed `maintain` to `write`, so `AUTO_REVIEW_RESET_ROLES=maintain`
    // never matched and maintain users were silently rejected.
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("maintain");

    await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "maintainer",
        resetRoles: "maintain,admin",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.updateStateComment).toHaveBeenCalled();
  });

  it("rejects maintain-role users when only write is configured (role tiers are no longer collapsed)", async () => {
    // Regression: write-tier configurations should not implicitly grant
    // maintain users — the legacy `.permission` field hid this distinction.
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("maintain");

    await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "maintainer",
        resetRoles: "write,admin",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Reset rejected: insufficient permission.",
    );
  });

  it("rejects insufficient permission without mutating state or adding a reaction", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "reader",
        resetRoles: "author,write",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.addEyesReaction).not.toHaveBeenCalled();
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Reset rejected: insufficient permission.",
    );
    expect(deps.postComment.mock.calls[0][3]).toContain("@reader");
  });

  it("rejects corrupted state through the reset-specific path", async () => {
    const deps = makeDeps();

    await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "operator",
        resetRoles: "author,write,maintain,admin",
        githubToken: "token",
        stateResult: { found: false, corrupted: true, commentId: 999 },
      },
      deps,
    );

    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Reset cannot apply: state is corrupted. See docs/operations/stop-and-recovery.md.",
    );
  });

  it("still succeeds when adding the eyes reaction fails after audit comment is posted", async () => {
    const deps = makeDeps();
    deps.addEyesReaction.mockRejectedValue(new Error("already reacted"));

    const result = await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "/reset-review",
        triggerUserLogin: "operator",
        resetRoles: "author,write,maintain,admin",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.postComment.mock.calls[0][3]).toContain("🟢 Auto-review reset accepted");
  });

  it("returns handled false for non-reset comments", async () => {
    const deps = makeDeps();

    const result = await handleResetCommand(
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        prNumber: 14,
        triggerCommentId: 777,
        triggerCommentBody: "Codex Review",
        triggerUserLogin: "operator",
        resetRoles: "author,write,maintain,admin",
        githubToken: "token",
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(result).toEqual({ handled: false });
    expect(deps.postComment).not.toHaveBeenCalled();
  });
});
