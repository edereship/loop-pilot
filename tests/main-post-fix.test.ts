import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  runPostFix,
  type PostFixDeps,
  type PostFixInputs,
} from "../src/main-post-fix.js";
import { createInitialState } from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 0,
  checkCommand: "npm run check",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 1,
  stabilizeCount: 1,
  codexReviewMarker: "Codex Review",
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "team-yubune",
  repoName: "test-auto-ai-review",
  prNumber: 99,
  triggerCommentId: 1234,
  triggerCommentBody: "",
  triggerUserLogin: "",
  prHeadRef: "linear/TY-237",
  prTitle: "TY-237",
  autoReviewLabel: "auto-review-fix",
  autoReviewFullAuto: false,
  autoReviewRestartRoles: "author,write,maintain,admin",
  claudeCodeModelBase: "claude-sonnet-4-6",
  claudeCodeModelEscalated: "claude-opus-4-7",
  autoMergeOnClean: false,
  severityThreshold: "P2",
  hardBlockOverride: [],
  scopeAllowedPathPrefixes: [],
  scopeMaxFiles: 0,
  scopeMaxLines: 0,
  scopeAdditionalHardBlockPrefixes: [],
};

const baseInputs: PostFixInputs = {
  commentId: 100,
  iteration: 2,
  checkCommand: "npm run check",
  prHeadRef: "linear/TY-237",
  triggerCommentId: 1234,
  actionOutcome: "success",
  actionExecutionFile: "",
};

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    status: "fixing",
    iterationCount: 2,
    findingsHashHistory: [
      { iteration: 1, hash: "aaaaaaaaaaaaaaaa" },
      { iteration: 2, hash: "bbbbbbbbbbbbbbbb" },
    ],
    lastFindingsHash: "bbbbbbbbbbbbbbbb",
    ...overrides,
  };
}

interface DepRecord {
  readonly resetCalls: number;
  readonly stagedPaths: string[][];
  readonly commitMessages: string[];
  readonly pushCalls: Array<{ owner: string; repo: string; ref: string; token: string }>;
}

function makeDeps(
  readResult: ReadStateResult,
  overrides: Partial<PostFixDeps> = {},
): PostFixDeps & DepRecord {
  const counters = {
    resetCalls: 0,
    stagedPaths: [] as string[][],
    commitMessages: [] as string[],
    pushCalls: [] as Array<{ owner: string; repo: string; ref: string; token: string }>,
  };
  const deps: PostFixDeps = {
    readState: vi.fn().mockResolvedValue(readResult),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-14T12:30:00Z" }),
    runCheckCommand: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
    postClaudeCodeActionFixSummary: vi.fn().mockResolvedValue(11),
    postCodexReviewRequest: vi.fn().mockResolvedValue(22),
    postStopComment: vi.fn().mockResolvedValue(33),
    postTestFailureComment: vi.fn().mockResolvedValue(44),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n",
    gitListUntracked: () => "",
    readWorkingTreeFile: () => null,
    readHeadSha: () => "abc1234",
    resetWorkingTree: () => {
      counters.resetCalls += 1;
    },
    stagePaths: (paths) => {
      counters.stagedPaths.push([...paths]);
    },
    hasStagedChanges: () => true,
    commit: (msg) => {
      counters.commitMessages.push(msg);
    },
    push: (owner, repo, ref, token) => {
      counters.pushCalls.push({ owner, repo, ref, token });
    },
    readActionExecutionFile: () => null,
    ...overrides,
  };
  // Expose counters as live getters so post-call assertions see the latest
  // values; spreading a number snapshots it at definition time.
  return Object.defineProperties(deps, {
    resetCalls: { get: () => counters.resetCalls },
    stagedPaths: { get: () => counters.stagedPaths },
    commitMessages: { get: () => counters.commitMessages },
    pushCalls: { get: () => counters.pushCalls },
  }) as PostFixDeps & DepRecord;
}

describe("runPostFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits, pushes, and transitions to waiting_codex on a clean run", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ previousCheckFailure: "stale tail" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages[0]).toContain("(iteration 2)");
    expect(deps.pushCalls).toEqual([
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        ref: "linear/TY-237",
        token: "",
      },
    ]);
    expect(deps.postClaudeCodeActionFixSummary).toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "waiting_codex",
        // TY-258: clean commit clears stopReason so escalation is one-shot.
        stopReason: null,
        previousCheckFailure: null,
        lastClaudeCommitSha: "abc1234",
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("clears max_turns_exceeded stopReason carried over from /restart-review on a clean commit (TY-258)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      // Simulates the state right after pre-fix transitions from
      // `waiting_codex(stopReason: max_turns_exceeded)` to `fixing` —
      // `stopReason` is intentionally carried through `applyRestartToState`
      // and only cleared once a successful repair lands.
      state: makeState({ stopReason: "max_turns_exceeded" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "waiting_codex",
        stopReason: null,
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("reverts and stops with scope_violation when the diff hits hard-blocked paths", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "10\t0\t.github/workflows/auto-review-loop.yml\n",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "scope_violation",
        // Failed attempt: iteration + history rolled back.
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining(".github/workflows/auto-review-loop.yml"),
      "github-token",
    );
  });

  it("saves CHECK_COMMAND failure tail to previousCheckFailure and stops with test_failure", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        runCheckCommand: vi.fn().mockResolvedValue({
          success: false,
          output: "tsc error: unexpected token",
        }),
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.commitMessages).toEqual([]);
    // Untracked files written by claude-code-action would survive
    // check-runner's per-path rollback; post-fix must reset + clean.
    expect(deps.resetCalls).toBe(1);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "test_failure",
        previousCheckFailure: "tsc error: unexpected token",
        // Iteration + findings hash were claimed by pre-fix on the way in;
        // since no commit was pushed, they must be rolled back so a soft
        // /restart-review with the same Codex findings doesn't loop-detect
        // immediately.
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
        lastFindingsHash: "aaaaaaaaaaaaaaaa",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postTestFailureComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "tsc error: unexpected token",
      "github-token",
    );
  });

  it("includes new files from gitListUntracked in scope check + commit", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitListUntracked: () => "src/new-helper.ts\ntests/new-helper.test.ts\n",
        readWorkingTreeFile: (path) => {
          if (path === "src/new-helper.ts") {
            return "export const helper = () => 42;\n";
          }
          if (path === "tests/new-helper.test.ts") {
            return "import { helper } from '../src/new-helper.js';\n";
          }
          return null;
        },
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // Both the tracked edit AND the two new files must be staged together.
    expect(deps.stagedPaths).toEqual([
      ["src/foo.ts", "src/new-helper.ts", "tests/new-helper.test.ts"],
    ]);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls).toEqual([
      {
        owner: "team-yubune",
        repo: "test-auto-ai-review",
        ref: "linear/TY-237",
        token: "",
      },
    ]);
    // The fix summary surfaces every changed file, not just the tracked subset.
    expect(deps.postClaudeCodeActionFixSummary).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      2,
      ["src/foo.ts", "src/new-helper.ts", "tests/new-helper.test.ts"],
      "abc1234",
      "github-token",
    );
  });

  it("flags binary new files via readWorkingTreeFile=null and stops with binary scope violation", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "",
        gitListUntracked: () => "src/blob.bin\n",
        // null indicates binary or unreadable content.
        readWorkingTreeFile: () => null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "scope_violation" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("treats action outcome=cancelled as action_timeout", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, { ...baseInputs, actionOutcome: "cancelled" });

    expect(deps.resetCalls).toBe(1);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_timeout" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "action_timeout",
      1234,
      0,
      expect.stringContaining("cancelled"),
      "github-token",
    );
  });

  it("detects max_turns_exceeded from the action execution file", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        readActionExecutionFile: () => "Error: Reached max_turns limit",
      },
    );

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
      actionExecutionFile: "/tmp/execution.json",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "max_turns_exceeded" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("falls back to action_failure when execution file does not indicate max_turns", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_failure" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("re-requests Codex review when claude-code-action made no changes", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "waiting_codex" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("propagates hardBlockOverride into the scope check and logs the configured paths (TY-255)", async () => {
    // `package.json` is hard-blocked by default. With the override active it
    // should clear the hard-block check; here we still expect a stop because
    // `package.json` is outside `allowedPathPrefixes` (override skips only
    // the hard-block stage, by design).
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "3\t1\tpackage.json\n",
      },
    );

    await runPostFix(
      { ...baseConfig, hardBlockOverride: ["package.json"] },
      deps,
      baseInputs,
    );

    expect(deps.info).toHaveBeenCalledWith(
      "[scope-check] hard-block override paths: [package.json]",
    );
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "scope_violation",
      }),
      "github-token",
      expect.any(Object),
    );
    // The reason must be `disallowed_path`, NOT `hard_block_path` — the
    // override successfully skipped the hard-block stage.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining("allow-list"),
      "github-token",
    );
  });

  it("still hard-blocks .github/ even when listed in hardBlockOverride (TY-255)", async () => {
    // The CI-rewrite escape hatch must stay closed: even when ops put a
    // `.github/` path in the override list, the scope check refuses it with
    // `hard_block_path` rather than letting it through.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\t.github/workflows/auto-review-loop.yml\n",
      },
    );

    await runPostFix(
      {
        ...baseConfig,
        hardBlockOverride: [".github/workflows/auto-review-loop.yml"],
      },
      deps,
      baseInputs,
    );

    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining(".github/workflows/auto-review-loop.yml"),
      "github-token",
    );
  });

  it("skips when state is no longer 'fixing' (manual intervention)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ status: "stopped", stopReason: "manual_stop" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });
});
