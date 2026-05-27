import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const warning = vi.fn();
const setSecret = vi.fn();
const execFileSync = vi.fn();

vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
  setSecret: (secret: string) => setSecret(secret),
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
      { encoding: "utf-8", maxBuffer: git.GIT_MAX_BUFFER },
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
    setSecret.mockReset();
  });

  it("TY-287 ENOBUFS guard: GIT_MAX_BUFFER is at least 10 MB so gitDiffHead can handle bundled-artifact diffs without ENOBUFS", () => {
    // The default Node.js execFileSync maxBuffer is 1 MB. The auto-fix
    // workflow ran post-fix's secret-scanner over a diff that included
    // dist/*.cjs / dist/*.cjs.map bundles, crashed with `spawnSync git
    // ENOBUFS`, and demoted state to `workflow_crashed`. Mirroring
    // src/gh.ts's GH_MAX_BUFFER (10 MB) prevents the regression — any
    // larger output indicates a real pathology worth surfacing.
    expect(git.GIT_MAX_BUFFER).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it("gitDiffNumstat invokes the expected git args (TY-285 #1: -c core.quotepath=false)", () => {
    execFileSync.mockReturnValue("1\t2\tfoo\n");
    expect(git.gitDiffNumstat()).toBe("1\t2\tfoo\n");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--numstat",
        "--no-renames",
        "HEAD",
      ],
      { encoding: "utf-8", maxBuffer: git.GIT_MAX_BUFFER },
    );
  });

  it("gitDiffHead forces internal diff + no-textconv + low-similarity rename detection (Codex P1 r3256517004 / r3256517012, TY-287 #2)", () => {
    // The secret scanner reads from gitDiffHead. If --no-ext-diff is
    // missing, a repo with `diff.external` / GIT_EXTERNAL_DIFF configured
    // would invoke an external helper that doesn't emit unified diff
    // format → scanner sees no `+` hunks → silent bypass. Likewise,
    // --no-textconv keeps `.gitattributes` textconv drivers from rewriting
    // content before the scanner sees it. TY-287 #2: --find-renames=20%
    // lowers git's default 50% rename-detection threshold so a rename plus
    // substantial rewriting is still emitted as a rename header instead of
    // a delete + add pair (which would let pre-existing secret-shaped
    // fixture content reappear in the additions and hard-fail the scanner).
    execFileSync.mockReturnValue("");
    git.gitDiffHead();
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=20%",
        "HEAD",
      ],
      { encoding: "utf-8", maxBuffer: git.GIT_MAX_BUFFER },
    );
  });

  it("gitListUntracked invokes the expected git args (TY-285 #1: -c core.quotepath=false)", () => {
    execFileSync.mockReturnValue("foo.txt\n");
    expect(git.gitListUntracked()).toBe("foo.txt\n");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
      ],
      { encoding: "utf-8", maxBuffer: git.GIT_MAX_BUFFER },
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

  it("TY-287 #2 follow-up: intentToAdd is a no-op for empty paths", () => {
    git.intentToAdd([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("TY-287 #2 follow-up: intentToAdd runs `git add --intent-to-add -- <paths>`", () => {
    git.intentToAdd(["src/new.ts", "data/a => b.json"]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["add", "--intent-to-add", "--", "src/new.ts", "data/a => b.json"],
      { stdio: "inherit" },
    );
  });

  it("TY-287 #2 follow-up: resetIntentToAdd is a no-op for empty paths", () => {
    git.resetIntentToAdd([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("TY-287 #2 follow-up: resetIntentToAdd runs `git reset HEAD -- <paths>` to drop intent-to-add markers", () => {
    git.resetIntentToAdd(["src/new.ts"]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["reset", "HEAD", "--", "src/new.ts"],
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

  it("pushWithToken: full happy path — unset extraheader, check global, list+clear local rewrite rules, push to pinned URL", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      // 1: unset checkout extraheader (returns undefined = ok)
      // 2: global --get-regexp (no matches → exit 1)
      if (call === 2) {
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      // 3: local --get-regexp (returns matched keys for cleanup)
      if (call === 3) {
        return [
          "url.https://corp/.insteadOf https://github.com/team-yubune/",
          "url.https://corp2/.insteadOf https://github.com/",
        ].join("\n") + "\n";
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    git.pushWithToken("team-yubune", "loop-pilot", "claude/some-branch", "push-token");

    // 1: unset checkout extraheader
    // 2: global get-regexp (exit 1, no global rewrite rules)
    // 3: local list rewrite rules (returns 2 keys)
    // 4, 5: unset each local rewrite key
    // 6: push
    expect(execFileSync).toHaveBeenCalledTimes(6);

    expect(execFileSync.mock.calls[0][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.https://github.com/.extraheader",
    ]);

    expect(execFileSync.mock.calls[1][1]).toEqual([
      "config",
      "--global",
      "--get-regexp",
      "^url\\..*\\.(insteadOf|pushInsteadOf)$",
    ]);

    expect(execFileSync.mock.calls[2][1]).toEqual([
      "config",
      "--local",
      "--get-regexp",
      "^url\\..*\\.(insteadOf|pushInsteadOf)$",
    ]);

    expect(execFileSync.mock.calls[3][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "url.https://corp/.insteadOf",
    ]);
    expect(execFileSync.mock.calls[4][1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "url.https://corp2/.insteadOf",
    ]);

    const basic = Buffer.from("x-access-token:push-token").toString("base64");
    expect(execFileSync.mock.calls[5][1]).toEqual([
      "-c",
      `http.extraheader=AUTHORIZATION: Basic ${basic}`,
      "push",
      "https://github.com/team-yubune/loop-pilot.git",
      "HEAD:refs/heads/claude/some-branch",
    ]);

    // TY-272 #B: the base64-encoded Basic credential must be registered as a
    // GitHub Actions secret before the push so any echo of argv in failure
    // logs is masked.
    expect(setSecret).toHaveBeenCalledWith(basic);
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
      if (call === 2 || call === 3) {
        // global + local get-regexp: no matches.
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok"),
    ).not.toThrow();

    // 1: failing extraheader unset (status 5), 2: failing global get-regexp,
    // 3: failing local get-regexp, 4: push.
    expect(execFileSync).toHaveBeenCalledTimes(4);
    expect(execFileSync.mock.calls[3][1]).toContain("push");
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
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok"),
    ).toThrow(/permission denied/);

    // The push must NOT have been attempted: silently swallowing a corrupt
    // config would re-introduce the duplicate-Authorization-header bug.
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("pushWithToken: skips rewrite cleanup when get-regexp exits 1 (no rules)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2 || call === 3) {
        // global + local get-regexp: no matches.
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    git.pushWithToken("team-yubune", "loop-pilot", "main", "tok");

    // 1: unset extraheader, 2: global get-regexp, 3: local get-regexp, 4: push.
    expect(execFileSync).toHaveBeenCalledTimes(4);
    expect(execFileSync.mock.calls[3][1]).toContain("push");
  });

  it("pushWithToken: rethrows non-exit-1 failures from local get-regexp (corrupt config)", () => {
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
        // global get-regexp: no matches.
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      if (call === 3) {
        const e = new Error("config is corrupt") as Error & { status?: number };
        e.status = 128;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok"),
    ).toThrow(/corrupt/);

    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it("pushWithToken: refuses to push when a global git config rewrite rule can redirect the GitHub destination (TY-272 #D)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        // global get-regexp: one malicious rule whose value is a prefix of
        // the destination URL.
        return "url.https://evil.example.com/.insteadOf https://github.com/\n";
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok"),
    ).toThrow(/global git config carries .* url rewrite rule/);

    // 1: unset extraheader, 2: global get-regexp (returned rules → throw).
    // Push must NOT have been attempted.
    expect(execFileSync).toHaveBeenCalledTimes(2);
    for (const c of execFileSync.mock.calls) {
      expect(c[1] as string[]).not.toContain("push");
    }
  });

  it("pushWithToken: ignores global rewrite rules that cannot redirect GitHub destinations (Codex P2 on PR #85)", () => {
    // self-hosted runners commonly carry org-wide GitLab rewrites; pushes
    // to github.com must not be blocked by them.
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        return "url.https://gitlab.internal/.insteadOf https://gitlab.com/\n";
      }
      if (call === 3) {
        // local get-regexp: no matches.
        const e = new Error("no matches") as Error & { status?: number };
        e.status = 1;
        throw e;
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    expect(() =>
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok"),
    ).not.toThrow();

    // 1: unset extraheader, 2: global get-regexp (rule ignored), 3: local
    // get-regexp (no matches), 4: push.
    expect(execFileSync).toHaveBeenCalledTimes(4);
    expect(execFileSync.mock.calls[3][1]).toContain("push");
  });

  it("pushWithToken: error message omits both key and value to avoid leaking credentials (Codex P1 on PR #85)", () => {
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2) {
        // Both key (rewrite base) and value can carry credentials. Echo a
        // worst-case entry to confirm neither side leaks.
        return [
          "url.https://x-access-token:ghp_keyleak@evil/.insteadOf https://github.com/",
          "url.https://attacker/.insteadOf https://x-access-token:ghp_valueleak@github.com/",
        ].join("\n") + "\n";
      }
      return undefined;
    }) as unknown as typeof execFileSync);

    try {
      git.pushWithToken("team-yubune", "loop-pilot", "main", "tok");
      throw new Error("expected pushWithToken to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Neither credential surface (key-embedded or value-embedded) may
      // appear in the surfaced error.
      expect(message).not.toMatch(/ghp_keyleak/);
      expect(message).not.toMatch(/ghp_valueleak/);
      // The error must still be actionable: it states the count and tells
      // the operator how to enumerate the offending rules locally.
      expect(message).toMatch(/Refusing to push/);
      expect(message).toMatch(/git config --global --get-regexp/);
    }
  });

  it("rewriteValueCanRedirect: matches values that are a prefix of the destination", () => {
    const dest = "https://github.com/team-yubune/loop-pilot.git";
    expect(git.rewriteValueCanRedirect("https://", dest)).toBe(true);
    expect(git.rewriteValueCanRedirect("https://github.com/", dest)).toBe(true);
    expect(
      git.rewriteValueCanRedirect("https://github.com/team-yubune/", dest),
    ).toBe(true);
    // An empty insteadOf value is a prefix of every URL — git applies it to
    // all pushes, so it must be treated as redirecting (not safe).
    expect(git.rewriteValueCanRedirect("", dest)).toBe(true);
  });

  it("rewriteValueCanRedirect: ignores unrelated rewrite values", () => {
    const dest = "https://github.com/team-yubune/loop-pilot.git";
    expect(git.rewriteValueCanRedirect("https://gitlab.com/", dest)).toBe(false);
    expect(git.rewriteValueCanRedirect("git@github.com:", dest)).toBe(false);
    expect(
      git.rewriteValueCanRedirect("https://github.com/other-org/", dest),
    ).toBe(false);
    // Values longer than the destination cannot match — git only applies rules
    // whose value is a prefix of the URL.
    expect(
      git.rewriteValueCanRedirect(
        "https://github.com/team-yubune/loop-pilot.git/extra",
        dest,
      ),
    ).toBe(false);
  });

  it("pushWithToken: uses owner/repo/ref from Config (not remote.origin) for the destination URL", () => {
    // Security: a tampered `remote.origin.url` (claude-code-action runs before
    // post-fix and could in principle mutate `.git/config`) must NOT be able to
    // redirect the PAT to an attacker URL.
    let call = 0;
    execFileSync.mockImplementation(((..._args: unknown[]) => {
      call += 1;
      if (call === 2 || call === 3) {
        // global + local get-regexp: no matches.
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
