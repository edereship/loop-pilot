import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { enableAutoMergeSquash } from "../src/pr-merger.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

function captureLog() {
  const calls: { level: "info" | "warning"; message: string }[] = [];
  return {
    log: {
      info: (message: string) => calls.push({ level: "info", message }),
      warning: (message: string) => calls.push({ level: "warning", message }),
    },
    calls,
  };
}

describe("enableAutoMergeSquash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes `gh pr merge --auto --squash` with the expected args and logs info on success", async () => {
    mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
      callback?.(null, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const { log, calls } = captureLog();

    await enableAutoMergeSquash("team-yubune", "test-auto-ai-review", 42, "tok-xxx", log);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const [file, args] = mockedExecFile.mock.calls[0];
    expect(file).toBe("gh");
    expect(args).toEqual([
      "pr",
      "merge",
      "42",
      "--auto",
      "--squash",
      "--repo",
      "team-yubune/test-auto-ai-review",
    ]);
    expect(calls).toEqual([
      { level: "info", message: "[pr-merger] Auto-merge (squash) enabled for PR #42." },
    ]);
  });

  it("logs a non-fatal warning when gh exits with an error (e.g. PR already merged)", async () => {
    mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
      const error = new Error("Pull request is already merged") as NodeJS.ErrnoException;
      callback?.(error, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const { log, calls } = captureLog();

    await expect(
      enableAutoMergeSquash("team-yubune", "test-auto-ai-review", 42, "tok-xxx", log),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        level: "warning",
        message:
          "[pr-merger] Failed to enable auto-merge for PR #42 (non-fatal): Pull request is already merged",
      },
    ]);
  });

  it("does not throw on non-Error rejections", async () => {
    mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
      // gh might surface plain strings through child_process errors in edge cases.
      callback?.("boom" as unknown as NodeJS.ErrnoException, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const { log, calls } = captureLog();

    await expect(
      enableAutoMergeSquash("team-yubune", "test-auto-ai-review", 42, "tok-xxx", log),
    ).resolves.toBeUndefined();
    expect(calls[0]?.level).toBe("warning");
    expect(calls[0]?.message).toContain("boom");
  });
});
