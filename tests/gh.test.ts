import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const { ghApi, GH_MAX_BUFFER } = await import("../src/gh.js");

function mockOnce(opts: {
  stdout?: string;
  error?: { message?: string; stderr?: string; stdout?: string };
}): void {
  mockedExecFile.mockImplementationOnce(((
    _file: string,
    _args: string[],
    options: { env?: NodeJS.ProcessEnv; maxBuffer?: number },
    callback: (
      err: Error | (Error & { stderr?: string; stdout?: string }) | null,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    if (opts.error) {
      const err = new Error(opts.error.message ?? "exec failed") as Error & {
        stderr?: string;
        stdout?: string;
      };
      if (opts.error.stderr !== undefined) err.stderr = opts.error.stderr;
      if (opts.error.stdout !== undefined) err.stdout = opts.error.stdout;
      callback(err);
    } else {
      callback(null, { stdout: opts.stdout ?? "", stderr: "" });
    }
    // record options for assertion
    (mockedExecFile as unknown as { lastOptions?: typeof options }).lastOptions =
      options;
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

describe("GH_MAX_BUFFER", () => {
  it("is 10 MB", () => {
    expect(GH_MAX_BUFFER).toBe(10 * 1024 * 1024);
  });
});

describe("ghApi", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("invokes gh with the given args and returns stdout", async () => {
    mockOnce({ stdout: "hello\n" });
    const result = await ghApi(["api", "/foo"], "token-xyz");
    expect(result).toBe("hello\n");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      ["api", "/foo"],
      expect.objectContaining({ maxBuffer: GH_MAX_BUFFER }),
      expect.any(Function),
    );
  });

  it("forwards the token through buildGhEnv into the spawn env", async () => {
    mockOnce({ stdout: "" });
    await ghApi(["api", "/foo"], "secret-token");
    const optsArg = mockedExecFile.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(optsArg.env.GH_TOKEN).toBe("secret-token");
  });

  it("uses the caller-supplied maxBuffer when provided", async () => {
    mockOnce({ stdout: "" });
    await ghApi(["api", "/foo"], "token", { maxBuffer: 42 });
    const optsArg = mockedExecFile.mock.calls[0][2] as { maxBuffer: number };
    expect(optsArg.maxBuffer).toBe(42);
  });

  it("throws an Error combining message / stderr / stdout on failure", async () => {
    mockOnce({
      error: {
        message: "gh api failed",
        stderr: "HTTP 500\n",
        stdout: '{"message":"server error"}\n',
      },
    });
    await expect(ghApi(["api", "/x"], "token")).rejects.toThrow(
      /gh api failed[\s\S]*stderr: HTTP 500[\s\S]*stdout: \{"message":"server error"\}/,
    );
  });

  it("omits stderr/stdout sections when they are empty strings", async () => {
    mockOnce({ error: { message: "boom", stderr: "", stdout: "" } });
    let caught: Error | null = null;
    try {
      await ghApi(["api", "/x"], "token");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("boom");
  });

  it("preserves 412 / Precondition Failed text from stderr so callers can detect optimistic-lock conflicts", async () => {
    mockOnce({
      error: {
        message: "gh: failed",
        stderr: "HTTP 412: Precondition Failed",
        stdout: "",
      },
    });
    let caught: Error | null = null;
    try {
      await ghApi(["api", "/x"], "token");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain("412");
    expect(caught?.message).toContain("Precondition Failed");
  });
});
