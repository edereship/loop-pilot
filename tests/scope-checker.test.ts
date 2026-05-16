import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOPE_POLICY,
  checkScope,
  parseGitNumstat,
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

  it("accepts a dotfile nested inside an allowed path", () => {
    // src/.eslintrc would be allowed; the hard-block only matches root dotfiles.
    const result = checkScope([file("src/.eslintrc.json", 1, 0)]);
    expect(result.ok).toBe(true);
  });

  it("rejects a change to a path outside the allow-list", () => {
    const result = checkScope([file("lib/utils.ts", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("disallowed_path");
      expect(result.offendingPaths).toEqual(["lib/utils.ts"]);
    }
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

  it("honors a broader allowed path list", () => {
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      allowedPathPrefixes: ["src/", "tests/", "docs/", "lib/"],
    };
    const result = checkScope([file("lib/utils.ts")], policy);
    expect(result.ok).toBe(true);
  });
});

describe("checkScope (hardBlockOverride / TY-255)", () => {
  it("default policy keeps hard-block behavior unchanged", () => {
    // Sanity check: with no override paths (the default), package.json /
    // tsconfig.json / dotfiles all fall under hard_block_path just like before.
    const result = checkScope([file("package.json", 1, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hard_block_path");
  });

  it("allows an opted-in path to pass the hard-block check", () => {
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      // package.json itself is not under any allowed prefix, so we also need
      // to extend allowedPathPrefixes to actually let the file through. The
      // override only skips hard-block — the allow-list still applies.
      allowedPathPrefixes: ["src/", "tests/", "docs/", "package.json"],
      hardBlockOverride: ["package.json"],
    };
    const result = checkScope([file("package.json", 1, 1)], policy);
    expect(result.ok).toBe(true);
  });

  it("override falls back to disallowed_path when the path is not in the allow-list", () => {
    // The spec says "skip hard-block, then proceed to allowedPathPrefixes":
    // overriding alone is not enough — operators must also bring the path
    // under an allowed prefix. Document that here so a future refactor
    // doesn't silently widen the allow-list via the override.
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      hardBlockOverride: ["package.json"],
    };
    const result = checkScope([file("package.json", 1, 0)], policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disallowed_path");
  });

  it("does not affect paths that are not in the override list", () => {
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      hardBlockOverride: ["package.json"],
    };
    const result = checkScope([file("tsconfig.json", 1, 0)], policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toEqual(["tsconfig.json"]);
    }
  });

  it("always blocks .github/ even when listed in the override (CI rewrite escape hatch)", () => {
    // .github/ is intentionally non-overridable: letting the agent edit
    // workflow YAML would let it disable the rest of the scope check from
    // inside its own diff. The override entry is silently ignored for
    // .github/-prefixed paths.
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      hardBlockOverride: [".github/workflows/foo.yml"],
    };
    const result = checkScope(
      [file(".github/workflows/foo.yml", 1, 0)],
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hard_block_path");
      expect(result.offendingPaths).toEqual([".github/workflows/foo.yml"]);
    }
  });

  it("requires an exact path match (prefix-only entries do not opt in nested files)", () => {
    // The override is matched literally against `file.path` (Set#has), not
    // as a prefix. Operators who want to opt every dotfile in must list each
    // one explicitly.
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      hardBlockOverride: ["package"],
    };
    const result = checkScope([file("package.json", 1, 0)], policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hard_block_path");
  });

  it("lets multiple override entries through while still blocking non-listed ones", () => {
    const policy: ScopeCheckPolicy = {
      ...DEFAULT_SCOPE_POLICY,
      allowedPathPrefixes: [
        "src/",
        "tests/",
        "docs/",
        "package.json",
        "tsconfig.json",
      ],
      hardBlockOverride: ["package.json", "tsconfig.json"],
    };
    const ok = checkScope(
      [file("package.json", 1, 0), file("tsconfig.json", 1, 0)],
      policy,
    );
    expect(ok.ok).toBe(true);

    const blocked = checkScope([file("package-lock.json", 1, 0)], policy);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("hard_block_path");
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
    // Tabs in filenames are pathological but possible. Anything after the
    // second tab is the path.
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
    // Without --no-renames git can emit `src/{old.ts => new.ts}` and similar
    // synthetic paths. Passing them straight to `git add -- <path>` fails
    // with a pathspec error. Defense-in-depth: this parser silently skips
    // any line whose path contains the ` => ` token.
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
