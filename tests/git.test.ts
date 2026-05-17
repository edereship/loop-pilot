import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const warning = vi.fn();
const execFileSync = vi.fn();

vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

const git = await import("../src/git.js");

describe("readWorkingTreeFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "git-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns file contents as UTF-8 string", () => {
    const file = join(tmp, "hello.txt");
    writeFileSync(file, "hello\n");
    expect(git.readWorkingTreeFile(file)).toBe("hello\n");
  });

  it("returns null for files containing a NUL byte (binary)", () => {
    const file = join(tmp, "bin.dat");
    writeFileSync(file, Buffer.from([0x68, 0x00, 0x69]));
    expect(git.readWorkingTreeFile(file)).toBeNull();
  });

  it("returns null when the file does not exist", () => {
    expect(git.readWorkingTreeFile(join(tmp, "missing.txt"))).toBeNull();
  });
});

describe("readHeadSha", () => {
  beforeEach(() => {
    warning.mockReset();
    execFileSync.mockReset();
  });

  it("returns the trimmed stdout from `git rev-parse HEAD`", () => {
    execFileSync.mockReturnValue("abc123\n");
    expect(git.readHeadSha("pre-fix")).toBe("abc123");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf-8" },
    );
    expect(warning).not.toHaveBeenCalled();
  });

  it("logs a labeled warning and returns '' on failure", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(git.readHeadSha("post-fix")).toBe("");
    expect(warning).toHaveBeenCalledWith(
      "[post-fix] Could not read HEAD sha: not a git repo",
    );
  });

  it("stringifies non-Error throws in the warning", () => {
    execFileSync.mockImplementation(() => {
      throw "raw-string";
    });
    expect(git.readHeadSha("pre-fix")).toBe("");
    expect(warning).toHaveBeenCalledWith(
      "[pre-fix] Could not read HEAD sha: raw-string",
    );
  });
});

describe("subprocess wrappers", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("gitDiffNumstat invokes the expected git args", () => {
    execFileSync.mockReturnValue("1\t2\tfoo\n");
    expect(git.gitDiffNumstat()).toBe("1\t2\tfoo\n");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--numstat", "--no-renames", "HEAD"],
      { encoding: "utf-8" },
    );
  });

  it("gitListUntracked invokes the expected git args", () => {
    execFileSync.mockReturnValue("foo.txt\n");
    expect(git.gitListUntracked()).toBe("foo.txt\n");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { encoding: "utf-8" },
    );
  });

  it("checkoutBranch forwards the ref", () => {
    git.checkoutBranch("feature/x");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "feature/x"],
      { stdio: "inherit" },
    );
  });

  it("resetWorkingTree runs reset --hard and clean -ffd in order", () => {
    git.resetWorkingTree();
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["reset", "--hard", "HEAD"],
      { stdio: "inherit" },
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["clean", "-ffd"],
      { stdio: "inherit" },
    );
  });

  it("stagePaths is a no-op for empty paths", () => {
    git.stagePaths([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stagePaths runs `git add -- <paths>` when paths are present", () => {
    git.stagePaths(["a.ts", "b.ts"]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["add", "--", "a.ts", "b.ts"],
      { stdio: "inherit" },
    );
  });

  it("hasStagedChanges returns false when `git diff --cached --quiet` succeeds", () => {
    execFileSync.mockReturnValue(undefined);
    expect(git.hasStagedChanges()).toBe(false);
  });

  it("hasStagedChanges returns true when the command throws (non-zero exit)", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("exit 1");
    });
    expect(git.hasStagedChanges()).toBe(true);
  });

  it("commit forwards the message via -m", () => {
    git.commit("chore: foo");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "chore: foo"],
      { stdio: "inherit" },
    );
  });

  it("push calls `git push`", () => {
    git.push();
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["push"],
      { stdio: "inherit" },
    );
  });

  it("pushWithToken falls back to plain push for an empty token", () => {
    git.pushWithToken("owner", "repo", "feature/x", "");
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["push"],
      { stdio: "inherit" },
    );
  });

  it("pushWithToken: full happy path — unset extraheader, list+clear rewrite rules, push to pinned URL", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        // `git config --get-regexp` returns matched keys with their values.
        return [
          "url.https://evil/.insteadOf https://github.com/",
          "url.https://github.com/.insteadOf https://corp/",
        ].join("\n") + "\n";
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    git.pushWithToken("team-yubune", "test-auto-ai-review", "claude/some-branch", "push-token");

    // 1: unset checkout extraheader
    // 2: list rewrite rules (returns 2 keys)
    // 3, 4: unset each rewrite key
    // 5: push
    expect(execFileSync).toHaveBeenCalledTimes(5);

    expect(execFileSync.mock.calls[0][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.https://github.com/.extraheader",
    ]);

    expect(execFileSync.mock.calls[1][1]).toEqual([
      "config",
      "--local",
      "--get-regexp",
      "^url\\..*\\.(insteadOf|pushInsteadOf)$",
    ]);

    expect(execFileSync.mock.calls[2][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "url.https://evil/.insteadOf",
    ]);
    expect(execFileSync.mock.calls[3][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "url.https://github.com/.insteadOf",
    ]);

    const basic = Buffer.from("x-access-token:push-token").toString("base64");
    expect(execFileSync.mock.calls[4][1]).toEqual([
      "-c",
      `http.extraheader=AUTHORIZATION: Basic ${basic}`,
      "push",
      "https://github.com/team-yubune/test-auto-ai-review.git",
      "HEAD:refs/heads/claude/some-branch",
    ]);
  });

  it("pushWithToken: swallows exit 5 from extraheader unset (key not present)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 1) {
        const e = new Error("not set") as Error & { status?: number };
        e.status = 5;
        throw e;
      }
      if (call === 2) {
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "test-auto-ai-review", "main", "tok"),
    ).not.toThrow();

    // 1: failing extraheader unset (status 5), 2: failing get-regexp (status 1), 3: push.
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(execFileSync.mock.calls[2][1]).toContain("push");
  });

  it("pushWithToken: rethrows non-exit-5 failures from extraheader unset (Codex P2)", () => {
    execFileSync.mockImplementationOnce(() => {
      const e = new Error("permission denied reading .git/config") as Error & {
        status?: number;
      };
      e.status = 128;
      throw e;
    });

    expect(() =>
      git.pushWithToken("team-yubune", "test-auto-ai-review", "main", "tok"),
    ).toThrow(/permission denied/);

    // The push must NOT have been attempted: silently swallowing a corrupt
    // config would re-introduce the duplicate-Authorization-header bug.
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("pushWithToken: skips rewrite cleanup when get-regexp exits 1 (no rules)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    git.pushWithToken("team-yubune", "test-auto-ai-review", "main", "tok");

    // 1: unset extraheader, 2: failing get-regexp, 3: push (no unset calls).
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(execFileSync.mock.calls[2][1]).toContain("push");
  });

  it("pushWithToken: rethrows non-exit-1 failures from get-regexp (corrupt config)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 1) {
        // extraheader unset: exit 5, swallowed.
        const e = new Error("not set") as Error & { status?: number };
        e.status = 5;
        throw e;
      }
      if (call === 2) {
        const e = new Error("config is corrupt") as Error & { status?: number };
        e.status = 128;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "test-auto-ai-review", "main", "tok"),
    ).toThrow(/corrupt/);

    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it("pushWithToken: uses owner/repo/ref from Config (not remote.origin) for the destination URL", () => {
    // Security: a tampered `remote.origin.url` (claude-code-action runs before
    // post-fix and could in principle mutate `.git/config`) must NOT be able to
    // redirect the PAT to an attacker URL.
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        // No rewrite rules.
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    git.pushWithToken("safe-org", "safe-repo", "main", "tok");

    const pushCall = execFileSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("push"),
    );
    expect(pushCall).toBeDefined();
    const args = pushCall![1] as string[];
    expect(args).toContain("https://github.com/safe-org/safe-repo.git");
    expect(args).toContain("HEAD:refs/heads/main");
    // No reliance on the `origin` remote.
    expect(args).not.toContain("origin");
  });
});
