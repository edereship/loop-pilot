import { beforeEach, describe, expect, it, vi } from "vitest";

const warning = vi.fn();
const error = vi.fn();

vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
  error: (msg: string) => error(msg),
}));

const { demoteFixingOnCrash } = await import("../src/crash-recovery.js");
const { createInitialState } = await import("../src/state-manager.js");
import type { CrashRecoveryDeps } from "../src/crash-recovery.js";
import type { Config } from "../src/config.js";
import type { ReviewState } from "../src/types.js";

const crashConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 90,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "codex",
  stabilizeIntervalSeconds: 10,
  stabilizeCount: 3,
  codexReviewMarker: "Codex Review",
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "team-yubune",
  repoName: "test-auto-ai-review",
  prNumber: 999,
  triggerCommentId: 0,
  triggerCommentBody: "",
  triggerUserLogin: "",
  prHeadRef: "linear/TY-252",
  prTitle: "TY-252",
  autoReviewLabel: "",
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

function makeFixingState(): ReviewState {
  return { ...createInitialState(), status: "fixing" };
}

function makeDeps(overrides: Partial<CrashRecoveryDeps> = {}): CrashRecoveryDeps {
  return {
    loadInitConfig: vi.fn().mockReturnValue(crashConfig),
    readState: vi.fn().mockResolvedValue({
      found: true,
      corrupted: false,
      state: makeFixingState(),
      commentId: 12345,
      commentUpdatedAt: "2026-05-15T00:00:00.000Z",
    }),
    updateStateComment: vi
      .fn()
      .mockResolvedValue({ updatedAt: "2026-05-15T00:00:01.000Z" }),
    ...overrides,
  };
}

describe("demoteFixingOnCrash", () => {
  beforeEach(() => {
    warning.mockReset();
    error.mockReset();
  });

  it("demotes fixing state to stopped + state_corrupted and uses label in warning", async () => {
    const deps = makeDeps();
    await demoteFixingOnCrash("pre-fix", deps);

    expect(deps.updateStateComment).toHaveBeenCalledTimes(1);
    const [owner, name, commentId, state, token, options] = (
      deps.updateStateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(owner).toBe("team-yubune");
    expect(name).toBe("test-auto-ai-review");
    expect(commentId).toBe(12345);
    expect(token).toBe("github-token");
    expect(options).toEqual({ expectedUpdatedAt: "2026-05-15T00:00:00.000Z" });
    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("state_corrupted");

    expect(warning).toHaveBeenCalledWith(
      "[pre-fix] Crash recovery: resetting fixing → stopped (state_corrupted)",
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("includes the post-fix label in the warning when invoked from post-fix", async () => {
    const deps = makeDeps();
    await demoteFixingOnCrash("post-fix", deps);
    expect(warning).toHaveBeenCalledWith(
      "[post-fix] Crash recovery: resetting fixing → stopped (state_corrupted)",
    );
  });

  it("does nothing when state.status is not fixing", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: true,
        corrupted: false,
        state: { ...makeFixingState(), status: "waiting_codex" },
        commentId: 12345,
        commentUpdatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });
    await demoteFixingOnCrash("pre-fix", deps);
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing when state is not found", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: false,
        corrupted: false,
        commentId: null,
      }),
    });
    await demoteFixingOnCrash("pre-fix", deps);
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs core.error and swallows when recovery throws", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockRejectedValue(new Error("read failed")),
    });
    await expect(demoteFixingOnCrash("pre-fix", deps)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[pre-fix] Crash recovery failed: read failed",
    );
  });

  it("logs core.error with stringified non-Error rejection", async () => {
    const deps = makeDeps({
      updateStateComment: vi.fn().mockRejectedValue("conflict"),
    });
    await demoteFixingOnCrash("post-fix", deps);
    expect(error).toHaveBeenCalledWith(
      "[post-fix] Crash recovery failed: conflict",
    );
  });
});
