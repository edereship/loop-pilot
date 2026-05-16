import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { runInit, type InitDeps } from "../src/main-init.js";
import { createInitialState } from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 90,
  checkCommand: "npm run check",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 10,
  stabilizeCount: 3,
  codexReviewMarker: "Codex Review",
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "github-token",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "team-yubune",
  repoName: "test-auto-ai-review",
  prNumber: 227,
  triggerCommentId: 0,
  triggerCommentBody: "",
  triggerUserLogin: "",
  prHeadRef: "linear/TY-227",
  prTitle: "TY-227",
  autoReviewLabel: "",
  autoReviewFullAuto: false,
  autoReviewRestartRoles: "author,write,maintain,admin",
  claudeCodeModelBase: "claude-sonnet-4-6",
  claudeCodeModelEscalated: "claude-opus-4-7",
  autoMergeOnClean: false,
  severityThreshold: "P2",
  hardBlockOverride: [],
};

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ...createInitialState(), ...overrides };
}

function makeDeps(readResult: ReadStateResult) {
  return {
    readState: vi.fn().mockResolvedValue(readResult),
    createStateComment: vi.fn().mockResolvedValue(12345),
    updateStateComment: vi.fn().mockResolvedValue(undefined),
    postCodexReviewRequest: vi.fn().mockResolvedValue(67890),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
  } satisfies InitDeps;
}

describe("runInit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["waiting_codex", "fixing", "done", "stopped"] as const)(
    "does not reset state or post a new review request when existing state is %s",
    async (status) => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 111,
        state: makeState({ status, lastCodexRequestCommentId: 222 }),
      });

      await runInit(baseConfig, deps);

      expect(deps.updateStateComment).not.toHaveBeenCalled();
      expect(deps.createStateComment).not.toHaveBeenCalled();
      expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
      expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
    },
  );

  it("continues initialization when existing state is initialized", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      state: makeState({ status: "initialized", lastCodexRequestCommentId: null }),
    });

    await runInit(baseConfig, deps);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.updateStateComment).toHaveBeenLastCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: 67890,
      }),
      "github-token",
    );
  });

  it("keeps corrupted state recovery by overwriting and posting a review request", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: true,
      commentId: 111,
    });

    await runInit(baseConfig, deps);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "team-yubune",
      "test-auto-ai-review",
      111,
      expect.objectContaining({ status: "initialized" }),
      "github-token",
    );
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
  });
});
