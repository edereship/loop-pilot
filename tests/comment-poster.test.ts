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

const mockedGhApi = vi.mocked(ghApi);
const mockedUpsertStatusComment = vi.mocked(upsertStatusComment);

const STATUS_COMMENT_ID = 999_001;
const POSTED_COMMENT_ID = 999_002;

function expectPostCommentInvocation(call: unknown[]): {
  args: readonly string[];
  body: string;
} {
  const args = call[0] as readonly string[];
  // postComment posts via `api repos/{owner}/{name}/issues/{pr}/comments -X POST -f body=<body> --jq .id`
  const bodyArgIndex = args.indexOf("-f");
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
    expect(body).toContain(
      "Claude Code Action exhausted the configured --max-turns budget",
    );
    expect(body).toContain("Open in-scope findings remaining: 2");
    expect(body).toContain("Manual intervention required");
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
    expect(body).toContain(
      "repair touched paths or exceeded the size budget allowed for auto-fix",
    );
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
