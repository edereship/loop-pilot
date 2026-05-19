import { beforeEach, describe, expect, it, vi } from "vitest";

const warning = vi.fn();
vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
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
  buildStatusCommentPermalink,
  buildTerminalNotificationBody,
  postClaudeCodeActionFixSummary,
  postCompletionComment,
  postInitIncompleteComment,
  postStopComment,
  postTerminalNotification,
  postTestFailureComment,
} = await import("../src/comment-poster.js");
const { STOP_REASON_LABELS } = await import("../src/types.js");

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
  mockedGhApi.mockReset();
  mockedUpsertStatusComment.mockReset();
  mockedUpsertStatusComment.mockResolvedValue(STATUS_COMMENT_ID);
  // Default ghApi return — used when postComment is invoked.
  mockedGhApi.mockResolvedValue(String(POSTED_COMMENT_ID));
});

describe("buildStatusCommentPermalink (TY-259)", () => {
  it("formats the comment permalink in the GitHub standard form", () => {
    expect(
      buildStatusCommentPermalink("team-yubune", "test-auto-ai-review", 65, 999),
    ).toBe(
      "https://github.com/team-yubune/test-auto-ai-review/pull/65#issuecomment-999",
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
    expect(body).toContain("Auto-review completed");
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

  it("renders the stopped body with the reason label and remaining count", () => {
    const body = buildTerminalNotificationBody(
      {
        kind: "stopped",
        stopReason: "max_turns_exceeded",
        remainingFindings: 2,
      },
      permalink,
    );
    expect(body).toContain("🛑");
    expect(body).toContain("Auto-review stopped");
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
    expect(body).toContain("🛑");
    expect(body).toContain("Auto-review stopped");
    expect(body).toContain("Manual intervention required");
    expect(body).not.toContain("Open in-scope findings remaining");
    expect(body).toContain(`[status comment](${permalink})`);
  });

  it("renders the init_incomplete body with operator guidance", () => {
    const body = buildTerminalNotificationBody(
      { kind: "init_incomplete" },
      permalink,
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("initialization incomplete");
    expect(body).toContain("Re-run Workflow A or manually post `@codex review`");
    expect(body).toContain(`[status comment](${permalink})`);
  });
});

describe("postTerminalNotification (TY-259)", () => {
  it("posts a top-level comment with the rendered body", async () => {
    await postTerminalNotification(
      "team-yubune",
      "test-auto-ai-review",
      65,
      STATUS_COMMENT_ID,
      { kind: "done", iterations: 2 },
      "token",
    );

    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("Auto-review completed");
    expect(body).toContain(
      `https://github.com/team-yubune/test-auto-ai-review/pull/65#issuecomment-${STATUS_COMMENT_ID}`,
    );
  });

  it("swallows post failures and emits a warning instead of throwing", async () => {
    mockedGhApi.mockRejectedValueOnce(new Error("network down"));

    await expect(
      postTerminalNotification(
        "team-yubune",
        "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
      65,
      4,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("Auto-review completed");
    expect(body).toContain("4 iterations");
  });

  it("postStopComment also posts a top-level notification with the reason label", async () => {
    const result = await postStopComment(
      "team-yubune",
      "test-auto-ai-review",
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
    expect(body).toContain("Auto-review stopped");
    expect(body).toContain(STOP_REASON_LABELS.scope_violation);
    expect(body).toContain("Open in-scope findings remaining: 3");
  });

  it("postInitIncompleteComment also posts a top-level notification", async () => {
    const result = await postInitIncompleteComment(
      "team-yubune",
      "test-auto-ai-review",
      65,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(mockedUpsertStatusComment).toHaveBeenCalledTimes(1);
    expect(mockedGhApi).toHaveBeenCalledTimes(1);
    const { body } = expectPostCommentInvocation(mockedGhApi.mock.calls[0]);
    expect(body).toContain("Auto-review initialization incomplete");
  });

  it("postClaudeCodeActionFixSummary does NOT post a top-level notification (iter progress stays aggregated)", async () => {
    const result = await postClaudeCodeActionFixSummary(
      "team-yubune",
      "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
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
      "team-yubune",
      "test-auto-ai-review",
      65,
      2,
      "token",
    );

    expect(result).toBe(STATUS_COMMENT_ID);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
