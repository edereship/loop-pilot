import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCK_PATTERNS,
  DEFAULT_SCOPE_POLICY,
  buildScopePolicy,
  checkScope,
  checkScopeBuildMode,
  parseBlockPathsSpec,
  parseGitNumstat,
  type BlockPattern,
  type ChangedFile,
  type ScopeCheckPolicy,
} from "../src/scope-checker.js";

function file(path: string, added = 1, deleted = 0): ChangedFile {
  return { path, added, deleted };
}

describe("checkScope (default policy)", () => {
  it("accepts a small diff within src/", () => {
    const result = checkScope([
      file("src/main-loop.ts", 5, 2),
      file("tests/main-loop.test.ts", 10, 0),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changedFiles).toBe(2);
      expect(result.totalLines).toBe(17);
    }
  });

  it("accepts paths outside src/ / tests/ / docs/ (no allow-list)", () => {
    // TY-271: the allow-list is gone. Paths that used to be `disallowed_path`
    // are now accepted unless they hit a block pattern.
    expect(checkScope([file("lib/utils.ts", 1, 0)]).ok).toBe(true);
    expect(checkScope([file("README.md", 2, 0)]).ok).toBe(true);
    expect(checkScope([file("loop/action.yml", 4, 0)]).ok).toBe(true);
    expect(checkScope([file("scripts/release.sh", 3, 0)]).ok).toBe(true);
  });

  it("rejects a change to .github/workflows", () => {
    const result = checkScope([
      file("src/main-loop.ts", 1, 0),
      file(".github/workflows/auto-review-loop.yml", 4, 0),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toEqual([
        ".github/workflows/auto-review-loop.yml",
      ]);
    }
  });

  it("rejects a change to package.json", () => {
    const result = checkScope([file("package.json", 1, 1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("rejects a change to package-lock.json", () => {
    const result = checkScope([file("package-lock.json", 100, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("rejects a change to tsconfig.json", () => {
    const result = checkScope([file("tsconfig.json", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("rejects a root-level dotfile change", () => {
    const result = checkScope([file(".gitignore", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("accepts a dotfile nested inside a non-blocked path", () => {
    // src/.eslintrc would be allowed; the root-dotfile rule only matches
    // single-segment paths.
    const result = checkScope([file("src/.eslintrc.json", 1, 0)]);
    expect(result.ok).toBe(true);
  });

  it("rejects a node_modules change", () => {
    const result = checkScope([file("node_modules/foo/index.js", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("rejects a dist/ change", () => {
    const result = checkScope([file("dist/main.js", 5, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
    }
  });

  it("surfaces the matched block patterns on hard_block_path", () => {
    const result = checkScope([
      file("dist/foo.js", 1, 0),
      file("package.json", 1, 0),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.matchedBlockPatterns?.map((p) => p.path)).toEqual([
        "dist/",
        "package.json",
      ]);
      // dist/ and package.json are both unlocked defaults.
      expect(result.matchedBlockPatterns?.every((p) => !p.locked)).toBe(true);
    }
  });

  it("marks .github/ matches as locked so the comment formatter can warn", () => {
    const result = checkScope([file(".github/workflows/ci.yml", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const locked = result.matchedBlockPatterns?.filter((p) => p.locked) ?? [];
      expect(locked.map((p) => p.path)).toEqual([".github/"]);
    }
  });
});

describe("checkScope (path safety)", () => {
  it("rejects absolute paths", () => {
    const result = checkScope([file("/etc/passwd", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path_traversal");
  });

  it("rejects `..` traversal", () => {
    const result = checkScope([file("../outside.ts", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path_traversal");
  });

  it("rejects mid-path traversal segments", () => {
    const result = checkScope([file("src/../etc/foo", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path_traversal");
  });

  it("rejects empty path", () => {
    const result = checkScope([file("", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path_traversal");
  });
});

describe("checkScope (size budgets)", () => {
  it("rejects more than 20 files", () => {
    const files: ChangedFile[] = Array.from({ length: 21 }, (_, i) =>
      file(`src/file-${i}.ts`, 1, 0),
    );
    const result = checkScope(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_many_files");
  });

  it("accepts exactly 20 files", () => {
    const files: ChangedFile[] = Array.from({ length: 20 }, (_, i) =>
      file(`src/file-${i}.ts`, 1, 0),
    );
    const result = checkScope(files);
    expect(result.ok).toBe(true);
  });

  it("rejects more than 1000 total changed lines", () => {
    const result = checkScope([file("src/big.ts", 600, 500)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_many_lines");
  });

  it("accepts exactly 1000 total changed lines", () => {
    const result = checkScope([file("src/big.ts", 600, 400)]);
    expect(result.ok).toBe(true);
  });
});

describe("checkScope (binary files)", () => {
  it("rejects binary changes (git numstat `-` markers)", () => {
    const result = checkScope([file("src/asset.bin", -1, -1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("binary_change");
  });
});

describe("checkScope (custom policy)", () => {
  it("honors a tighter file budget", () => {
    const tight: ScopeCheckPolicy = { ...DEFAULT_SCOPE_POLICY, maxFiles: 3 };
    const files: ChangedFile[] = Array.from({ length: 4 }, (_, i) =>
      file(`src/f${i}.ts`),
    );
    const result = checkScope(files, tight);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_many_files");
  });
});

describe("default block patterns include CI / editor / hook directories", () => {
  it.each([
    [".husky/pre-commit"],
    [".devcontainer/devcontainer.json"],
    [".vscode/settings.json"],
    [".cursor/rules.md"],
    [".git-hooks/pre-push"],
    ["hooks/post-checkout"],
    ["Makefile"],
  ])("hard-blocks %s", (path) => {
    const result = checkScope([file(path, 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain(path);
    }
  });

  it("locks .github/ in DEFAULT_BLOCK_PATTERNS", () => {
    const dotGithub = DEFAULT_BLOCK_PATTERNS.find((p) => p.path === ".github/");
    expect(dotGithub).toBeDefined();
    expect(dotGithub?.locked).toBe(true);
  });

  it("leaves every other default unlocked", () => {
    const unlocked = DEFAULT_BLOCK_PATTERNS.filter((p) => !p.locked).map(
      (p) => p.path,
    );
    expect(unlocked).toContain("dist/");
    expect(unlocked).toContain("package.json");
    expect(unlocked).not.toContain(".github/");
  });
});

describe("parseBlockPathsSpec (TY-271)", () => {
  it("returns empty additions / removals for an empty spec", () => {
    expect(parseBlockPathsSpec("")).toEqual({
      additions: [],
      removals: [],
      ignoredRemovals: [],
    });
  });

  it("parses directory adds (trailing slash)", () => {
    expect(parseBlockPathsSpec("secrets/,infra/")).toEqual({
      additions: [
        { path: "secrets/", isDirectory: true, locked: false, userAdded: true },
        { path: "infra/", isDirectory: true, locked: false, userAdded: true },
      ],
      removals: [],
      ignoredRemovals: [],
    });
  });

  it("parses exact-file adds (no trailing slash)", () => {
    expect(parseBlockPathsSpec("Justfile,scripts/install.sh")).toEqual({
      additions: [
        { path: "Justfile", isDirectory: false, locked: false, userAdded: true },
        { path: "scripts/install.sh", isDirectory: false, locked: false, userAdded: true },
      ],
      removals: [],
      ignoredRemovals: [],
    });
  });

  it("treats a leading ! as a removal", () => {
    const spec = parseBlockPathsSpec("!Makefile,!package.json,!dist/");
    expect(spec.additions).toEqual([]);
    expect(spec.removals).toEqual([
      { path: "Makefile", isDirectory: false, locked: false },
      { path: "package.json", isDirectory: false, locked: false },
      { path: "dist/", isDirectory: true, locked: false },
    ]);
    expect(spec.ignoredRemovals).toEqual([]);
  });

  it("drops removals targeting .github/ (locked) and records them for warning", () => {
    const spec = parseBlockPathsSpec("!.github/,!.github/workflows/ci.yml");
    expect(spec.additions).toEqual([]);
    expect(spec.removals).toEqual([]);
    expect(spec.ignoredRemovals).toEqual([
      ".github/",
      ".github/workflows/ci.yml",
    ]);
  });

  it("trims whitespace and drops blank entries", () => {
    const spec = parseBlockPathsSpec(" secrets/ , ,  !Makefile ");
    expect(spec.additions).toEqual([
      { path: "secrets/", isDirectory: true, locked: false, userAdded: true },
    ]);
    expect(spec.removals).toEqual([
      { path: "Makefile", isDirectory: false, locked: false },
    ]);
  });

  it("strips a leading slash from additions so /secrets/ matches secrets/", () => {
    const spec = parseBlockPathsSpec("/secrets/,/Justfile");
    expect(spec.additions).toEqual([
      { path: "secrets/", isDirectory: true, locked: false, userAdded: true },
      { path: "Justfile", isDirectory: false, locked: false, userAdded: true },
    ]);
  });

  it("strips a leading slash from removals so !/dist/ removes dist/", () => {
    const spec = parseBlockPathsSpec("!/dist/,!/package.json");
    expect(spec.removals).toEqual([
      { path: "dist/", isDirectory: true, locked: false },
      { path: "package.json", isDirectory: false, locked: false },
    ]);
  });

  it("supports mixed additions and removals in one spec", () => {
    const spec = parseBlockPathsSpec("secrets/,!Makefile,Justfile,!dist/");
    expect(spec.additions.map((p) => p.path)).toEqual(["secrets/", "Justfile"]);
    expect(spec.removals.map((p) => p.path)).toEqual(["Makefile", "dist/"]);
  });
});

describe("buildScopePolicy (TY-271)", () => {
  it("falls back to defaults when overrides are empty", () => {
    const policy = buildScopePolicy({});
    expect(policy.maxFiles).toBe(DEFAULT_SCOPE_POLICY.maxFiles);
    expect(policy.maxLines).toBe(DEFAULT_SCOPE_POLICY.maxLines);
    expect(policy.blockPatterns).toEqual(DEFAULT_BLOCK_PATTERNS);
  });

  it("tightens budgets via maxFiles / maxLines", () => {
    const policy = buildScopePolicy({ maxFiles: 1, maxLines: 5 });
    const tooMany = checkScope(
      [file("src/a.ts", 1, 0), file("src/b.ts", 1, 0)],
      policy,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toBe("too_many_files");

    const tooLong = checkScope([file("src/a.ts", 10, 0)], policy);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toBe("too_many_lines");
  });

  it("adds new block patterns from blockPathsSpec (dir + exact)", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "scripts/,Justfile" });
    const dir = checkScope([file("scripts/deploy.sh", 1, 0)], policy);
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.reason).toBe("hard_block_path");

    const exact = checkScope([file("Justfile", 1, 0)], policy);
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.reason).toBe("hard_block_path");

    // The "exact" form must not match a longer path with the same prefix.
    const longer = checkScope([file("Justfile.bak", 1, 0)], policy);
    expect(longer.ok).toBe(true);
  });

  it("removes a default pattern when the spec includes its `!path` entry", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "!dist/" });
    const result = checkScope([file("dist/post-fix/index.cjs", 5, 0)], policy);
    expect(result.ok).toBe(true);
  });

  it("never lets the spec unlock .github/ even with !.github/...", () => {
    const policy = buildScopePolicy({
      blockPathsSpec: "!.github/,!.github/workflows/ci.yml",
    });
    const result = checkScope(
      [file(".github/workflows/ci.yml", 1, 0)],
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hard_block_path");
  });

  it("composes additions on top of survivors after removals", () => {
    const policy = buildScopePolicy({
      blockPathsSpec: "!Makefile,scripts/",
    });
    // Makefile passes (removed).
    expect(checkScope([file("Makefile", 1, 0)], policy).ok).toBe(true);
    // dist/ still blocked (default kept).
    expect(checkScope([file("dist/foo.js", 1, 0)], policy).ok).toBe(false);
    // scripts/ blocked (newly added).
    expect(
      checkScope([file("scripts/deploy.sh", 1, 0)], policy).ok,
    ).toBe(false);
  });

  it("folds legacy additionalHardBlockPrefixes into the block list (deprecated)", () => {
    const policy = buildScopePolicy({
      additionalHardBlockPrefixes: ["scripts/", "Justfile"],
    });
    expect(checkScope([file("scripts/x.sh", 1, 0)], policy).ok).toBe(false);
    expect(checkScope([file("Justfile", 1, 0)], policy).ok).toBe(false);
  });

  it("allows a root dotfile when !<file> is in the spec", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "!.gitignore" });
    expect(checkScope([file(".gitignore", 1, 0)], policy).ok).toBe(true);
    // Other root dotfiles still blocked.
    expect(checkScope([file(".editorconfig", 1, 0)], policy).ok).toBe(false);
  });

  it("allows a leading-slash removal of a root dotfile (!/.gitignore)", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "!/.gitignore" });
    expect(checkScope([file(".gitignore", 1, 0)], policy).ok).toBe(true);
  });

  it("allows a leading-slash addition that matches a changed path", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "/secrets/" });
    expect(checkScope([file("secrets/key.pem", 1, 0)], policy).ok).toBe(false);
  });

  it("allows a leading-slash removal of a default pattern (!/dist/)", () => {
    const policy = buildScopePolicy({ blockPathsSpec: "!/dist/" });
    expect(checkScope([file("dist/bundle.js", 1, 0)], policy).ok).toBe(true);
  });

  it("folds legacy hardBlockOverride into the block list as removals (deprecated)", () => {
    const policy = buildScopePolicy({
      hardBlockOverride: ["package.json", "tsconfig.json"],
    });
    // package.json / tsconfig.json now pass — equivalent to AUTO_REVIEW_BLOCK_PATHS=!package.json,!tsconfig.json.
    expect(checkScope([file("package.json", 1, 0)], policy).ok).toBe(true);
    expect(checkScope([file("tsconfig.json", 1, 0)], policy).ok).toBe(true);
    // package-lock.json (not overridden) still blocked.
    expect(checkScope([file("package-lock.json", 1, 0)], policy).ok).toBe(
      false,
    );
  });

  it("legacy hardBlockOverride cannot unlock .github/", () => {
    const policy = buildScopePolicy({
      hardBlockOverride: [".github/workflows/ci.yml"],
    });
    const result = checkScope(
      [file(".github/workflows/ci.yml", 1, 0)],
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hard_block_path");
  });
});

describe("real-world PR scenarios (TY-271 fixtures)", () => {
  // The four PRs the ticket cites as motivation. Each row asserts whether
  // the new default block-list + (optional) `AUTO_REVIEW_BLOCK_PATHS`
  // override clears the path or not.
  it("PR #71: .github/workflows/ci.yml stays blocked under defaults (locked)", () => {
    const result = checkScope([file(".github/workflows/ci.yml", 1, 0)]);
    expect(result.ok).toBe(false);
  });

  it("PR #73: dist/pre-fix/index.cjs blocked by default, passes with !dist/", () => {
    const blocked = checkScope([file("dist/pre-fix/index.cjs", 50, 0)]);
    expect(blocked.ok).toBe(false);

    const opted = buildScopePolicy({ blockPathsSpec: "!dist/" });
    expect(
      checkScope([file("dist/pre-fix/index.cjs", 50, 0)], opted).ok,
    ).toBe(true);
  });

  it("PR #75: loop/action.yml passes under the new defaults (no allow-list)", () => {
    const result = checkScope([
      file("loop/action.yml", 4, 0),
      file("loop/post-fix/action.yml", 3, 0),
    ]);
    expect(result.ok).toBe(true);
  });

  it("PR #77: README.md passes under the new defaults (no allow-list)", () => {
    const result = checkScope([file("README.md", 2, 0)]);
    expect(result.ok).toBe(true);
  });
});

describe("parseGitNumstat", () => {
  it("parses a basic three-line output", () => {
    const output = [
      "5\t2\tsrc/main-loop.ts",
      "10\t0\ttests/main-loop.test.ts",
      "1\t1\tdocs/README.md",
    ].join("\n");
    expect(parseGitNumstat(output)).toEqual([
      { path: "src/main-loop.ts", added: 5, deleted: 2 },
      { path: "tests/main-loop.test.ts", added: 10, deleted: 0 },
      { path: "docs/README.md", added: 1, deleted: 1 },
    ]);
  });

  it("marks binary files with -1/-1", () => {
    const output = "-\t-\tsrc/asset.bin";
    expect(parseGitNumstat(output)).toEqual([
      { path: "src/asset.bin", added: -1, deleted: -1 },
    ]);
  });

  it("preserves paths containing tabs", () => {
    const output = "1\t0\tsrc/weird\tname.ts";
    expect(parseGitNumstat(output)).toEqual([
      { path: "src/weird\tname.ts", added: 1, deleted: 0 },
    ]);
  });

  it("ignores blank lines", () => {
    const output = "1\t0\tsrc/a.ts\n\n\n2\t0\tsrc/b.ts\n";
    expect(parseGitNumstat(output)).toHaveLength(2);
  });

  it("ignores malformed numeric fields", () => {
    const output = "abc\t1\tsrc/a.ts\n1\txyz\tsrc/b.ts\n2\t0\tsrc/c.ts";
    const parsed = parseGitNumstat(output);
    expect(parsed).toEqual([{ path: "src/c.ts", added: 2, deleted: 0 }]);
  });

  it("drops compact rename notation paths so downstream `git add` cannot fail", () => {
    const output = [
      "5\t3\tsrc/{old.ts => new.ts}",
      "10\t0\t{src/old.ts => dst/new.ts}",
      "2\t1\tsrc/keep.ts",
    ].join("\n");
    expect(parseGitNumstat(output)).toEqual([
      { path: "src/keep.ts", added: 2, deleted: 1 },
    ]);
  });
});

describe("checkScopeBuildMode (TY-281)", () => {
  it("accepts dist/ output without an !dist/ override", () => {
    const result = checkScopeBuildMode([file("dist/post-fix/index.cjs", 200, 100)]);
    expect(result.ok).toBe(true);
  });

  it("accepts unlocked default-blocked files (package.json) without override", () => {
    const result = checkScopeBuildMode([
      file("package.json", 3, 1),
      file("package-lock.json", 50, 20),
    ]);
    expect(result.ok).toBe(true);
  });

  it("still rejects writes under .github/ (locked block)", () => {
    const result = checkScopeBuildMode([
      file("dist/post-fix/index.cjs", 200, 100),
      file(".github/workflows/leaked.yml", 10, 0),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain(".github/workflows/leaked.yml");
    }
  });

  it("still rejects path traversal", () => {
    const result = checkScopeBuildMode([
      file("../escape.ts", 1, 0),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("path_traversal");
    }
  });

  it("skips size budgets (file count + line count)", () => {
    // A bundle artifact typically has thousands of lines; the default
    // policy caps at 1000 lines / 20 files. Build mode must accept this.
    const tiny = (i: number) => file(`dist/chunks/${i}.cjs`, 50, 0);
    const manyFiles: ChangedFile[] = Array.from({ length: 100 }, (_, i) => tiny(i));
    const result = checkScopeBuildMode(manyFiles);
    expect(result.ok).toBe(true);
  });

  it("skips binary check", () => {
    // numstat `-` / `-` means binary; build outputs may include binaries
    // (wasm, generated images). Build mode does not refuse them outright —
    // the user owns the BUILD_COMMAND.
    const result = checkScopeBuildMode([file("dist/asset.wasm", -1, -1)]);
    expect(result.ok).toBe(true);
  });

  it("still rejects writes to operator-added custom block paths (unlocked)", () => {
    // AUTO_REVIEW_BLOCK_PATHS=secrets/ adds a non-default, non-locked pattern.
    // Build mode must enforce it even though it is unlocked — only the built-in
    // defaults (dist/, package.json, …) are relaxed.
    const policy = buildScopePolicy({ blockPathsSpec: "secrets/" });
    const result = checkScopeBuildMode(
      [file("dist/index.cjs", 200, 100), file("secrets/api-key.pem", 1, 0)],
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain("secrets/api-key.pem");
      expect(result.offendingPaths).not.toContain("dist/index.cjs");
    }
  });

  it("still allows default-unlocked paths when a custom policy also adds other paths", () => {
    // Verify that adding a custom pattern does not re-block the defaults.
    const policy = buildScopePolicy({ blockPathsSpec: "infra/" });
    const result = checkScopeBuildMode(
      [file("dist/bundle.js", 500, 0), file("package.json", 1, 0)],
      policy,
    );
    expect(result.ok).toBe(true);
  });

  it("enforces a custom block nested inside a relaxed default prefix", () => {
    // dist/ is a default-unlocked path in build mode, but if an operator adds
    // dist/secrets/ to AUTO_REVIEW_BLOCK_PATHS, that sub-path must still be
    // blocked even though the parent prefix (dist/) is relaxed.
    const policy = buildScopePolicy({ blockPathsSpec: "dist/secrets/" });
    const result = checkScopeBuildMode(
      [
        file("dist/index.cjs", 200, 100),
        file("dist/secrets/key.pem", 1, 0),
      ],
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain("dist/secrets/key.pem");
      expect(result.offendingPaths).not.toContain("dist/index.cjs");
    }
  });

  it("blocks an explicitly re-added default path in build mode", () => {
    // AUTO_REVIEW_BLOCK_PATHS=dist/ re-blocks a default-unlocked path. Build
    // mode must honour the operator's explicit policy and reject writes to dist/,
    // even though dist/ is normally relaxed by build-mode.
    const policy = buildScopePolicy({ blockPathsSpec: "dist/" });
    const result = checkScopeBuildMode([file("dist/index.cjs", 200, 100)], policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain("dist/index.cjs");
    }
  });

  it("blocks an explicitly re-added default file (package.json) in build mode", () => {
    // AUTO_REVIEW_BLOCK_PATHS=package.json re-blocks a default-unlocked exact
    // file. Build mode must honour the operator's explicit policy.
    const policy = buildScopePolicy({ blockPathsSpec: "package.json" });
    const result = checkScopeBuildMode([file("package.json", 3, 1)], policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toContain("package.json");
    }
  });

});

// Sanity check unused import suppression: keep BlockPattern referenced so the
// test file documents the public type even when individual cases narrow on
// `matchedBlockPatterns`.
const _patternTypeSpec: BlockPattern = {
  path: "x",
  isDirectory: false,
  locked: false,
};
void _patternTypeSpec;
