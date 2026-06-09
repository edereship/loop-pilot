import { describe, expect, it, vi } from "vitest";
import {
  applyRestartToState,
  handleRestartCommand,
  isRestartCommandLike,
  isValidGitHubLogin,
  parseRestartCommand,
  type RestartCommandDeps,
} from "../src/restart-command.js";
import {
  StateUpdateConflictError,
  createInitialState,
  type ReadStateResult,
} from "../src/state-manager.js";
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
    commentUpdatedAt: "2026-05-09T00:00:00Z",
  };
}

function makeDeps() {
  return {
    getPrAuthor: vi.fn<RestartCommandDeps["getPrAuthor"]>(async () => "pr-author"),
    getCollaboratorPermission: vi.fn<RestartCommandDeps["getCollaboratorPermission"]>(
      async () => "write",
    ),
    updateStateComment: vi.fn<RestartCommandDeps["updateStateComment"]>(
      async () => ({ updatedAt: "2026-05-09T00:00:01Z" }),
    ),
    postComment: vi.fn<RestartCommandDeps["postComment"]>(async () => 12345),
    postStopComment: vi.fn<RestartCommandDeps["postStopComment"]>(async () => 23456),
    postCodexReviewRequest: vi.fn<RestartCommandDeps["postCodexReviewRequest"]>(
      async () => 45678,
    ),
    ensureCodexAck: vi.fn<RestartCommandDeps["ensureCodexAck"]>(async () => ({
      acked: true,
      reason: "eyes",
      reposts: 0,
      lastCommentId: 45678,
    })),
    addRestartReaction: vi.fn<RestartCommandDeps["addRestartReaction"]>(async () => undefined),
    warning: vi.fn<RestartCommandDeps["warning"]>(),
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

  it("accepts /restart-review followed by a multi-line rationale (TY-275 #4)", () => {
    // Operators often append a trailing rationale after the command. The
    // previous parser carried the newline-containing tail into the `--hard`
    // comparison and rejected the comment as `unsupported_option`. First-line
    // extraction keeps the rationale freedom while still strictly validating
    // the command itself.
    const body = "/restart-review --hard\n\n(理由: max iterations に到達したため履歴をリセット)";
    expect(parseRestartCommand(body)).toEqual({ isRestart: true, mode: "hard" });
  });

  it("accepts soft /restart-review followed by a rationale line (TY-275 #4)", () => {
    const body = "/restart-review\n\nQuotaを使い切ったのでquota回復後に再開";
    expect(parseRestartCommand(body)).toEqual({ isRestart: true, mode: "soft" });
  });

  it("rejects /restart-review with --hard on a separate line (Codex r3257480253 — TY-275 #4 follow-up)", () => {
    // Before the follow-up, first-line extraction would reduce the comment to
    // just `/restart-review` and silently demote the operator's intended
    // hard restart to a soft one. We now detect continuation-line flags and
    // reject the whole command, preserving the pre-TY-275 strictness for
    // this specific case.
    expect(parseRestartCommand("/restart-review\n--hard")).toEqual({
      isRestart: true,
      invalidReason: "unsupported_option",
    });
    expect(parseRestartCommand("/restart-review\n\n--hard")).toEqual({
      isRestart: true,
      invalidReason: "unsupported_option",
    });
    expect(parseRestartCommand("/restart-review\n  --hard")).toEqual({
      isRestart: true,
      invalidReason: "unsupported_option",
    });
  });

  it("does not reject when continuation lines are plain prose (no `--` prefix)", () => {
    // Sanity: the new continuation-flag check must not regress the rationale
    // acceptance from TY-275 #4. Lines like `--- separator ---` or `note: …`
    // should still pass through.
    const body = "/restart-review --hard\n\n--- separator ---\n(note: cleared per ops review)";
    // `---` matches /^--/ so this would naively trigger the new guard.
    // Verify the regex `/^\s*--\w/` requires a word character after `--`,
    // which `---` does NOT satisfy (the third char is `-`, not a word char).
    expect(parseRestartCommand(body)).toEqual({ isRestart: true, mode: "hard" });
  });

  it("returns isRestart=false for non-restart comments even when they contain `--<word>` continuation lines (Codex r3257717909)", () => {
    // The continuation-flag check must run AFTER confirming the first line
    // is a restart command. Otherwise unrelated comments like the ones below
    // would be misclassified as restart commands with `unsupported_option`,
    // leaking false-positive restart attempts to callers that don't
    // pre-filter via isRestartCommandLike.
    expect(parseRestartCommand("notes\n--todo")).toEqual({ isRestart: false });
    expect(parseRestartCommand("TODO list:\n--fix bug\n--add test")).toEqual({
      isRestart: false,
    });
    expect(parseRestartCommand("@bot what is `--hard`?\n--hard")).toEqual({
      isRestart: false,
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
    // TY-282 #1C: --hard now recovers from stopReason=state_corrupted because
    // hard restart clears iterationCount + findingsHashHistory so the next run
    // starts from scratch. Only the soft mode is still rejected.
    expect(
      applyRestartToState(
        makeState({ status: "stopped", stopReason: "state_corrupted" }),
        "soft",
        1,
      ),
    ).toEqual({ ok: false, reason: "state_corrupted" });
  });

  it("allows --hard restart from stopReason=state_corrupted (TY-282 #1C)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "state_corrupted",
      iterationCount: 5,
      findingsHashHistory: [
        { iteration: 5, hash: "stale-hash" },
      ],
      lastFindingsHash: "stale-hash",
    });
    const result = applyRestartToState(state, "hard", 9999);
    if (!result.ok) {
      throw new Error(`expected --hard to recover state_corrupted: ${result.reason}`);
    }
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      // Source state.stopReason is preserved per TY-258 across restart; the
      // next iteration's clean commit will null it out (one-shot).
      stopReason: "state_corrupted",
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastCodexRequestCommentId: 9999,
    });
  });

  it("rejects soft restart from stopReason=state_corrupted with a --hard escape-hatch message (TY-282 #1C)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "state_corrupted",
    });
    const result = applyRestartToState(state, "soft", 1);
    expect(result).toEqual({ ok: false, reason: "state_corrupted" });
  });

  it("rejects soft restart from stopReason=max_iterations (soft keeps the cap and re-stops)", () => {
    // A soft restart preserves iterationCount, which is already at the cap, so
    // pre-fix's `iterationCount >= maxReviewIterations` guard re-trips on the
    // next trigger and immediately re-stops. Only --hard (resets the count)
    // makes progress, so soft is rejected with a --hard escape hatch.
    const state = makeState({
      status: "stopped",
      stopReason: "max_iterations",
      iterationCount: 20,
    });
    const result = applyRestartToState(state, "soft", 1);
    expect(result).toEqual({
      ok: false,
      reason: "max_iterations_requires_hard_restart",
    });
  });

  it("allows --hard restart from stopReason=max_iterations, clearing the cap", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "max_iterations",
      iterationCount: 20,
      findingsHashHistory: [{ iteration: 20, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });
    const result = applyRestartToState(state, "hard", 9999);
    if (!result.ok) {
      throw new Error(`expected --hard to recover max_iterations: ${result.reason}`);
    }
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      // stopReason is preserved across restart per TY-258 (one-shot, cleared on
      // the next clean commit); --hard resets the iteration accounting.
      stopReason: "max_iterations",
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastCodexRequestCommentId: 9999,
    });
  });

  it("soft-restarts the new workflow_crashed stop reason without ceremony (TY-282 #2A)", () => {
    // workflow_crashed is the new auto-recoverable stop reason for crash
    // recovery + stale fixing detection. Unlike state_corrupted it accepts
    // both soft and hard restart so the operator does not have to think
    // about which mode to use.
    const state = makeState({
      status: "stopped",
      stopReason: "workflow_crashed",
      iterationCount: 3,
      findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });
    const soft = applyRestartToState(state, "soft", 100);
    if (!soft.ok) throw new Error("expected soft restart to succeed");
    expect(soft.nextState).toMatchObject({
      status: "waiting_codex",
      stopReason: "workflow_crashed",
      iterationCount: 3,
      lastCodexRequestCommentId: 100,
    });

    const hard = applyRestartToState(state, "hard", 200);
    if (!hard.ok) throw new Error("expected hard restart to succeed");
    expect(hard.nextState).toMatchObject({
      status: "waiting_codex",
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
      lastCodexRequestCommentId: 200,
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

  it("TY-286 #C: clears fixingStartedAt when hard-restarting from `fixing` so the invariant holds", () => {
    // Invariant: `fixingStartedAt === null` whenever `status !== 'fixing'`.
    // Every other transition out of `fixing` (post-fix Phase 4, failureExit,
    // stale recovery) already clears the timestamp; `applyRestartToState`
    // used to leak the old value via `...state`, breaking the invariant on
    // hard restart and risking stale-time-based logic in future code.
    const state = makeState({
      status: "fixing",
      fixingStartedAt: "2026-05-14T10:00:00.000Z",
      iterationCount: 3,
      findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });

    const result = applyRestartToState(state, "hard", 45678);

    if (!result.ok) throw new Error("expected hard restart to succeed");
    expect(result.nextState.fixingStartedAt).toBeNull();
    expect(result.nextState.status).toBe("waiting_codex");
  });

  it("clears previousCheckFailure on hard restart so a fresh start does not inject stale CHECK_COMMAND context", () => {
    // A `fixing` state hard-restarted after a prior test_failure carries the
    // failure tail (preserved across the intervening soft restart). `--hard`
    // wipes iteration history; the stale failure context must go with it so the
    // next repair prompt does not embed a now-irrelevant "Previous CHECK_COMMAND
    // Failure" section AND `selectModel` does not escalate on it.
    const state = makeState({
      status: "fixing",
      fixingStartedAt: "2026-05-14T10:00:00.000Z",
      iterationCount: 3,
      findingsHashHistory: [{ iteration: 3, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
      previousCheckFailure: "STALE tsc error from an abandoned attempt",
    });

    const result = applyRestartToState(state, "hard", 45678);

    if (!result.ok) throw new Error("expected hard restart to succeed");
    expect(result.nextState.previousCheckFailure).toBeNull();
    expect(result.nextState.iterationCount).toBe(0);
  });

  it("preserves previousCheckFailure on soft restart so the next attempt keeps the failure context (no regression)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "test_failure",
      previousCheckFailure: "tsc error: TS2345 ...",
    });

    const result = applyRestartToState(state, "soft", 45678);

    if (!result.ok) throw new Error("expected soft restart to succeed");
    expect(result.nextState.previousCheckFailure).toBe("tsc error: TS2345 ...");
  });

  it("TY-286 #C: keeps fixingStartedAt null on soft restart from non-fixing status (no regression)", () => {
    // Soft restart from a terminal status: the source state already has
    // fixingStartedAt === null (post-fix / failureExit cleared it), so the
    // result should still be null after the new explicit assignment.
    const state = makeState({
      status: "stopped",
      stopReason: "no_findings",
      fixingStartedAt: null,
    });

    const result = applyRestartToState(state, "soft", 1);

    if (!result.ok) throw new Error("expected soft restart to succeed");
    expect(result.nextState.fixingStartedAt).toBeNull();
  });

  it("soft-restarts from `action_no_op` preserving the rolled-back history (TY-284)", () => {
    // `failureExit` in post-fix already rolled iterationCount /
    // findingsHashHistory back to the pre-Phase-3 baseline when stopping with
    // action_no_op, so soft restart just flips status back to waiting_codex
    // and replays the same Codex findings with the same iteration budget.
    const state = makeState({
      status: "stopped",
      stopReason: "action_no_op",
      iterationCount: 1,
      findingsHashHistory: [{ iteration: 1, hash: "hash-a" }],
      lastFindingsHash: "hash-a",
    });
    const result = applyRestartToState(state, "soft", 12345);
    if (!result.ok) throw new Error("expected soft restart to succeed");
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      // TY-258: stopReason is preserved across restart; post-fix clears it
      // on the next clean commit.
      stopReason: "action_no_op",
      iterationCount: 1,
      lastFindingsHash: "hash-a",
      lastCodexRequestCommentId: 12345,
    });
    expect(result.nextState.findingsHashHistory).toEqual([
      { iteration: 1, hash: "hash-a" },
    ]);
  });

  it("rejects soft restart from `secret_leak_suspected` (TY-274 #1 — requires --hard)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "secret_leak_suspected",
      iterationCount: 2,
      findingsHashHistory: [{ iteration: 2, hash: "hash-leak" }],
      lastFindingsHash: "hash-leak",
    });
    const result = applyRestartToState(state, "soft", 99);
    expect(result).toEqual({
      ok: false,
      reason: "secret_leak_requires_hard_restart",
    });
  });

  it("allows hard restart from `secret_leak_suspected` (TY-274 #1)", () => {
    const state = makeState({
      status: "stopped",
      stopReason: "secret_leak_suspected",
      iterationCount: 2,
      findingsHashHistory: [{ iteration: 2, hash: "hash-leak" }],
      lastFindingsHash: "hash-leak",
    });
    const result = applyRestartToState(state, "hard", 99);
    if (!result.ok) throw new Error("expected hard restart to succeed");
    expect(result.nextState).toMatchObject({
      status: "waiting_codex",
      iterationCount: 0,
      findingsHashHistory: [],
      lastFindingsHash: null,
    });
  });
});

describe("handleRestartCommand", () => {
  it("posts @codex review, updates state, comments an audit record, and reacts with eyes", async () => {
    const deps = makeDeps();
    const state = makeState();

    const result = await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(state),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "Edereship",
      "loop-pilot",
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
      // TY-265: writes go through createLockedStateUpdater; the first write
      // uses the initial commentUpdatedAt from ReadStateResult.
      { expectedUpdatedAt: "2026-05-09T00:00:00Z" },
    );
    expect(deps.postCodexReviewRequest).toHaveBeenCalledWith(
      "Edereship",
      "loop-pilot",
      18,
      "codex-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "Edereship",
      "loop-pilot",
      999,
      {
        ...state,
        status: "waiting_codex",
        stopReason: "no_findings",
        lastProcessedReviewId: null,
        lastCodexRequestCommentId: 45678,
      },
      "token",
      // Second write chains the updated_at returned by the first patch.
      { expectedUpdatedAt: "2026-05-09T00:00:01Z" },
    );
    expect(deps.updateStateComment.mock.invocationCallOrder[0]).toBeLessThan(
      deps.postCodexReviewRequest.mock.invocationCallOrder[0],
    );
    expect(deps.postCodexReviewRequest.mock.invocationCallOrder[0]).toBeLessThan(
      deps.updateStateComment.mock.invocationCallOrder[1],
    );
    expect(deps.postComment.mock.calls[0][3]).toContain("🟢 LoopPilot restarted by @operator.");
    expect(deps.postComment.mock.calls[0][3]).toContain("mode: soft");
    expect(deps.postComment.mock.calls[0][3]).toContain("from: no_findings");
    expect(deps.postComment.mock.calls[0][3]).toContain("reviewRequestCommentId: 45678");
    expect(deps.addRestartReaction).toHaveBeenCalledWith(
      "Edereship",
      "loop-pilot",
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    // BUG-2: the fixing soft-restart rejection must point operators at the only
    // working recovery (`--hard`) instead of the dead-end generic message.
    const body = deps.postComment.mock.calls[0][3];
    expect(body).toContain("a fix is currently in progress (`fixing`)");
    expect(body).toContain("/restart-review --hard");
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(state),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).toHaveBeenCalledWith(
      "Edereship",
      "loop-pilot",
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "pr-author",
        restartRoles: "author",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
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
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "reader",
        restartRoles: "author,write",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
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

  it("posts a state_conflict stop comment and aborts when the first locked write conflicts (TY-265)", async () => {
    const deps = makeDeps();
    deps.updateStateComment.mockRejectedValueOnce(
      new StateUpdateConflictError("412 Precondition Failed"),
    );

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.postStopComment).toHaveBeenCalledTimes(1);
    expect(deps.postStopComment.mock.calls[0][3]).toBe("state_conflict");
    expect(deps.postStopComment.mock.calls[0][6]).toContain(
      "[restart] failed to publish pre-codex state",
    );
    // No @codex review must be posted when the first write conflicts —
    // otherwise we'd leave the loop in `waiting_codex` with no recorded
    // request comment id.
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("TY-286 #B: does NOT post state_conflict when the 2nd locked write conflicts; warns instead so operators do not duplicate @codex review", async () => {
    // The hidden state was already advanced to waiting_codex by the 1st
    // write and `@codex review` was already posted, so a 412 on the 2nd
    // write (which only records lastCodexRequestCommentId) leaves the loop
    // healthy — the next Codex review trigger reconciles automatically.
    // Surfacing a 🛑 state_conflict stop here would mislead operators into
    // re-issuing `/restart-review` and posting a second `@codex review`.
    const deps = makeDeps();
    deps.updateStateComment
      .mockResolvedValueOnce({ updatedAt: "2026-05-09T00:00:01Z" })
      .mockRejectedValueOnce(new StateUpdateConflictError("412 Precondition Failed"));

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "LoopPilot state remains waiting_codex; the next Codex review trigger will reconcile.",
      ),
    );
  });

  it("TY-300: downgrades to stopped/codex_request_failed when postCodexReviewRequest throws after the first state write", async () => {
    // Reproduces the silent deadlock: pre-TY-300, a throwing
    // postCodexReviewRequest left the state at `waiting_codex` with
    // `lastCodexRequestCommentId: null` and the workflow died via the
    // generic crash fail-safe — operators had no `codex_request_failed`
    // signal and re-running `/restart-review` looped on the same failure.
    const deps = makeDeps();
    deps.postCodexReviewRequest.mockRejectedValueOnce(new Error("403 Forbidden"));

    const result = await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    // 1st write: pre-codex waiting_codex (unchanged from the happy path).
    expect(deps.updateStateComment.mock.calls[0][3]).toMatchObject({
      status: "waiting_codex",
      lastCodexRequestCommentId: null,
    });
    // 2nd write: codex_request_failed downgrade. The state must NOT regress
    // back to `waiting_codex` once we know Codex was never reached.
    expect(deps.updateStateComment.mock.calls[1][3]).toMatchObject({
      status: "stopped",
      stopReason: "codex_request_failed",
      lastCodexRequestCommentId: null,
    });
    // Stop comment must surface the actionable reason + the underlying error.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "Edereship",
      "loop-pilot",
      18,
      "codex_request_failed",
      777,
      0,
      expect.stringContaining("403 Forbidden"),
      "token",
    );
    // The audit comment ("🟢 LoopPilot restarted ...") and the eyes
    // reaction advertise a successful restart — neither should fire when
    // the restart failed to actually re-trigger Codex.
    const auditPosted = deps.postComment.mock.calls.some((c) =>
      typeof c[3] === "string" && c[3].startsWith("🟢 LoopPilot restarted"),
    );
    expect(auditPosted).toBe(false);
    expect(deps.addRestartReaction).not.toHaveBeenCalled();
  });

  it("TY-300: preserves hard-restart invariants (iterationCount=0, findingsHashHistory=[]) when codex_request_failed downgrade fires", async () => {
    // The hard branch of `applyRestartToState` clears iterationCount and the
    // findings history. The TY-300 catch path must propagate those resets
    // into the stoppedState so a subsequent `/restart-review --hard` does
    // not see stale state.
    const deps = makeDeps();
    deps.postCodexReviewRequest.mockRejectedValueOnce(new Error("503 Service Unavailable"));

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(
          makeState({
            status: "waiting_codex",
            stopReason: null,
            iterationCount: 7,
            findingsHashHistory: [
              { iteration: 6, hash: "hash-x" },
              { iteration: 7, hash: "hash-y" },
            ],
          }),
        ),
      },
      deps,
    );

    const downgradedState = deps.updateStateComment.mock.calls[1][3];
    expect(downgradedState).toMatchObject({
      status: "stopped",
      stopReason: "codex_request_failed",
      iterationCount: 0,
      findingsHashHistory: [],
      fixingStartedAt: null,
    });
  });

  it("TY-300: stops cleanly without postStopComment / audit when the codex_request_failed write itself conflicts", async () => {
    // If both the first waiting_codex write and the @codex review post
    // succeed but the second (downgrade) write loses an updated_at race,
    // the locker's onConflict already surfaces `state_conflict` to the
    // operator. Skipping the extra `postStopComment` keeps the contract
    // identical to the existing locker conflict path (no duplicate stop
    // notifications).
    const deps = makeDeps();
    deps.postCodexReviewRequest.mockRejectedValueOnce(new Error("500"));
    // First write OK, second (downgrade) write conflicts via 412.
    deps.updateStateComment
      .mockResolvedValueOnce({ updatedAt: "2026-05-09T00:00:01Z" })
      .mockRejectedValueOnce(
        new StateUpdateConflictError("hidden comment updated_at changed"),
      );

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    // The locker's default onConflict posts a `state_conflict` stop comment
    // — we MUST NOT also post a second `codex_request_failed` stop comment
    // for the same incident.
    const codexFailedCalls = deps.postStopComment.mock.calls.filter(
      (c) => c[3] === "codex_request_failed",
    );
    expect(codexFailedCalls).toHaveLength(0);
  });

  it("rejects restart from a malformed triggerUserLogin without hitting the collaborator API (TY-265)", async () => {
    const deps = makeDeps();

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "../etc/passwd",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.getCollaboratorPermission).not.toHaveBeenCalled();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("invalid GitHub login"),
    );
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Restart rejected: insufficient permission.",
    );
  });
});

describe("handleRestartCommand — Codex ACK polling (TY-334)", () => {
  it("demotes to stopped/codex_request_failed and skips the success audit when Codex never ACKs", async () => {
    const deps = makeDeps();
    deps.ensureCodexAck = vi.fn<RestartCommandDeps["ensureCodexAck"]>(async () => ({
      acked: false,
      reason: "exhausted",
      reposts: 2,
      lastCommentId: 88888,
    }));
    const state = makeState({ status: "waiting_codex", stopReason: null });

    const result = await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(state),
      },
      deps,
    );

    expect(result).toEqual({ handled: true });
    const stoppedWrite = deps.updateStateComment.mock.calls.find(
      (c) =>
        c[3]?.status === "stopped" && c[3]?.stopReason === "codex_request_failed",
    );
    expect(stoppedWrite).toBeDefined();
    expect(stoppedWrite?.[3].lastCodexRequestCommentId).toBe(88888);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "Edereship",
      "test-auto-ai-review",
      18,
      "codex_request_failed",
      777,
      0,
      expect.stringContaining("did not acknowledge"),
      "token",
    );
    // Must NOT advertise a successful restart.
    const advertisedSuccess = deps.postComment.mock.calls.some((c) =>
      String(c[3]).includes("🟢 Auto-review restarted"),
    );
    expect(advertisedSuccess).toBe(false);
  });

  it("stays handled (no throw) when postStopComment fails after ACK exhaustion — best-effort warn-only", async () => {
    const deps = makeDeps();
    deps.ensureCodexAck = vi.fn<RestartCommandDeps["ensureCodexAck"]>(async () => ({
      acked: false,
      reason: "exhausted",
      reposts: 2,
      lastCommentId: 88888,
    }));
    deps.postStopComment.mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const state = makeState({ status: "waiting_codex", stopReason: null });

    const result = await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(state),
      },
      deps,
    );

    // Must resolve (not throw) even though the stop notification failed.
    expect(result).toEqual({ handled: true });
    // State was already persisted; the stop-comment failure is warn-only.
    const stoppedWrite = deps.updateStateComment.mock.calls.find(
      (c) => c[3]?.status === "stopped" && c[3]?.stopReason === "codex_request_failed",
    );
    expect(stoppedWrite).toBeDefined();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("failed to post the stop notification"),
    );
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("503 Service Unavailable"),
    );
  });

  it("records the latest reposted comment id in the success audit when Codex ACKs after a repost", async () => {
    const deps = makeDeps();
    deps.ensureCodexAck = vi.fn<RestartCommandDeps["ensureCodexAck"]>(async () => ({
      acked: true,
      reason: "eyes",
      reposts: 1,
      lastCommentId: 99999,
    }));

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "test-auto-ai-review",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "operator",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.postComment.mock.calls[0][3]).toContain(
      "reviewRequestCommentId: 99999",
    );
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });
});

describe("handleRestartCommand permission gate (TY-272 #E)", () => {
  it("checks permission before reading state so unauthorized commenters never trigger a state-corrupted comment", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    // State is corrupted — previously this would have posted the
    // "state is corrupted" comment to anyone (including unauthorized
    // commenters), giving public-PR drive-by users a way to amplify noise.
    const corruptedState: ReadStateResult = {
      found: false,
      corrupted: true,
      commentId: 42,
      commentUpdatedAt: "2026-05-09T00:00:00Z",
    };

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "stranger",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: corruptedState,
      },
      deps,
    );

    // Only the permission-rejection comment is posted; the corrupted-state
    // comment never appears, because permission is checked first.
    expect(deps.postComment).toHaveBeenCalledTimes(1);
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Restart rejected: insufficient permission.",
    );
    expect(deps.postComment.mock.calls[0][3]).not.toContain("unparseable JSON");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("rejects /restart-review on unparseable state with manual surgery instructions (TY-293 #1)", async () => {
    const deps = makeDeps();
    const corruptedState: ReadStateResult = {
      found: false,
      corrupted: true,
      commentId: 42,
      commentUpdatedAt: "2026-05-09T00:00:00Z",
    };

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "racoma-dev",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: corruptedState,
      },
      deps,
    );

    expect(deps.postComment).toHaveBeenCalledTimes(1);
    const body = String(deps.postComment.mock.calls[0][3]);
    expect(body).toContain("unparseable JSON");
    // TY-293 #1: the rejection comment must spell out that --hard is also a
    // dead end on this path, so operators don't loop on retries.
    expect(body).toContain("`/restart-review --hard` will return the same rejection");
    // Manual surgery is the only recovery; the comment links the exact gh api command.
    expect(body).toContain("gh api -X DELETE");
    expect(body).toContain("/repos/Edereship/loop-pilot/issues/comments/");
  });

  it("returns the same dead-end rejection on /restart-review --hard against unparseable state (TY-293 #1 regression)", async () => {
    // Regression guard: operators who hit the unparseable-JSON rejection often
    // retry with --hard. Both modes must produce the same explanatory message
    // so the operator immediately understands the path is hand-surgery only.
    const deps = makeDeps();
    const corruptedState: ReadStateResult = {
      found: false,
      corrupted: true,
      commentId: 42,
      commentUpdatedAt: "2026-05-09T00:00:00Z",
    };

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review --hard",
        triggerUserLogin: "racoma-dev",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: corruptedState,
      },
      deps,
    );

    expect(deps.postComment).toHaveBeenCalledTimes(1);
    const body = String(deps.postComment.mock.calls[0][3]);
    expect(body).toContain("unparseable JSON");
    expect(body).toContain("`/restart-review --hard` will return the same rejection");
  });

  it("checks permission before answering the unsupported-option rejection", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review now",
        triggerUserLogin: "stranger",
        restartRoles: "author,write,maintain,admin",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    expect(deps.postComment).toHaveBeenCalledTimes(1);
    expect(deps.postComment.mock.calls[0][3]).toContain(
      "❌ Restart rejected: insufficient permission.",
    );
    expect(deps.postComment.mock.calls[0][3]).not.toContain("unsupported option");
  });
});

describe("LOOPPILOT_RESTART_ROLES validation (TY-275 #2)", () => {
  it("warns and drops unknown role tokens (typical typo: 'admins')", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("admin");

    // The PR author hits the gate with restartRoles="admins" (typo). The
    // role token isn't recognized, so it's dropped — the author branch
    // never fires, and the collaborator check still passes because the
    // user actually has admin permission. A warning surfaces the typo.
    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "ops",
        restartRoles: "admins,write",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    const warnings = deps.warning.mock.calls.map((c) => c[0]).join("\n");
    expect(warnings).toMatch(/Unknown role\(s\) ignored.*admins/);
  });

  it("silently rejects all restarts when every role token is unknown", async () => {
    const deps = makeDeps();
    deps.getCollaboratorPermission.mockResolvedValue("read");

    await handleRestartCommand(
      {
        owner: "Edereship",
        repo: "loop-pilot",
        prNumber: 18,
        triggerCommentId: 777,
        triggerCommentBody: "/restart-review",
        triggerUserLogin: "ops",
        // All typos → effective role set is empty → permission gate rejects.
        restartRoles: "admins,maintainers,authorr",
        githubToken: "token",
        codexReviewRequestToken: "codex-token",
        codexBotLogin: "chatgpt-codex-connector[bot]",
        codexAckTimeoutSeconds: 90,
        codexAckPollIntervalSeconds: 15,
        codexAckMaxReposts: 2,
        stateResult: foundState(makeState()),
      },
      deps,
    );

    // postCodexReviewRequest must NOT have been called (gate rejected).
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    // Warning must surface all three typos for ops to debug.
    const warnings = deps.warning.mock.calls.map((c) => c[0]).join("\n");
    expect(warnings).toMatch(/admins/);
    expect(warnings).toMatch(/maintainers/);
    expect(warnings).toMatch(/authorr/);
  });
});

describe("isValidGitHubLogin", () => {
  it("accepts well-formed logins", () => {
    expect(isValidGitHubLogin("octocat")).toBe(true);
    expect(isValidGitHubLogin("a")).toBe(true);
    expect(isValidGitHubLogin("a1")).toBe(true);
    expect(isValidGitHubLogin("octo-cat")).toBe(true);
    expect(isValidGitHubLogin("o-c-t-o")).toBe(true);
    // 39 chars (GitHub's documented max)
    expect(isValidGitHubLogin("a".repeat(39))).toBe(true);
  });

  it("accepts Enterprise Managed User (EMU) logins containing underscore", () => {
    // EMU format: <idp_username>_<shortcode>
    expect(isValidGitHubLogin("alice_contoso")).toBe(true);
    expect(isValidGitHubLogin("john-doe_acme")).toBe(true);
    expect(isValidGitHubLogin("user_corp")).toBe(true);
  });

  it("rejects logins with path-traversal or slash characters", () => {
    expect(isValidGitHubLogin("../etc/passwd")).toBe(false);
    expect(isValidGitHubLogin("foo/bar")).toBe(false);
    expect(isValidGitHubLogin("..")).toBe(false);
  });

  it("rejects empty / too long / leading or trailing hyphen / consecutive hyphens", () => {
    expect(isValidGitHubLogin("")).toBe(false);
    expect(isValidGitHubLogin("a".repeat(40))).toBe(false);
    expect(isValidGitHubLogin("-octocat")).toBe(false);
    expect(isValidGitHubLogin("octocat-")).toBe(false);
    expect(isValidGitHubLogin("octo--cat")).toBe(false);
  });

  it("rejects bot logins so restart cannot be issued by automation accounts", () => {
    expect(isValidGitHubLogin("chatgpt-codex-connector[bot]")).toBe(false);
    expect(isValidGitHubLogin("github-actions[bot]")).toBe(false);
  });
});
