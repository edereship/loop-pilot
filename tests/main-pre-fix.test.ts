import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { runPreFix, type PreFixDeps, type PreFixOutputName } from "../src/main-pre-fix.js";
import { createInitialState } from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import { computeFindingsHash } from "../src/findings-hash.js";
import { filterAndParseComments } from "../src/review-collector.js";
import type { RawReviewComment, ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 0,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 1,
  stabilizeCount: 1,
  codexReviewMarker: "Codex Review",
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "github-token",
  anthropicApiKey: "anthropic-key",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "team-yubune",
  repoName: "test-auto-ai-review",
  prNumber: 99,
  triggerCommentId: 1234,
  triggerCommentBody: "Codex Review summary",
  triggerUserLogin: "chatgpt-codex-connector[bot]",
  prHeadRef: "linear/TY-237",
  prTitle: "TY-237: split main-loop",
  autoReviewLabel: "auto-review-fix",
  autoReviewFullAuto: false,
  autoReviewRestartRoles: "author,write,maintain,admin",
  claudeCodeModelBase: "claude-sonnet-4-6",
  claudeCodeModelEscalated: "claude-opus-4-7",
  autoMergeOnClean: false,
  autoMergePollSeconds: 15,
  autoMergeTimeoutMinutes: 10,
  severityThreshold: "P2",
  autoReviewBlockPaths: "",
  scopeMaxFiles: 0,
  scopeMaxLines: 0,
  hardBlockOverride: [],
  scopeAllowedPathPrefixes: [],
  scopeAdditionalHardBlockPrefixes: [],
};

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ...createInitialState(), ...overrides };
}

interface OutputRecord {
  outputs: Record<string, string>;
}

function makeDeps(
  readResult: ReadStateResult,
  reviewComments: RawReviewComment[] = [],
): PreFixDeps & OutputRecord {
  const outputs: Record<string, string> = {};
  return {
    readState: vi.fn().mockResolvedValue(readResult),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-14T12:00:00Z" }),
    fetchReviewComments: vi.fn().mockResolvedValue(reviewComments),
    stabilizeReviewComments: vi.fn().mockResolvedValue(reviewComments),
    postCompletionComment: vi.fn().mockResolvedValue(1),
    postFixingStartComment: vi.fn().mockResolvedValue(4),
    postStopComment: vi.fn().mockResolvedValue(2),
    postInitIncompleteComment: vi.fn().mockResolvedValue(3),
    mergeIfChecksPass: vi.fn().mockResolvedValue(undefined),
    fetchPrLabels: vi.fn().mockResolvedValue(["auto-review-fix"]),
    handleRestartCommand: vi.fn().mockResolvedValue({ handled: false }),
    setSecret: vi.fn(),
    setOutput: (name: PreFixOutputName, value: string) => {
      outputs[name] = value;
    },
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-05-14T12:00:00Z"),
    readHeadSha: () => "deadbeef",
    checkoutBranch: vi.fn(),
    outputs,
  };
}

describe("runPreFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits should_run=false when the gate label is missing", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });
    deps.fetchPrLabels = vi.fn().mockResolvedValue([]);

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it("returns silently when no hidden state exists", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it.each(["stopped", "done"] as const)(
    "skips when status is %s",
    async (status) => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status }),
      });

      await runPreFix(baseConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.updateStateComment).not.toHaveBeenCalled();
    },
  );

  it("recovers stale 'fixing' state via workflow_crashed so /restart-review can resume (TY-282 #1B)", async () => {
    const staleStartedAt = new Date("2026-05-14T10:00:00Z").toISOString();
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "fixing",
        // TY-273 #B4: stale detection now anchors on `fixingStartedAt`. The
        // legacy fallback to `lastCodexReviewReceivedAt` is still exercised
        // here to confirm pre-TY-273 state comments keep recovering.
        lastCodexReviewReceivedAt: staleStartedAt,
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    // TY-282 #1B: stale recovery used to write state_corrupted, which
    // applyRestartToState rejects. Switched to workflow_crashed so the
    // operator can /restart-review without manual hidden-comment surgery.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "workflow_crashed",
        fixingStartedAt: null,
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
    expect((deps.postStopComment as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(
      "workflow_crashed",
    );
  });

  // TY-273 #B4: `fixingStartedAt` is the authoritative stale-detection
  // timestamp once a state comment has been written by post-TY-273 code.

  it("TY-273 #B4: prefers fixingStartedAt over lastCodexReviewReceivedAt for stale detection", async () => {
    // lastCodexReviewReceivedAt looks ancient (would trip stale recovery),
    // but a fresh fixingStartedAt means the fixing claim is recent so the
    // loop should skip without downgrading.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "fixing",
        lastCodexReviewReceivedAt: "2026-05-14T10:00:00Z",
        fixingStartedAt: "2026-05-14T11:55:00Z",
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it("TY-273 #B4: persists fixingStartedAt = now() on the Phase 3 fixing transition", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 300,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Missing null guard\n\nGuard the dereference.",
        path: "src/foo.ts",
        line: 9,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", iterationCount: 1 }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "fixing",
        // mock now() returns 2026-05-14T12:00:00Z.
        fixingStartedAt: "2026-05-14T12:00:00.000Z",
      }),
      "github-token",
      expect.any(Object),
    );
    // TY-291 #2 (UX-05): the fixing transition must also refresh the visible
    // status comment so operators see "Fixing — iteration N starting" during
    // the multi-minute claude-code-action run.
    expect(deps.postFixingStartComment).toHaveBeenCalledTimes(1);
    expect(deps.postFixingStartComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      2,
      expect.stringMatching(/^(base|escalated)$/),
      20,
      1, // findings.length from the single finding in this test
      "github-token",
    );
  });

  it("does not double-process the same trigger comment", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "waiting_codex",
        lastProcessedReviewId: baseConfig.triggerCommentId,
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.fetchReviewComments).not.toHaveBeenCalled();
  });

  it("marks done when no findings are returned", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [], // no comments → no findings
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "done", stopReason: "no_findings" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postCompletionComment).toHaveBeenCalled();
    expect(deps.mergeIfChecksPass).not.toHaveBeenCalled();
  });

  it("enables auto-merge on done/no_findings when AUTO_REVIEW_AUTO_MERGE is true", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [],
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    expect(deps.postCompletionComment).toHaveBeenCalled();
    expect(deps.mergeIfChecksPass).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "github-token",
      expect.objectContaining({ info: expect.any(Function), warning: expect.any(Function) }),
      expect.objectContaining({
        pollIntervalMs: expect.any(Number),
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("stops when iteration count is at the configured maximum", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 200,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Race condition in cache eviction\n\nDescription.\n\nUseful?",
        path: "src/cache.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", iterationCount: 20 }),
      },
      findings,
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "max_iterations" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
    // auto-merge must only fire on done/no_findings, not max_iterations.
    expect(deps.mergeIfChecksPass).not.toHaveBeenCalled();
  });

  it("propagates checkoutBranch failure so claude-code-action does not run on the wrong ref", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 400,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Race in middleware\n\nSomething.",
        path: "src/middleware.ts",
        line: 10,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );
    deps.checkoutBranch = vi.fn().mockImplementation(() => {
      throw new Error("error: pathspec 'linear/TY-237' did not match any file(s) known to git");
    });

    await expect(runPreFix(baseConfig, deps)).rejects.toThrow(/did not match/);

    // Pre-fix should never advance to emitting the run signal once the
    // working tree cannot be repositioned to the PR head.
    expect(deps.outputs.should_run).toBe("false");
    // TY-285 #4: checkout runs BEFORE the fixing state write, so a failed
    // checkout must not consume an iteration slot or append a hash entry.
    expect(deps.updateStateComment).not.toHaveBeenCalled();
  });

  it("TY-285 #3/#4: rejects argv-flag injection prHeadRef without mutating state", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 410,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Bad ref\n\nSomething.",
        path: "src/foo.ts",
        line: 10,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await expect(
      runPreFix({ ...baseConfig, prHeadRef: "-rf" }, deps),
    ).rejects.toThrow(/Invalid branch name/);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.checkoutBranch).not.toHaveBeenCalled();
    // Validation runs before the fixing state write — the throw must not
    // consume an iteration or append a hash entry.
    expect(deps.updateStateComment).not.toHaveBeenCalled();
  });

  it.each(["feature/..", ".."])(
    "TY-285 #3: rejects path-traversal prHeadRef %j",
    async (badRef) => {
      const findings: RawReviewComment[] = [
        {
          id: 411,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Bad ref\n\nSomething.",
          path: "src/foo.ts",
          line: 10,
          createdAt: "2026-05-14T11:30:00Z",
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({ status: "waiting_codex" }),
        },
        findings,
      );

      await expect(
        runPreFix({ ...baseConfig, prHeadRef: badRef }, deps),
      ).rejects.toThrow(/Invalid branch name/);

      expect(deps.checkoutBranch).not.toHaveBeenCalled();
      expect(deps.updateStateComment).not.toHaveBeenCalled();
    },
  );

  it.each([
    "機能/タスク-123",
    "feature/한국어",
    "feat/中文",
    "feat/絵文字-🚀",
  ])(
    "TY-285 #3: accepts non-ASCII prHeadRef %j and proceeds to fixing",
    async (goodRef) => {
      const findings: RawReviewComment[] = [
        {
          id: 412,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Some finding\n\nDetails.",
          path: "src/foo.ts",
          line: 10,
          createdAt: "2026-05-14T11:30:00Z",
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({ status: "waiting_codex" }),
        },
        findings,
      );

      await runPreFix({ ...baseConfig, prHeadRef: goodRef }, deps);

      expect(deps.checkoutBranch).toHaveBeenCalledWith(goodRef);
      expect(deps.outputs.should_run).toBe("true");
      expect(deps.outputs.pr_head_ref).toBe(goodRef);
      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "team-yubune",
        "test-auto-ai-review",
        100,
        expect.objectContaining({ status: "fixing" }),
        "github-token",
        expect.any(Object),
      );
    },
  );

  it("transitions to fixing and emits the prompt + outputs on a clean run", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 300,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P0 Token bypass in middleware\n\nThe middleware skips the auth check on prefetch.",
        path: "src/auth.ts",
        line: 42,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          previousCheckFailure: "previous tail",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.iteration).toBe("2");
    expect(deps.outputs.check_command).toBe("npm run check");
    expect(deps.outputs.pr_head_ref).toBe("linear/TY-237");
    expect(deps.outputs.head_sha).toBe("deadbeef");
    expect(deps.outputs.comment_id).toBe("100");
    expect(deps.outputs.findings_count).toBe("1");
    expect(deps.outputs.prompt).toContain("Codex Findings (1)");
    expect(deps.outputs.prompt).toContain("Token bypass in middleware");
    // previous tail surfaced in the prompt
    expect(deps.outputs.prompt).toContain("previous tail");
    // Default CHECK_COMMAND is already in the baseline, so no extra entry.
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(npm run check)");
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(git diff)");
    // P0 finding + previousCheckFailure both fire → escalated to Opus.
    expect(deps.outputs.model).toBe("claude-opus-4-7");

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "fixing", iterationCount: 2 }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.checkoutBranch).toHaveBeenCalledWith("linear/TY-237");
  });

  it("embeds the effective scope policy section in the prompt (TY-278)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 310,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      {
        ...baseConfig,
        // Custom additions ("secrets/") + custom removal ("!package.json")
        // exercise the operator-spec → effective-list resolution.
        autoReviewBlockPaths: "secrets/,!package.json",
        scopeMaxFiles: 7,
        scopeMaxLines: 250,
      },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.prompt).toContain(
      "## Scope Policy (your edits must satisfy)",
    );
    // Locked default surfaces the structural-lock annotation.
    expect(deps.outputs.prompt).toContain(
      "  - .github/ (structurally locked, cannot be overridden)",
    );
    // Default unlocked entries still appear.
    expect(deps.outputs.prompt).toContain("  - dist/");
    // Operator addition appears.
    expect(deps.outputs.prompt).toContain("  - secrets/");
    // Operator removal of `package.json` from the defaults takes effect:
    // the prompt's blocked-paths block must not list it as a bullet item.
    expect(deps.outputs.prompt).not.toMatch(/^  - package\.json$/m);
    // Effective overrides for size budgets are surfaced.
    expect(deps.outputs.prompt).toContain("- Max files changed: 7");
    expect(deps.outputs.prompt).toContain(
      "- Max lines changed (added + deleted): 250",
    );
    // Root-dotfile wildcard is always surfaced. "!package.json" is not a dotfile
    // so it does not appear in the exemption list.
    expect(deps.outputs.prompt).toContain(
      "- Root dotfiles (any `.*` file at repo root): blocked",
    );
    expect(deps.outputs.prompt).not.toContain("exempted: package.json");
    // Section ordering: Findings → Scope Policy → Instructions.
    const findingsAt = deps.outputs.prompt.indexOf("## Codex Findings");
    const scopeAt = deps.outputs.prompt.indexOf("## Scope Policy");
    const instructionsAt = deps.outputs.prompt.indexOf("## Instructions");
    expect(scopeAt).toBeGreaterThan(findingsAt);
    expect(instructionsAt).toBeGreaterThan(scopeAt);
    expect(deps.warning).not.toHaveBeenCalled();
  });

  it("appends CHECK_COMMAND to the Bash allowlist when using a non-npm package manager", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 301,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Missing null guard\n\nA path can dereference null.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      { ...baseConfig, checkCommand: "pnpm run check" },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(pnpm run check)");
    expect(deps.warning).not.toHaveBeenCalled();
  });

  it("uses the base model when no escalation signal fires", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 320,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", previousCheckFailure: null }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-sonnet-4-6");
  });

  it("escalates to the escalated tier when the previous base-tier iteration produced the same findings hash (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 510,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Lingering null guard\n\nPath still dereferences null.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          findingsHashHistory: [
            { iteration: 1, hash, modelTier: "base" },
          ],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-opus-4-7");
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "fixing",
        iterationCount: 2,
        findingsHashHistory: [
          { iteration: 1, hash, modelTier: "base" },
          { iteration: 2, hash, modelTier: "escalated" },
        ],
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("stops with loop_detected when the previous escalated-tier iteration produced the same findings hash (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 511,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P0 Critical auth bypass\n\nStill broken after escalated attempt.",
        path: "src/auth.ts",
        line: 14,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 2,
          findingsHashHistory: [
            { iteration: 1, hash, modelTier: "base" },
            { iteration: 2, hash, modelTier: "escalated" },
          ],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "loop_detected" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
  });

  it("treats legacy history entries without modelTier as escalated (loop_detected) (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 512,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Same finding\n\nNothing changed.",
        path: "src/baz.ts",
        line: 5,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Pre-TY-243 entry: no modelTier present.
          findingsHashHistory: [{ iteration: 1, hash }],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "loop_detected" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("registers the OAuth token as a secret and warns about quota usage when using a subscription (TY-260)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      { ...baseConfig, anthropicApiKey: "", claudeCodeOauthToken: "oauth-test" },
      deps,
    );

    expect(deps.setSecret).toHaveBeenCalledWith("oauth-test");
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code OAuth token (subscription)"),
    );
  });

  it("does not emit the subscription warning when running with the API key (TY-260)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(baseConfig, deps);

    // baseConfig has anthropicApiKey="anthropic-key", claudeCodeOauthToken=""
    expect(deps.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("Claude Code OAuth token"),
    );
  });

  it("escalates to the escalated tier when the previous iteration stopped with max_turns_exceeded (TY-258)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 520,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor follow-up\n\nA wording tweak.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Simulates the state after a `max_turns_exceeded` stop +
          // `/restart-review` (restart preserves stopReason).
          stopReason: "max_turns_exceeded",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    // Only P2 finding → no P0 / previousCheckFailure / repeatedFinding,
    // so the escalation must come solely from the carried-over stopReason.
    expect(deps.outputs.model).toBe("claude-opus-4-7");
  });

  it("does not escalate when previous stopReason is a non-max_turns reason (TY-258 boundary)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 521,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor follow-up\n\nA wording tweak.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Any non-max_turns reason must not trigger escalation on its own.
          stopReason: "loop_detected",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-sonnet-4-6");
  });

  it("stops with codex_usage_limit when the Codex bot trigger body is a usage-limit notice (TY-229)", async () => {
    const usageLimitBody = "You have reached your Codex usage limits for code reviews.";
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      {
        ...baseConfig,
        triggerCommentBody: usageLimitBody,
        triggerUserLogin: baseConfig.codexBotLogin,
      },
      deps,
    );

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.fetchReviewComments).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "codex_usage_limit",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "codex_usage_limit",
      baseConfig.triggerCommentId,
      0,
      expect.stringContaining("/restart-review"),
      "github-token",
    expect.any(Object),
    );
  });

  it("ignores a usage-limit phrase posted by a non-Codex user (TY-229)", async () => {
    const usageLimitBody = "You have reached your Codex usage limits for code reviews.";
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      {
        ...baseConfig,
        triggerCommentBody: usageLimitBody,
        triggerUserLogin: "human-user",
      },
      deps,
    );

    // Without the Codex bot login, the trigger is treated as a normal
    // comment and the usual collection path runs (which returns
    // no_findings here because no mock comments are supplied).
    expect(deps.fetchReviewComments).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "done",
        stopReason: "no_findings",
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("warns and falls back to baseline when CHECK_COMMAND is unsafe", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 302,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Issue\n\nSomething.",
        path: "src/bar.ts",
        line: 1,
        createdAt: "2026-05-14T11:30:00Z",
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      { ...baseConfig, checkCommand: "npm run check; rm -rf /" },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.allowed_bash_tools).not.toContain("rm -rf");
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("not added to Bash allowlist"),
    );
  });
});
