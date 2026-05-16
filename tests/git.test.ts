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
});
