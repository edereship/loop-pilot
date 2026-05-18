import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec } from "node:child_process";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

const mockedExec = vi.mocked(exec);

const { runCheckCommand, sanitizeOutput } = await import("../src/check-runner.js");

interface ExecResult {
  stdout: string;
  stderr: string;
}

function mockExecOnce(result: ExecResult | { error: unknown }): void {
  mockedExec.mockImplementationOnce(((
    _cmd: string,
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as
      | ((
          err: unknown,
          stdout: string | { stdout: string; stderr: string },
          stderr?: string,
        ) => void)
      | undefined;
    if (callback) {
      if ("error" in result) {
        callback(result.error, "", "");
      } else {
        // promisify(exec) resolves with `{ stdout, stderr }` by setting them
        // on the result object passed to the callback.
        callback(null, { stdout: result.stdout, stderr: result.stderr });
      }
    }
    return {} as ReturnType<typeof exec>;
  }) as unknown as typeof exec);
}

describe("sanitizeOutput", () => {
  it("removes ANSI escape sequences", () => {
    const input = "\x1b[31mError\x1b[0m: something failed";
    expect(sanitizeOutput(input)).toBe("Error: something failed");
  });

  it("removes multiple ANSI sequences", () => {
    const input = "\x1b[1m\x1b[33mWarning:\x1b[0m check \x1b[32mpassed\x1b[0m";
    expect(sanitizeOutput(input)).toBe("Warning: check passed");
  });

  it("returns input unchanged when no ANSI sequences present", () => {
    const input = "clean output line";
    expect(sanitizeOutput(input)).toBe("clean output line");
  });

  it("truncates output exceeding 60000 chars", () => {
    const longOutput = "x".repeat(70000);
    const result = sanitizeOutput(longOutput);
    expect(result.length).toBeLessThanOrEqual(60000);
  });

  it("preserves head and tail lines when truncating", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${"x".repeat(400)}`);
    const longOutput = lines.join("\n");
    const result = sanitizeOutput(longOutput);
    expect(result).toContain("line 1:");
    expect(result).toContain("... (truncated) ...");
    expect(result).toContain("line 200:");
  });

  it("returns short output unchanged", () => {
    const input = "short output";
    expect(sanitizeOutput(input)).toBe("short output");
  });

  it("strips CSI sequences with private-parameter markers (TY-275 #7)", () => {
    // `\x1b[?1049h` enables the alternate screen buffer. The previous regex
    // `[0-9;]*` excluded `?`, so the sequence was left in output verbatim.
    const input = "\x1b[?1049hclear screen\x1b[?1049l";
    expect(sanitizeOutput(input)).toBe("clear screen");
  });

  it("strips OSC (operating system command) sequences (TY-275 #7)", () => {
    // OSC 8 is hyperlink: `\x1b]8;;<url>\x07<text>\x1b]8;;\x07`. Both BEL
    // and `\x1b\\` (ST) terminators are valid.
    const bel = "\x1b]8;;https://example.com\x07linked\x1b]8;;\x07 end";
    expect(sanitizeOutput(bel)).toBe("linked end");
    const st = "\x1b]0;title\x1b\\after-title";
    expect(sanitizeOutput(st)).toBe("after-title");
  });

  it("strips charset-designation 2-byte sequences (TY-275 #7)", () => {
    // `\x1b(B` selects ASCII (G0). Emitted by some shells before / after
    // mode switches.
    const input = "\x1b(Bplain text\x1b)0";
    expect(sanitizeOutput(input)).toBe("plain text");
  });
});

describe("runCheckCommand", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns success and combined stdout+stderr on a passing command", async () => {
    mockExecOnce({ stdout: "ok\n", stderr: "warn\n" });

    const result = await runCheckCommand("npm test");

    expect(result.success).toBe(true);
    expect(result.output).toBe("ok\n\nwarn\n");
  });

  it("strips secret env vars and all INPUT_* prefix before invoking the child process", async () => {
    process.env.ANTHROPIC_API_KEY = "anth-secret";
    process.env.GITHUB_TOKEN = "gh-secret";
    process.env.GH_TOKEN = "gh2-secret";
    process.env.INPUT_ANTHROPIC_API_KEY = "input-anth";
    process.env.INPUT_GITHUB_TOKEN = "input-gh";
    process.env.INPUT_OTHER = "input-other";
    process.env.PATH = "/usr/bin:/bin";
    mockExecOnce({ stdout: "", stderr: "" });

    await runCheckCommand("npm test");

    const call = mockedExec.mock.calls[0];
    expect(call?.[0]).toBe("npm test");
    const options = call?.[1] as { env: NodeJS.ProcessEnv } | undefined;
    expect(options?.env).toBeDefined();
    const env = options!.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    // TY-264 hardened the strip to remove every INPUT_* env (defense-in-depth
    // for future action inputs), not just the known token prefixes.
    expect(env.INPUT_ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_OTHER).toBeUndefined();
    // Non-INPUT / non-secret vars (PATH, HOME, etc.) are preserved so the
    // child process can still run.
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("returns a failure result with stdout / stderr / message when the check command fails (TY-276 #2: working-tree rollback is post-fix's resetWorkingTree, not check-runner's)", async () => {
    const error = Object.assign(new Error("exit code 1"), {
      stdout: "failing test output",
      stderr: "stderr details",
    });
    mockExecOnce({ error });

    const result = await runCheckCommand("npm test");

    expect(result.success).toBe(false);
    expect(result.output).toContain("failing test output");
    expect(result.output).toContain("stderr details");
    expect(result.output).toContain("exit code 1");
  });

  it("surfaces timeout error output as a non-success result", async () => {
    const timeoutError = Object.assign(new Error("ETIMEDOUT"), {
      stdout: "partial output",
      stderr: "",
      killed: true,
      signal: "SIGTERM",
    });
    mockExecOnce({ error: timeoutError });

    const result = await runCheckCommand("npm test");

    expect(result.success).toBe(false);
    expect(result.output).toContain("partial output");
    expect(result.output).toContain("ETIMEDOUT");
  });

  it("passes a 5 minute timeout to the child process", async () => {
    mockExecOnce({ stdout: "", stderr: "" });

    await runCheckCommand("npm test");

    const options = mockedExec.mock.calls[0]?.[1] as { timeout: number };
    expect(options.timeout).toBe(5 * 60 * 1000);
  });
});
