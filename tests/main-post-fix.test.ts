import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  runPostFix,
  type PostFixDeps,
  type PostFixInputs,
} from "../src/main-post-fix.js";
import {
  StateUpdateConflictError,
  createInitialState,
} from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

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
  readonly intentToAddCalls: string[][];
  readonly resetIntentToAddCalls: string[][];
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
    intentToAddCalls: [] as string[][],
    resetIntentToAddCalls: [] as string[][],
  };
  const deps: PostFixDeps = {
    readState: vi.fn().mockResolvedValue(readResult),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-14T12:30:00Z" }),
    runCheckCommand: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
    runBuildCommand: vi.fn().mockResolvedValue({ success: true, output: "" }),
    postClaudeCodeActionFixSummary: vi.fn().mockResolvedValue(11),
    postCodexReviewRequest: vi.fn().mockResolvedValue(22),
    postStopComment: vi.fn().mockResolvedValue(33),
    postTestFailureComment: vi.fn().mockResolvedValue(44),
    postTerminalNotification: vi.fn().mockResolvedValue(undefined),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n",
    gitDiffHead: () => "",
    gitListUntracked: () => "",
    readWorkingTreeFile: () => null,
    readHeadSha: () => "abc1234",
    resetWorkingTree: () => {
      counters.resetCalls += 1;
    },
    stagePaths: (paths) => {
      counters.stagedPaths.push([...paths]);
    },
    intentToAdd: (paths) => {
      counters.intentToAddCalls.push([...paths]);
    },
    resetIntentToAdd: (paths) => {
      counters.resetIntentToAddCalls.push([...paths]);
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
    intentToAddCalls: { get: () => counters.intentToAddCalls },
    resetIntentToAddCalls: { get: () => counters.resetIntentToAddCalls },
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

  it("TY-286 #A: does NOT emit state_conflict 🛑 when the Phase 4 2nd write conflicts; warns instead", async () => {
    // The 1st write (waiting_codex) succeeded and `@codex review` was
    // posted, so the loop is already healthy. A 412 on the 2nd write (which
    // only records `lastCodexRequestCommentId`) must not surface a top-level
    // stop comment that contradicts the live state — operators would
    // otherwise see "🛑 Auto-review stopped" while the next Codex review
    // trigger silently reconciles.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });
    (deps.updateStateComment as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ updatedAt: "2026-05-14T12:30:00Z" })
      .mockRejectedValueOnce(
        new StateUpdateConflictError("412 Precondition Failed"),
      );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Auto-review state remains waiting_codex; the next Codex review trigger will reconcile.",
      ),
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

  it("reverts and stops with secret_leak_suspected when a hard-fail pattern is in the diff (TY-274 #1)", async () => {
    // Diff-based: only `+`-prefixed lines from the unified diff are scanned.
    // The matching content here is an added line in src/foo.ts.
    //
    // The token literal is split with `+` so this source file does not contain
    // a contiguous match for the scanner's own `ghp_[A-Za-z0-9]{20,}` regex —
    // otherwise post-fix scans of this very test file (when claude-code-action
    // touches it) would treat the literal as a re-introduced leak.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      `+export const t = '${fakeGhp}';`,
    ].join("\n");
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
        gitDiffHead: () => diff,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // Working tree reverted, CHECK_COMMAND skipped, no commit/push.
    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "secret_leak_suspected",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "secret_leak_suspected",
      1234,
      0,
      // Detail must surface pattern + path but NEVER the matched secret value
      // (asserted both ways).
      expect.stringContaining("github-pat-classic in src/foo.ts"),
      "github-token",
    );
    const detailArg = (deps.postStopComment as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[6] as string;
    expect(detailArg).not.toMatch(/ghp_[A-Za-z0-9]{8,}/);
  });

  it("does not stop on warning-only secret patterns (TY-274 #1)", async () => {
    // High-entropy warning pattern in an added diff line — should log a
    // warning but allow the loop to continue to CHECK_COMMAND.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "+export const HASH = 'Ab12CdEfGh34IjKlMnOp56QrStUvWxYz_a-b-c-d';",
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\tsrc/foo.ts\n",
        gitDiffHead: () => diff,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).toHaveBeenCalled();
    expect(deps.resetCalls).toBe(0);
    expect(deps.postStopComment).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "secret_leak_suspected",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("ignores secret-shaped content that pre-existed in HEAD (only scans added diff lines, TY-274 #1)", async () => {
    // Empty diff — the working tree somehow has the same numstat-listed file
    // but with no actual additions in this iteration. This models the
    // scanner's own source / fixture files: they already contain matching
    // patterns in HEAD, so the diff has no `+` lines and they must not
    // false-positive. CHECK_COMMAND must still run.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/secret-scanner.ts\n",
        // No `+` lines → no added content scanned → no findings.
        gitDiffHead: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(0);
    expect(deps.runCheckCommand).toHaveBeenCalled();
  });

  it("treats entire content of untracked files as added and scans them via intent-to-add diff (TY-274 #1 / TY-287 #2 follow-up)", async () => {
    // claude-code-action added a brand-new file containing a hard-fail
    // pattern. Under the TY-287 #2 follow-up, post-fix promotes untracked
    // paths to intent-to-add before running gitDiffHead so git's rename
    // detection can pair low-similarity renames with their tracked-side
    // deletions. As a side-effect, the untracked file's full contents
    // appear in the diff as `+` lines, and the secret-scanner consumes
    // them through the unified-diff path rather than the readFile path.
    //
    // Token literal split with `+` to avoid self-matching the scanner regex in
    // this source file (see the diff-based scan rationale above).
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const intentToAddDiff = [
      "diff --git a/src/new-leak.ts b/src/new-leak.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new-leak.ts",
      "@@ -0,0 +1 @@",
      `+export const t = '${fakeGhp}';`,
    ].join("\n");
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
        // Real git: empty before intent-to-add, populated after. The mock
        // returns the post-intent-to-add diff straight from the first call
        // because the pre-check scan happens after `intentToAdd` is invoked.
        gitDiffHead: () => intentToAddDiff,
        gitListUntracked: () => "src/new-leak.ts\n",
        // The untracked-changes enumeration (used for scope check + line
        // counting) still reads the file directly; the scanner itself now
        // consumes the file via the post-intent-to-add diff above.
        readWorkingTreeFile: (path) =>
          path === "src/new-leak.ts"
            ? `export const t = '${fakeGhp}';`
            : null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // TY-287 #2 follow-up: untracked paths must be intent-to-add'd before
    // the scan so low-similarity renames are paired with their deletions,
    // and the markers must be reset afterwards so the subsequent
    // `stagePaths` flow does not surface stale index entries.
    expect(deps.intentToAddCalls).toContainEqual(["src/new-leak.ts"]);
    expect(deps.resetIntentToAddCalls).toContainEqual(["src/new-leak.ts"]);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "secret_leak_suspected",
      1234,
      0,
      expect.stringContaining("github-pat-classic in src/new-leak.ts"),
      "github-token",
    );
  });

  it("re-scans secrets after CHECK_COMMAND on the no-build path (Codex P1 r3256220740)", async () => {
    // Pre-check scan saw the agent's edit (clean). CHECK_COMMAND's `--fix`
    // pass then rewrote src/foo.ts and injected a hard-fail token. With no
    // buildCommand, there was previously no second scan before staging, so
    // the leaked content would have been committed and pushed. The
    // pre-commit scan must catch this and stop with secret_leak_suspected.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const cleanDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "+const v = 1;",
    ].join("\n");
    const dirtyDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      `+const v = '${fakeGhp}';`,
    ].join("\n");
    const diffHead = vi
      .fn()
      .mockReturnValueOnce(cleanDiff) // pre-check scan: clean
      .mockReturnValueOnce(dirtyDiff); // pre-commit scan: CHECK_COMMAND injected leak
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
        gitDiffHead: diffHead,
        gitListUntracked: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).toHaveBeenCalled();
    // Pre-commit scan tripped → revert + secret_leak_suspected, no commit.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "secret_leak_suspected",
      1234,
      0,
      expect.stringContaining("github-pat-classic in src/foo.ts"),
      "github-token",
    );
  });

  it("TY-287 #2 follow-up (Codex P2 r3263061946): low-similarity rename emits only the changed lines via intent-to-add + rename detection", async () => {
    // Scenario: claude-code-action moves `tests/fixtures/old.json` to
    // `tests/fixtures/new.json` and rewrites ~70% of the body. The source
    // file already contained a secret-shaped sample (the unchanged half).
    //
    // Before the TY-287 #2 follow-up: `git diff HEAD` saw only the
    // deletion (the destination was untracked, not in the index), so
    // `--find-renames=20%` could not pair them and the destination was
    // read in full via `readWorkingTreeFile` — re-emitting the
    // pre-existing secret-shaped line and hard-failing the scanner.
    //
    // After the follow-up: post-fix calls `intentToAdd` on the untracked
    // destination before the scan, the rename pair is detected, and only
    // the genuinely changed `+` lines surface as additions. The
    // pre-existing fixture content stays out of the scan input.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const renameDiff = [
      // Rename header pair emitted by `--find-renames=20%` (with intent-to-add).
      "diff --git a/tests/fixtures/old-config.json b/tests/fixtures/new-config.json",
      "similarity index 28%",
      "rename from tests/fixtures/old-config.json",
      "rename to tests/fixtures/new-config.json",
      "--- a/tests/fixtures/old-config.json",
      "+++ b/tests/fixtures/new-config.json",
      "@@ -2 +2 @@",
      // Only the genuinely rewritten line — the pre-existing secret-shape
      // line in the file body is NOT here. It would have been re-emitted
      // had git treated this as delete + add.
      `-  "label": "old-${fakeGhp.slice(0, 12)}"`,
      `+  "label": "new-value"`,
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        // numstat sees the rename source as a deletion (numstat is invoked
        // before intent-to-add). The exact shape is not the focus of this
        // test; what matters is the scan path's behaviour.
        gitDiffNumstat: () => "5\t10\ttests/fixtures/old-config.json\n",
        // Mock the post-intent-to-add diff so the scanner consumes the
        // rename-headered hunks rather than reading the destination in full.
        gitDiffHead: () => renameDiff,
        gitListUntracked: () => "tests/fixtures/new-config.json\n",
        // Provide content so the untracked-changes enumeration treats this
        // as a non-binary text file; the scanner itself never sees this
        // value because it runs off the rename-headered diff above.
        readWorkingTreeFile: (path) =>
          path === "tests/fixtures/new-config.json"
            ? `{\n  "label": "new-value",\n  "other": "stays"\n}\n`
            : null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.intentToAddCalls).toContainEqual([
      "tests/fixtures/new-config.json",
    ]);
    expect(deps.resetIntentToAddCalls).toContainEqual([
      "tests/fixtures/new-config.json",
    ]);
    // The pre-existing secret-shape line is in the `-` half of the rename
    // diff, so the scanner never sees it as an addition. No hard failure,
    // no working-tree reset.
    expect(deps.resetCalls).toBe(0);
    expect(deps.postStopComment).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "secret_leak_suspected",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(deps.runCheckCommand).toHaveBeenCalled();
  });

  it("scans untracked files whose names contain ' => ' via intent-to-add diff (Codex P2 r3256517009 / TY-287 #2 follow-up)", async () => {
    // `git ls-files --others` returns real filesystem paths verbatim, never
    // rename notation (that's a `git diff --numstat` artefact). The TY-287
    // #2 follow-up routes the untracked-file scan through `gitDiffHead`
    // (via intent-to-add) so rename detection can pair low-similarity
    // renames with their deletions. Pre-existing fixtures whose names
    // contain ` => ` must still be scanned end-to-end through that path.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const untrackedListings = vi
      .fn()
      // Initial enumeration (before CHECK_COMMAND): clean.
      .mockReturnValueOnce("")
      // Pre-commit enumeration: untracked file with ` => ` in its name.
      .mockReturnValueOnce("data/a => b.json\n");
    const preCommitDiff = [
      `diff --git a/data/a => b.json b/data/a => b.json`,
      "new file mode 100644",
      `--- /dev/null`,
      `+++ b/data/a => b.json`,
      "@@ -0,0 +1 @@",
      `+{ "token": "${fakeGhp}" }`,
    ].join("\n");
    const diffHead = vi
      .fn()
      // Pre-check scan: nothing changed yet aside from the tracked file.
      .mockReturnValueOnce("")
      // Pre-commit scan: intent-to-add has promoted the untracked file
      // into the diff.
      .mockReturnValueOnce(preCommitDiff);
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\tsrc/foo.ts\n",
        gitDiffHead: diffHead,
        gitListUntracked: untrackedListings,
        readWorkingTreeFile: () => null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.intentToAddCalls).toContainEqual(["data/a => b.json"]);
    expect(deps.resetIntentToAddCalls).toContainEqual(["data/a => b.json"]);
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "secret_leak_suspected",
      1234,
      0,
      // Path with " => " in its name must surface in the stop detail.
      expect.stringContaining("github-pat-classic in data/a => b.json"),
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
    // TY-290 #2: status-comment edit does not fire GitHub notifications, so
    // `failureExit` must follow `postTestFailureComment` (status update) with
    // an explicit top-level 🛑 comment so operators see CHECK_COMMAND
    // failures in their inbox / mobile push.
    expect(deps.postTerminalNotification).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      44,
      {
        kind: "stopped",
        stopReason: "test_failure",
      },
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

  it("stops with action_no_op when claude-code-action made no changes (TY-284)", async () => {
    // TY-284 replaced the TY-273 #B3 auto-retry path: a no-op success outcome
    // is now treated as a stop condition. CHECK_COMMAND is skipped, no Codex
    // re-request is posted, and the operator resumes via `/restart-review`.
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
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_no_op" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("AUTO_REVIEW_BLOCK_PATHS=!package.json lets package.json pass the scope check (TY-271)", async () => {
    // The new block-list lets operators opt specific defaults out via `!path`.
    // After the override, `package.json` is no longer blocked — the diff
    // should reach CHECK_COMMAND and commit normally.
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
      { ...baseConfig, autoReviewBlockPaths: "!package.json" },
      deps,
      baseInputs,
    );

    expect(deps.info).toHaveBeenCalledWith(
      '[scope-check] AUTO_REVIEW_BLOCK_PATHS: "!package.json"',
    );
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.commitMessages.length).toBe(1);
  });

  it("legacy hardBlockOverride still works with a deprecation warning (TY-271)", async () => {
    // Backward compat: AUTO_REVIEW_HARD_BLOCK_OVERRIDE values are folded
    // into the new block-list as removals. Old repos keep working but get a
    // warning telling them to migrate.
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

    const warnCalls = (deps.warning as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => String(c[0]),
    );
    expect(
      warnCalls.some((m: string) =>
        m.includes("AUTO_REVIEW_HARD_BLOCK_OVERRIDE") && m.includes("deprecated"),
      ),
    ).toBe(true);
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.commitMessages.length).toBe(1);
  });

  it("still hard-blocks .github/ even when AUTO_REVIEW_BLOCK_PATHS=!.github/... is set (TY-271)", async () => {
    // .github/ is locked. The `!.github/...` removal is silently dropped,
    // and the scope check refuses the diff with `hard_block_path`.
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
        autoReviewBlockPaths: "!.github/workflows/auto-review-loop.yml",
      },
      deps,
      baseInputs,
    );

    const warnCalls = (deps.warning as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => String(c[0]),
    );
    expect(
      warnCalls.some((m: string) =>
        m.includes(".github/") && m.includes("locked"),
      ),
    ).toBe(true);
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

  it("scope_violation comment includes actionable AUTO_REVIEW_BLOCK_PATHS hint (TY-271)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t0\tdist/post-fix/index.cjs\n",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    const stopCall = (
      deps.postStopComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const detail = String(stopCall[6]);
    expect(detail).toContain("dist/post-fix/index.cjs");
    expect(detail).toContain("AUTO_REVIEW_BLOCK_PATHS");
    expect(detail).toContain("!dist/");
    expect(detail).toContain("docs/operations/scope-policy.md");
  });

  it("skips when state is no longer 'fixing' (manual intervention)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ status: "stopped", stopReason: "max_iterations" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  // TY-284: claude-code-action returning zero edits is treated as a stop
  // condition (`action_no_op`). The Phase 3 bookkeeping rolls back through
  // `failureExit` so soft `/restart-review` can replay the same findings.

  it("TY-284: no-op claude-code-action stops with action_no_op and rolls back Phase 3 bookkeeping", async () => {
    const stateAfterPhase3 = makeState({
      iterationCount: 2,
      findingsHashHistory: [
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
        { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
      ],
      lastFindingsHash: "bbbbbbbbbbbbbbbb",
      fixingStartedAt: "2026-05-17T00:00:00Z",
    });
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: stateAfterPhase3,
      },
      { gitDiffNumstat: () => "" },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // failureExit writes `stopped/action_no_op` with iteration / history
    // rolled back to the pre-Phase-3 baseline so a soft restart resumes the
    // same Codex findings without consuming an iteration or poisoning loop
    // detection.
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "action_no_op",
      iterationCount: 1,
      lastFindingsHash: "aaaaaaaaaaaaaaaa",
      fixingStartedAt: null,
    });
    expect(lastState.findingsHashHistory).toEqual([
      { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
    ]);
    // Stop notification is posted; the no-op path no longer re-requests
    // Codex review (the auto-retry behavior from TY-273 #B3 was removed).
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "action_no_op",
      1234,
      0,
      expect.stringContaining("no file changes"),
      "github-token",
    );
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  // TY-273 #B5: codex_request_failed downgrade.

  it("TY-273 #B5: downgrades to stopped/codex_request_failed when re-posting @codex review throws", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });
    (deps.postCodexReviewRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("HTTP 403: forbidden"),
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // The status comment ends up in stopped/codex_request_failed so the next
    // pre-fix run does NOT re-enter `waiting_codex` and deadlock.
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "codex_request_failed",
    });
    // The operator gets a top-level notification with the underlying error so
    // they can fix Codex auth and `/restart-review` once it's reachable.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "codex_request_failed",
      expect.any(Number),
      0,
      expect.stringContaining("HTTP 403: forbidden"),
      "github-token",
    );
  });

  // TY-273 #B4: fixingStartedAt clearing on terminal transitions.

  it("TY-273 #B4: clears fixingStartedAt on the clean waiting_codex transition", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ fixingStartedAt: "2026-05-17T00:00:00Z" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState.fixingStartedAt).toBeNull();
  });

  // TY-281: BUILD_COMMAND integration. Four cases cover the configurable
  // post-CHECK_COMMAND build step that keeps committed build artifacts in
  // sync with src/ for repos that ship `dist/`.

  it("TY-281: skips BUILD_COMMAND entirely when buildCommand is empty", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runBuildCommand).not.toHaveBeenCalled();
    // Behavior matches the clean-run case: stage claude's two files, commit, push.
    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages.length).toBe(1);
  });

  it("TY-281: runs BUILD_COMMAND after CHECK_COMMAND and includes generated artifacts in the commit", async () => {
    const numstatMock = vi.fn();
    numstatMock
      // Initial enumeration (claude's edits only).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-CHECK enumeration (same — CHECK_COMMAND did not add new files).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-build enumeration (claude's edits + regenerated dist).
      .mockReturnValueOnce(
        "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n200\t150\tdist/post-fix/index.cjs\n",
      );
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    // TY-281: post-build re-check uses `checkScopeBuildMode`, which skips
    // unlocked default block patterns (including `dist/`). The user no
    // longer needs `AUTO_REVIEW_BLOCK_PATHS=!dist/` just to commit build
    // artifacts under `dist/`.
    const configWithBuild = {
      ...baseConfig,
      buildCommand: "npm run bundle",
    };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.stagedPaths).toEqual([
      ["src/foo.ts", "tests/foo.test.ts", "dist/post-fix/index.cjs"],
    ]);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.commitMessages[0]).toContain("Files: 3, lines:");
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-281: BUILD_COMMAND that produces no new changes leaves the staging set unchanged", async () => {
    // Both enumeration calls return the same numstat — `npm run bundle` ran
    // but produced no diff (dist/ was already in sync with src/).
    const numstatMock = vi
      .fn()
      .mockReturnValue("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages.length).toBe(1);
  });

  it("TY-281: BUILD_COMMAND that erases all changes stops with action_failure", async () => {
    // The first numstat call returns claude's edits; the second (post-CHECK)
    // returns the same — CHECK_COMMAND made no additional changes; the third
    // (post-BUILD) returns empty — the build script erased everything back to
    // HEAD. Re-queuing would allow the loop to spin indefinitely because
    // loop-detection accounting is never advanced. Instead the run must stop
    // so the operator is notified.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce("");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — nothing to stage.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    // No Codex review re-requested — the loop stops here.
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    // Stop comment posted.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      99,
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND erased all working-tree changes"),
      "github-token",
    );
  });

  it("TY-281: BUILD_COMMAND non-zero exit resets the working tree and stops with action_failure", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        runBuildCommand: vi.fn().mockResolvedValue({
          success: false,
          output: "esbuild error: Cannot resolve './missing'",
        }),
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // Build failure ⇒ working tree reset, no commit, no push.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        // Iteration + findings hash were claimed by pre-fix; since no commit
        // landed, they must roll back so a soft /restart-review with the
        // same Codex findings doesn't loop-detect immediately.
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
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND failed"),
      "github-token",
    );
  });

  it("TY-281: CHECK_COMMAND-modified files use strict scope, not relaxed build-mode scope (Finding 1)", async () => {
    // Claude only changes src/foo.ts (passes initial scope check).
    // CHECK_COMMAND also modifies package.json (a default-blocked path).
    // Without the post-CHECK re-enumeration fix, package.json would be
    // classified as a buildDeltaFile and pass the relaxed checkScopeBuildMode.
    // With the fix, package.json is in postCheckChangedFiles → preBuildFiles →
    // strict checkScope → scope_violation.
    const numstatMock = vi
      .fn()
      // Initial enumeration: only Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-CHECK enumeration: CHECK_COMMAND also touched package.json.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\tpackage.json\n")
      // Post-BUILD enumeration: same + dist artifact.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\tpackage.json\n200\t150\tdist/index.cjs\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    // package.json is in preBuildFiles → strict checkScope → scope_violation.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "scope_violation" }),
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
      expect.stringContaining("package.json"),
      "github-token",
    );
  });

  it("TY-281: BUILD_COMMAND that reverts all repairs but produces an artifact stops with action_failure (Finding 2)", async () => {
    // Claude changes src/foo.ts; CHECK_COMMAND passes without further changes.
    // BUILD_COMMAND reverts src/foo.ts (restores it to HEAD) but creates
    // dist/artifact.js. postBuildChangedFiles.length === 1 > 0, so the
    // existing all-erased guard does not fire. preBuildFiles is empty because
    // src/foo.ts no longer differs from HEAD — the new guard must catch this.
    const numstatMock = vi
      .fn()
      // Initial enumeration: Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-CHECK enumeration: same.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-BUILD enumeration: BUILD_COMMAND reverted src/foo.ts and produced dist artifact.
      .mockReturnValueOnce("200\t150\tdist/artifact.js\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — the repair was reverted.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.resetCalls).toBe(1);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
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
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND reverted all repair edits"),
      "github-token",
    );
  });

  it("TY-281: BUILD_COMMAND that reverts a subset of repairs stops with action_failure (Finding 3)", async () => {
    // Claude changes src/fix1.ts and src/fix2.ts; CHECK_COMMAND passes without
    // further changes. BUILD_COMMAND keeps src/fix1.ts but reverts src/fix2.ts
    // (restores it to HEAD) and produces dist/artifact.js.
    // postBuildChangedFiles = [src/fix1.ts, dist/artifact.js] so:
    //   - postBuildChangedFiles.length > 0 → all-erased guard does not fire
    //   - preBuildFiles = [src/fix1.ts] (non-empty) → all-reverted guard does not fire
    //   - revertedPaths = [src/fix2.ts] → new partial-revert guard must catch this
    const numstatMock = vi
      .fn()
      // Initial enumeration: both of Claude's edits.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n3\t0\tsrc/fix2.ts\n")
      // Post-CHECK enumeration: same.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n3\t0\tsrc/fix2.ts\n")
      // Post-BUILD enumeration: fix2.ts reverted, dist artifact added.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n200\t150\tdist/artifact.js\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — the partial repair must not land.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.resetCalls).toBe(1);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
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
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND reverted some repair edits"),
      "github-token",
    );
  });

  it("TY-281: CHECK_COMMAND scratch files cleaned up by BUILD_COMMAND do not trigger action_failure", async () => {
    // Claude changes src/fix.ts. CHECK_COMMAND passes and creates a scratch
    // file (tmp/check-report.json) as an untracked side-effect. BUILD_COMMAND
    // removes the scratch file (does not restore it) while producing the real
    // dist artifact. Without the fix, the scratch file disappearing from
    // postBuildPathSet would trigger the partial-revert guard even though
    // src/fix.ts (the real repair) is intact in post-BUILD.
    const numstatMock = vi
      .fn()
      // Initial enumeration: Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-CHECK enumeration: same (CHECK_COMMAND did not modify tracked files).
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-BUILD enumeration: repair intact + dist artifact.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n200\t100\tdist/bundle.cjs\n");
    const untrackedMock = vi
      .fn()
      // Initial enumeration: no untracked files.
      .mockReturnValueOnce("")
      // Post-CHECK enumeration: CHECK_COMMAND wrote a scratch report.
      .mockReturnValueOnce("tmp/check-report.json\n")
      // Post-BUILD enumeration: BUILD_COMMAND cleaned up the scratch file.
      .mockReturnValueOnce("")
      // Pre-commit secret scan enumeration (TY-274 follow-up).
      .mockReturnValueOnce("");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
        gitListUntracked: untrackedMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    // Scratch-file cleanup by BUILD_COMMAND is not a revert of the repair.
    // The run must succeed: commit and push happen, no reset.
    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.resetCalls).toBe(0);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-281: post-build scope check rejects build artifacts that land in blocked paths", async () => {
    // A misconfigured BUILD_COMMAND that writes into the locked `.github/`
    // tree must trip the post-build scope re-check rather than slip into
    // the commit. `.github/` is locked (TY-271) so even `!.github/...` is
    // ignored — there is no override path.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-CHECK enumeration (same — CHECK_COMMAND did not add new files).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce(
        "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n10\t0\t.github/workflows/leaked.yml\n",
      );
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // Build "succeeded" (non-zero exit was not the trigger) but produced a
    // scope-violating artifact → reset, no commit, scope_violation stop.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
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
  });
});
