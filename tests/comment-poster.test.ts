import { beforeEach, describe, expect, it, vi } from "vitest";

const warning = vi.fn();
const infoLog = vi.fn();
vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
  info: (msg: string) => infoLog(msg),
}));

vi.mock("../src/gh.js", () => ({
  ghApi: vi.fn(),
}));

vi.mock("../src/status-comment.js", () => ({
  upsertStatusComment: vi.fn(),
}));

const { ghApi } = await import("../src/gh.js");
const { upsertStatusComment } = await import("../src/status-comment.js");
const {
  AUTO_MERGE_SKIP_PREFIX,
  buildAutoMergeSkipBody,
  buildStatusCommentPermalink,
  buildTerminalNotificationBody,
  deriveIterationProgress,
  nextActionForStopReason,
  postAutoMergeSkipNotification,
  postClaudeCodeActionFixSummary,
  postCompletionComment,
  postFixingStartComment,
  postInitialStatusComment,
  postInitIncompleteComment,
  postStopComment,
  postTerminalNotification,
  postTestFailureComment,
} = await import("../src/comment-poster.js");
const { STOP_REASON_LABELS } = await import("../src/types.js");
const { createInitialState } = await import("../src/state-manager.js");

const mockedGhApi = vi.mocked(ghApi);
const mockedUpsertStatusComment = vi.mocked(upsertStatusComment);

const STATUS_COMMENT_ID = 999_001;
const POSTED_COMMENT_ID = 999_002;

function expectPostCommentInvocation(call: unknown[]): {
  args: readonly string[];
  body: string;
} {
  const args = call[0] as readonly string[];
  // TY-269 #13 (fix-up): postComment uses `--raw-field body=<body>` so that
  // gh CLI does not treat a leading `@` (e.g. `@codex review`) as a
  // file-read directive. The old `-f` / `--field` are no longer accepted.
  const bodyArgIndex = args.indexOf("--raw-field");
  const bodyArg = args[bodyArgIndex + 1] ?? "";
  expect(bodyArg.startsWith("body=")).toBe(true);
  return { args, body: bodyArg.slice("body=".length) };
}

beforeEach(() => {
  warning.mockReset();
  infoLog.mockReset();
  mockedGhApi.mockReset();
  mockedUpsertStatusComment.mockReset();
  mockedUpsertStatusComment.mockResolvedValue(STATUS_COMMENT_ID);
  // Default ghApi return — used when postComment is invoked.
  mockedGhApi.mockResolvedValue(String(POSTED_COMMENT_ID));
});

describe("buildStatusCommentPermalink (TY-259)", () => {
  it("formats the comment permalink in the GitHub standard form", () => {
    expect(
      buildStatusCommentPermalink("edereship", "loop-pilot", 65, 999),
    ).toBe(
      "https://github.com/edereship/loop-pilot/pull/65#issuecomment-999",
    );
  });
});

describe("buildTerminalNotificationBody (TY-259)", () => {
  const permalink = "https://example.test/pull/1#issuecomment-1";

  it("renders the done body with iteration count and permalink", () => {
    const body = buildTerminalNotificationBody(
      { kind: "done", iterations: 3 },
      permalink,
    );
    expect(body).toContain("✅");
    expect(body).toContain("LoopPilot completed");
    expect(body).toContain("3 iterations");
    expect(body).toContain(`[status comment](${permalink})`);
  });

  it("pluralizes correctly for a single iteration", () => {
    const body = buildTerminalNotificationBody(
      { kind: "done", iterations: 1 },
      permalink,
    );
    expect(body).toContain("1 iteration)");
    expect(body).not.toContain("1 iterations");
  });

  it("BUG-01: surfaces dropped unparseable Codex comments on the done body", () => {
    const body = buildTerminalNotificationBody(
      { kind: "done", iterations: 2, unparseableComments: 3 },
      permalink,
    );
    expect(body).toContain("✅");
    expect(body).toContain("3 Codex comment(s) could not be parsed");
    expect(body).toContain("review them manually");
  });

  it("BUG-01: omits the unparseable caution when the count is zero / absent", () => {
    expect(
      buildTerminalNotificationBody(
        { kind: "done", iterations: 2, unparseableComments: 0 },
        permalink,
      ),
    ).not.toContain("could not be parsed");
    expect(
      buildTerminalNotificationBody({ kind: "done", iterations: 2 }, permalink),
    ).not.toContain("could not be parsed");
  });

  it("renders the stopped body with the reason label and remaining count", () => {
    const body = buildTerminalNotificationBody(
      {
        kind: "stopped",
        stopReason: "max_turns_exceeded",
        remainingFindings: 2,
      },
      permalink,
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("LoopPilot stopped");
    expect(body).toContain(STOP_REASON_LABELS.max_turns_exceeded);
    expect(body).toContain("Open in-scope findings remaining: 2");
    expect(body).toContain("Manual intervention required");
    expect(body).toContain(`[status comment](${permalink})`);
  });

  it("renders the stopped body without a count when remainingFindings is omitted", () => {
    const body = buildTerminalNotificationBody(
      {
        kind: "stopped",
        stopReason: "test_failure",
      },
      permalink,
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("LoopPilot stopped");
    expect(body).toContain("Manual intervention required");
    expect(body).not.toContain("Open in-scope findings remaining");
    expect(body).toContain(`[status comment](${permalink})`);
  });

  it("renders the init_incomplete body with the three YAML fail-safe operator actions (TY-293 #3)", () => {
    const body = buildTerminalNotificationBody(
      { kind: "init_incomplete" },
      permalink,
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("init incomplete");
    // TY-293 #3 (UX-10): wording must match the YAML fail-safe in
    // `looppilot-init.yml` so the in-process notification and the
    // fail-safe present the same three concrete actions.
    expect(body).toContain("Re-run the Workflow A run from the Actions tab");
    expect(body).toContain("Re-trigger init by removing and re-adding the gate label");
    expect(body).toContain("closing / reopening the PR in full-auto mode");
    expect(body).toContain(`[status comment](${permalink})`);
  });
});

describe("postTerminalNotification (TY-259)", () => {
  it("posts a top-level comment with the rendered body", async () => {
    await postTerminalNotification(
      "edereship",
      "loop-pilot",
      65,
      STATUS_COMMENT_ID,
      { kind: "done", iterations: 2 },
      "token",
    );

    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("LoopPilot completed");
    expect(body).toContain(
      `https://github.com/edereship/loop-pilot/pull/65#issuecomment-${STATUS_COMMENT_ID}`,
    );
  });

  it("swallows post failures and emits a warning instead of throwing", async () => {
    mockedGhApi.mockRejectedValueOnce(new Error("network down"));

    await expect(
      postTerminalNotification(
        "edereship",
        "loop-pilot",
        65,
        STATUS_COMMENT_ID,
        { kind: "stopped", stopReason: "max_turns_exceeded", remainingFindings: 0 },
        "token",
      ),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain(
      "[comment-poster] Failed to post terminal notification: network down",
    );
  });
});

describe("terminal poster wiring (TY-259)", () => {
  it("postCompletionComment also posts a top-level notification", async () => {
    const result = await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      4,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("LoopPilot completed");
    expect(body).toContain("4 iterations");
  });

  it("postStopComment also posts a top-level notification with the reason label", async () => {
    const result = await postStopComment(
      "edereship",
      "loop-pilot",
      65,
      "scope_violation",
      4_466_800_630,
      3,
      "Scope check rejected the repair diff.",
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("LoopPilot stopped");
    expect(body).toContain(STOP_REASON_LABELS.scope_violation);
    expect(body).toContain("Open in-scope findings remaining: 3");
  });

  it("postInitIncompleteComment also posts a top-level notification", async () => {
    const result = await postInitIncompleteComment(
      "edereship",
      "loop-pilot",
      65,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    // TY-293 #3 (UX-10): post-rewrite wording is "init incomplete" (lowercase
    // "init", matches the YAML fail-safe and the in-process notification).
    expect(body).toContain("init incomplete");
  });

  it("postClaudeCodeActionFixSummary does NOT post a top-level notification (iter progress stays aggregated)", async () => {
    const result = await postClaudeCodeActionFixSummary(
      "edereship",
      "loop-pilot",
      65,
      1,
      ["src/foo.ts"],
      "abcd123",
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).not.toHaveBeenCalled();
  });

  it("postTestFailureComment does NOT post a top-level notification on its own (post-fix follows with postStopComment)", async () => {
    const result = await postTestFailureComment(
      "edereship",
      "loop-pilot",
      65,
      "FAIL\nFAIL\n",
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).not.toHaveBeenCalled();
  });

  it("postTestFailureComment fences output safely against ``` AND ~~~ runs (TY-275 #8)", async () => {
    // GitHub markdown treats both backtick and tilde runs of length >= 3 as
    // code-fence openers. A payload containing either could break out of the
    // outer fence and start interpreting CHECK_COMMAND output as markdown.
    // The fence picks a backtick run longer than any internal run.
    const payload = [
      "vitest output:",
      "```ts",
      "test code with internal triple-backticks",
      "```",
      "and tilde fence:",
      "~~~",
      "extra content",
      "~~~",
    ].join("\n");
    await postTestFailureComment(
      "edereship",
      "loop-pilot",
      65,
      payload,
      "token",
    );

    // The status comment helper receives an entry whose body is the fenced
    // output. Inspect the call and verify the outer fence is at least 4
    // backticks (longer than the 3-backtick internal run).
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    const call = mockedUpsertStatusComment.mock.calls[0]!;
    // The entry body is buried in the upsertStatusComment args; check the
    // payload made it through and the fence is a >=4-backtick run.
    const bodyArg = JSON.stringify(call);
    expect(bodyArg).toMatch(/````+/);
    // The payload appears verbatim — the test runner output is NOT mangled
    // (no `\`\`\`` → `\`\`` replacement that the old escape produced).
    expect(bodyArg).toContain("test code with internal triple-backticks");
  });

  it("caps fence length so pathologically long backtick runs cannot overflow GitHub's comment limit (TY-275 #8, Codex r3257188563)", async () => {
    // A payload containing a 500-char backtick run previously caused the
    // fence to be 501 chars × 2 = 1002 chars of pure fence overhead. Scaled
    // to 60,000 chars (sanitizeOutput's cap) this blows GitHub's 65,536-char
    // body limit and the stop comment post fails entirely — losing the
    // operator's only visible stop signal.
    const longBacktickRun = "`".repeat(500);
    const payload = `before\n${longBacktickRun}\nafter`;
    await postTestFailureComment(
      "edereship",
      "loop-pilot",
      65,
      payload,
      "token",
    );

    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    const bodyArg = JSON.stringify(mockedUpsertStatusComment.mock.calls[0]!);

    // The 500-char backtick run must have been collapsed to ≤ 100 chars in
    // the payload before the fence was computed; the fence is therefore
    // ≤ 101 chars rather than 501. We assert the cap is honored: the body
    // must NOT contain any 200+ char backtick run (which would indicate
    // either the original payload survived or the fence exploded).
    expect(bodyArg).not.toMatch(/`{200,}/);
    // The body still contains the surrounding context.
    expect(bodyArg).toContain("before");
    expect(bodyArg).toContain("after");
  });

  it("caps fence length for pathologically long tilde runs (TY-275 #8, Codex r3257188563)", async () => {
    const longTildeRun = "~".repeat(500);
    await postTestFailureComment(
      "edereship",
      "loop-pilot",
      65,
      `before\n${longTildeRun}\nafter`,
      "token",
    );

    const bodyArg = JSON.stringify(mockedUpsertStatusComment.mock.calls[0]!);
    // Tilde runs in the payload must also be collapsed to ≤ 100 chars.
    expect(bodyArg).not.toMatch(/~{200,}/);
  });

  it("returns the status comment ID even when the terminal notification post fails", async () => {
    mockedGhApi.mockRejectedValueOnce(new Error("rate limited"));

    const result = await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe("nextActionForStopReason (TY-291 #4)", () => {
  it("returns the `--hard` imperative for max_iterations", () => {
    expect(nextActionForStopReason("max_iterations")).toContain(
      "`/restart-review --hard`",
    );
  });

  it("returns a soft-only message for codex_request_failed", () => {
    const text = nextActionForStopReason("codex_request_failed");
    expect(text).toContain("Codex");
    expect(text).toContain("`/restart-review`");
    expect(text).not.toContain("--hard");
  });

  it("points secret_leak_suspected at the hard restart explicitly (TY-274 #1)", () => {
    expect(nextActionForStopReason("secret_leak_suspected")).toContain(
      "`/restart-review --hard`",
    );
  });

  it("references stop-and-recovery.md for state_corrupted / state_conflict", () => {
    expect(nextActionForStopReason("state_corrupted")).toContain(
      "stop-and-recovery.md",
    );
    expect(nextActionForStopReason("state_conflict")).toContain(
      "stop-and-recovery.md",
    );
  });

  it("scope_violation points to stop detail and /restart-review without prescribing a single path (Finding 4)", () => {
    const text = nextActionForStopReason("scope_violation");
    // Must direct operators to the stop detail rather than assuming LOOPPILOT_BLOCK_PATHS is the fix.
    expect(text).toContain("stop detail");
    // Still mentions LOOPPILOT_BLOCK_PATHS as one option.
    expect(text).toContain("LOOPPILOT_BLOCK_PATHS");
    expect(text).toContain("`/restart-review`");
  });
});

describe("deriveIterationProgress (TY-291 #3)", () => {
  it("returns lastModelTier=null when the history is empty", () => {
    const progress = deriveIterationProgress(createInitialState(), 20);
    expect(progress).toEqual({
      iterationCount: 0,
      maxIterations: 20,
      lastModelTier: null,
    });
  });

  it("returns the most recent entry's modelTier", () => {
    const state = {
      ...createInitialState(),
      iterationCount: 2,
      findingsHashHistory: [
        { iteration: 1, hash: "a", modelTier: "base" as const },
        { iteration: 2, hash: "b", modelTier: "escalated" as const },
      ],
    };
    expect(deriveIterationProgress(state, 20)).toEqual({
      iterationCount: 2,
      maxIterations: 20,
      lastModelTier: "escalated",
    });
  });

  it("treats missing modelTier on the last entry as `escalated` (TY-243 fallback)", () => {
    const state = {
      ...createInitialState(),
      iterationCount: 1,
      findingsHashHistory: [{ iteration: 1, hash: "a" }],
    };
    expect(deriveIterationProgress(state, 20).lastModelTier).toBe("escalated");
  });
});

describe("postClaudeCodeActionFixSummary (TY-291 #1)", () => {
  it("writes Current=`Fix committed (iteration N) — queuing Codex re-review` (UX-04)", async () => {
    await postClaudeCodeActionFixSummary(
      "edereship",
      "loop-pilot",
      65,
      3,
      ["src/foo.ts"],
      "abcd123",
      "token",
    );

    const call = mockedUpsertStatusComment.mock.calls[0]!;
    const update = call[3] as { current: string; nextAction: string };
    expect(update.current).toBe("Fix committed (iteration 3) — queuing Codex re-review");
    expect(update.nextAction).toBe(
      "Codex re-review is being queued; no operator action needed.",
    );
  });

  it("forwards iteration progress when provided", async () => {
    await postClaudeCodeActionFixSummary(
      "edereship",
      "loop-pilot",
      65,
      3,
      ["src/foo.ts"],
      "abcd123",
      "token",
      { iterationCount: 3, maxIterations: 20, lastModelTier: "base" },
    );

    const update = mockedUpsertStatusComment.mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(update.iterationCount).toBe(3);
    expect(update.maxIterations).toBe(20);
    expect(update.lastModelTier).toBe("base");
  });
});

describe("postCompletionComment (TY-291 #4)", () => {
  it("uses the auto-merge imperative when autoMergeOnClean=true", async () => {
    await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
      { autoMergeOnClean: true },
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
    };
    expect(update.nextAction).toBe(
      "Auto-merge will be attempted — the PR will squash-merge once all other CI checks pass; merge manually if it does not.",
    );
  });

  it("uses the manual-merge imperative when autoMergeOnClean=false", async () => {
    await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
      { autoMergeOnClean: false },
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
    };
    expect(update.nextAction).toBe("Review the changes and merge manually.");
  });

  it("BUG-01: surfaces unparseable Codex comments in the entry body, nextAction, and top-level notification", async () => {
    await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
      { autoMergeOnClean: false, unparseableComments: 2 },
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
      newEntry: { body: string };
    };
    expect(update.nextAction).toContain(
      "2 Codex comment(s) could not be parsed for severity",
    );
    expect(update.newEntry.body).toContain("could not be parsed for severity");
    // The top-level notification (GitHub inbox) must also carry the caution so
    // it is not log-only.
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("2 Codex comment(s) could not be parsed");
  });

  it("BUG-01: leaves the completion comment unchanged when no comments were unparseable", async () => {
    await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
      { autoMergeOnClean: false, unparseableComments: 0 },
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
      newEntry: { body: string };
    };
    expect(update.nextAction).toBe("Review the changes and merge manually.");
    expect(update.newEntry.body).not.toContain("could not be parsed");
  });

  it("Finding 1: uses manual-merge nextAction when autoMergeOnClean=true but unparseableComments > 0", async () => {
    // Auto-merge is withheld by main-pre-fix when unparseable comments exist,
    // so the completion comment must not tell operators that auto-merge will be
    // attempted — that would be contradictory and cause indefinite waiting.
    await postCompletionComment(
      "edereship",
      "loop-pilot",
      65,
      2,
      "token",
      { autoMergeOnClean: true, unparseableComments: 3 },
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
    };
    expect(update.nextAction).not.toContain("Auto-merge will be attempted");
    expect(update.nextAction).toContain("merge manually");
    expect(update.nextAction).toContain("3 Codex comment(s) could not be parsed");
  });
});

describe("postStopComment (TY-291 #4)", () => {
  it("sets nextAction via nextActionForStopReason instead of generic text", async () => {
    await postStopComment(
      "edereship",
      "loop-pilot",
      65,
      "max_iterations",
      111,
      0,
      "Reached MAX_REVIEW_ITERATIONS (20)",
      "token",
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as {
      nextAction: string;
    };
    expect(update.nextAction).toBe(nextActionForStopReason("max_iterations"));
    expect(update.nextAction).not.toBe("Manual intervention required.");
  });
});

describe("postInitialStatusComment (TY-291 #2)", () => {
  it("seeds the visible status comment with iteration budget = 0 / N", async () => {
    const result = await postInitialStatusComment(
      "edereship",
      "loop-pilot",
      65,
      20,
      "token",
    );
    expect(result).toBe(STATUS_COMMENT_ID);

    const update = mockedUpsertStatusComment.mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(update.current).toBe("Initialized — waiting for first Codex review");
    expect(update.iterationCount).toBe(0);
    expect(update.maxIterations).toBe(20);
    expect(update.lastModelTier).toBeNull();
  });
});

describe("postFixingStartComment (TY-291 #2)", () => {
  it("announces the fixing transition with iteration and tier in the header", async () => {
    await postFixingStartComment(
      "edereship",
      "loop-pilot",
      65,
      4,
      "escalated",
      20,
      3,
      "token",
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(update.current).toBe(
      "Fixing — iteration 4 starting (model: escalated)",
    );
    expect(update.iterationCount).toBe(4);
    expect(update.maxIterations).toBe(20);
    expect(update.lastModelTier).toBe("escalated");
  });

  it("sets openFindings so operators see the finding count during the repair run (Finding 5)", async () => {
    await postFixingStartComment(
      "edereship",
      "loop-pilot",
      65,
      1,
      "base",
      20,
      5,
      "token",
    );
    const update = mockedUpsertStatusComment.mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(update.openFindings).toBe(5);
  });
});

describe("buildAutoMergeSkipBody (TY-295)", () => {
  const RUN_URL =
    "https://github.com/edereship/loop-pilot/actions/runs/12345";

  it("starts every body with the AUTO_MERGE_SKIP_PREFIX for operator scannability and dedup", () => {
    // The dedup query in `recentAutoMergeSkipExists` matches on this prefix,
    // so every kind MUST render with it as the very first characters.
    const kinds: Array<Parameters<typeof buildAutoMergeSkipBody>[0]> = [
      { kind: "transient_error", detail: "x" },
      { kind: "head_empty" },
      { kind: "head_changed", oldSha: "abc", newSha: "def" },
      {
        kind: "ci_failed",
        failures: [{ name: "ci", conclusion: "failure" }],
      },
      { kind: "timeout_no_runs", timeoutMinutes: 10 },
      { kind: "timeout_pending", timeoutMinutes: 10, pending: ["ci"] },
      { kind: "merge_sha_unsettled", timeoutMinutes: 10 },
      { kind: "merge_call_failed", detail: "x" },
      { kind: "unparseable_findings", count: 1 },
    ];
    for (const kind of kinds) {
      const body = buildAutoMergeSkipBody(kind, RUN_URL);
      expect(body.startsWith(AUTO_MERGE_SKIP_PREFIX)).toBe(true);
      expect(body).toContain(`Workflow run: ${RUN_URL}`);
    }
  });

  it("BUG-01: unparseable_findings explains the withheld auto-merge and the manual-review next step", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "unparseable_findings", count: 3 },
      RUN_URL,
    );
    expect(body).toContain("3 Codex comment(s) could not be parsed for severity");
    expect(body).toContain("Auto-merge was withheld");
    expect(body).toContain("Review the unparseable comment(s) manually");
  });

  it("ci_failed lists every failed run with its name and conclusion (operator decides /restart-review vs manual fix)", () => {
    const body = buildAutoMergeSkipBody(
      {
        kind: "ci_failed",
        failures: [
          { name: "typecheck", conclusion: "failure" },
          { name: "lint", conclusion: "cancelled" },
        ],
      },
      RUN_URL,
    );
    expect(body).toContain("2 CI run(s) failed");
    expect(body).toContain("`typecheck` (`failure`)");
    expect(body).toContain("`lint` (`cancelled`)");
    // The point of this notification: operator must know LoopPilot is ✅
    // but another CI is red — the body has to spell out manual action.
    expect(body).toContain("Resolve the failing checks");
  });

  it("timeout_pending names the pending runs and references the timeout tunable", () => {
    const body = buildAutoMergeSkipBody(
      {
        kind: "timeout_pending",
        timeoutMinutes: 10,
        pending: ["slow-e2e", "build"],
      },
      RUN_URL,
    );
    expect(body).toContain("10 min");
    expect(body).toContain("`slow-e2e`");
    expect(body).toContain("`build`");
    expect(body).toContain("LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES");
  });

  it("timeout_no_runs explains the no-CI-vs-API-lag ambiguity rather than hiding it", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "timeout_no_runs", timeoutMinutes: 10 },
      RUN_URL,
    );
    expect(body).toContain("waiting for any non-self CI run to appear");
    expect(body).toContain("no CI configured");
  });

  it("merge_sha_unsettled explains the unsettled merge commit (conflict) instead of claiming pending CI", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "merge_sha_unsettled", timeoutMinutes: 10 },
      RUN_URL,
    );
    expect(body).toContain("10 min");
    expect(body).toContain("merge commit");
    expect(body).toContain("conflicts");
    // The whole point of this kind: it must NOT contradictorily imply CI runs
    // are still pending (the bug it replaces emitted "0 CI run(s) still pending").
    expect(body).not.toContain("still pending");
  });

  it("head_changed includes the old and new sha and points at /restart-review", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "head_changed", oldSha: "abc123", newSha: "def456" },
      RUN_URL,
    );
    expect(body).toContain("`abc123`");
    expect(body).toContain("`def456`");
    expect(body).toContain("/restart-review");
  });

  it("head_empty surfaces the deleted-or-force-pushed-to-nothing case", () => {
    const body = buildAutoMergeSkipBody({ kind: "head_empty" }, RUN_URL);
    expect(body).toContain("HEAD sha is empty");
    expect(body).toContain("Investigate the PR state manually");
  });

  it("transient_error preserves the underlying error detail so the operator can grep logs", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "transient_error", detail: "failed to read PR HEAD sha (rate-limit)" },
      RUN_URL,
    );
    expect(body).toContain("transient error");
    expect(body).toContain("failed to read PR HEAD sha (rate-limit)");
    expect(body).toContain("temporary GitHub API issue");
  });

  it("merge_call_failed points at the most common cause (Allow auto-merge disabled per TY-288)", () => {
    const body = buildAutoMergeSkipBody(
      { kind: "merge_call_failed", detail: "Pull request merging is not enabled" },
      RUN_URL,
    );
    expect(body).toContain("`gh pr merge` was rejected");
    expect(body).toContain("Pull request merging is not enabled");
    expect(body).toContain("Allow auto-merge");
    expect(body).toContain("TY-288");
  });
});

describe("postAutoMergeSkipNotification (TY-295)", () => {
  const RUN_URL =
    "https://github.com/edereship/loop-pilot/actions/runs/12345";

  it("posts when no recent skip notification exists in the dedup window", async () => {
    // First ghApi call: dedup query returns no matching bodies.
    // Second ghApi call: postComment returns the new comment id.
    mockedGhApi.mockResolvedValueOnce(""); // dedup query
    mockedGhApi.mockResolvedValueOnce(String(POSTED_COMMENT_ID)); // postComment

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "ci_failed", failures: [{ name: "ci", conclusion: "failure" }] },
      RUN_URL,
      "token",
    );

    expect(mockedGhApi).toHaveBeenCalledTimes(2);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[1]);
    expect(body.startsWith(AUTO_MERGE_SKIP_PREFIX)).toBe(true);
    expect(body).toContain("`ci` (`failure`)");
  });

  it("suppresses a duplicate post when a prefix-matching comment exists in the 90s dedup window", async () => {
    // Dedup query returns a body that already starts with the prefix — the
    // function must NOT call postComment a second time. The query uses
    // `.[].body | @json`, so each body arrives as a single JSON-encoded line.
    mockedGhApi.mockResolvedValueOnce(
      JSON.stringify(`${AUTO_MERGE_SKIP_PREFIX} — earlier skip notification body`),
    );

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "ci_failed", failures: [{ name: "ci", conclusion: "failure" }] },
      RUN_URL,
      "token",
    );

    // One call total: the dedup query. No second postComment call.
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it("falls open (still posts) when the dedup query itself fails", async () => {
    // TY-282 #2B fall-open: a flaky dedup must not permanently silence a
    // legitimate skip notification.
    mockedGhApi.mockRejectedValueOnce(new Error("rate-limit"));
    mockedGhApi.mockResolvedValueOnce(String(POSTED_COMMENT_ID));

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "head_empty" },
      RUN_URL,
      "token",
    );

    expect(mockedGhApi).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalled();
    expect(warning.mock.calls[0][0]).toContain(
      "Auto-merge skip dedup query failed (fall-open)",
    );
  });

  it("swallows post failures and emits a warning so the merger's skip decision is never blocked", async () => {
    // Dedup query passes (returns empty), but the postComment call fails.
    // The function must return normally — the production caller logs its
    // own warning, so the merger's skip semantics stay intact.
    mockedGhApi.mockResolvedValueOnce(""); // dedup OK
    mockedGhApi.mockRejectedValueOnce(new Error("network down")); // post fails

    await expect(
      postAutoMergeSkipNotification(
        "edereship",
        "loop-pilot",
        65,
        { kind: "head_empty" },
        RUN_URL,
        "token",
      ),
    ).resolves.toBeUndefined();

    const failureWarning = warning.mock.calls.find((c) =>
      String(c[0]).includes("Failed to post auto-merge skip notification"),
    );
    expect(failureWarning).toBeDefined();
    expect(String(failureWarning![0])).toContain("network down");
  });

  it("queries with a `since=` filter so old skip comments outside the 90s window don't suppress a fresh post", async () => {
    mockedGhApi.mockResolvedValueOnce("");
    mockedGhApi.mockResolvedValueOnce(String(POSTED_COMMENT_ID));

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "head_empty" },
      RUN_URL,
      "token",
    );

    const dedupArgs = mockedGhApi.mock.calls[0]![0] as readonly string[];
    const path = dedupArgs[1] ?? "";
    expect(path).toContain("/comments?since=");
  });

  it("uses --paginate (not per_page=30) so the dedup target isn't missed past the first page (TY-310 #1)", async () => {
    mockedGhApi.mockResolvedValueOnce("");
    mockedGhApi.mockResolvedValueOnce(String(POSTED_COMMENT_ID));

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "head_empty" },
      RUN_URL,
      "token",
    );

    const dedupArgs = mockedGhApi.mock.calls[0]![0] as readonly string[];
    expect(dedupArgs).toContain("--paginate");
    const path = dedupArgs[1] ?? "";
    expect(path).not.toContain("per_page=30");
  });

  it("detects a dedup-target comment even when it appears after many earlier comments (TY-310 #1)", async () => {
    // High-traffic 90s window: 120 non-matching bodies followed by the recent
    // skip notification. The old `per_page=30` (no pagination) returned only the
    // OLDEST 30 comments — GitHub serves issue comments ascending — so the late
    // prefix line was invisible and the duplicate post fired. With --paginate the
    // whole window is scanned and the late match suppresses the duplicate.
    // `.[].body | @json` emits one JSON-encoded body per line, so encode each.
    const bodies = [
      ...Array.from({ length: 120 }, (_, i) => `unrelated comment ${i}`),
      `${AUTO_MERGE_SKIP_PREFIX} — most recent skip notification`,
    ]
      .map((b) => JSON.stringify(b))
      .join("\n");
    mockedGhApi.mockResolvedValueOnce(bodies);

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "ci_failed", failures: [{ name: "ci", conclusion: "failure" }] },
      RUN_URL,
      "token",
    );

    // Only the dedup query ran; the suppressed path makes no second postComment call.
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
  });

  it("does not suppress when a comment only quotes the prefix on a non-first line (TY-359 / #155)", async () => {
    // A blockquote of an earlier skip notification embeds the prefix in the
    // MIDDLE of the body, not at its start. With `.[].body | @json` the body is
    // one JSON-encoded line and the prefix test is anchored to the decoded
    // body's start, so the quote must NOT be treated as a prior notification.
    // The pre-fix line-by-line `.[].body` form matched the quoted line and
    // wrongly suppressed the fresh notification.
    const quotingBody = `Following up on the earlier run:\n\n> ${AUTO_MERGE_SKIP_PREFIX} — CI failed last time`;
    mockedGhApi.mockResolvedValueOnce(JSON.stringify(quotingBody)); // dedup query (@json)
    mockedGhApi.mockResolvedValueOnce(String(POSTED_COMMENT_ID)); // postComment

    await postAutoMergeSkipNotification(
      "edereship",
      "loop-pilot",
      65,
      { kind: "ci_failed", failures: [{ name: "ci", conclusion: "failure" }] },
      RUN_URL,
      "token",
    );

    // Not suppressed: dedup query + the fresh postComment.
    expect(mockedGhApi).toHaveBeenCalledTimes(2);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[1]);
    expect(body.startsWith(AUTO_MERGE_SKIP_PREFIX)).toBe(true);
  });
});
