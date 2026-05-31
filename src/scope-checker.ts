/**
 * Diff-scope validation for claude-code-action outputs (TY-271).
 *
 * After `anthropics/claude-code-action@v1` finishes editing the repo, the
 * workflow runs this check against `git diff --numstat HEAD` (or equivalent)
 * to confirm the agent stayed within the policy defined in
 * `docs/operations/scope-policy.md`.
 *
 * Violations cause the post-fix step to revert and stop with
 * `stop_reason: scope_violation`.
 *
 * # Block-list semantics
 *
 * The scope check is a pure block-list: every changed path is allowed unless
 * it matches a configured block pattern. There is no allow-list — operators
 * who need to forbid additional paths add them via `LOOPPILOT_BLOCK_PATHS`.
 *
 * Block patterns come from two sources:
 *   1. `DEFAULT_BLOCK_PATTERNS` — built-in defaults whose contents would let
 *      a repair re-enable arbitrary execution or rewrite CI / dependency
 *      surface. `.github/` is marked `locked` and cannot be unblocked.
 *   2. The repo-level `LOOPPILOT_BLOCK_PATHS` spec — `.gitignore`-style
 *      syntax (`secrets/`, `Justfile`, `!Makefile`) that either adds entries
 *      or removes entries from the defaults via the `!` prefix.
 */

import { unquoteGitPath } from "./secret-scanner.js";

export interface ChangedFile {
  /** Repo-relative path. `git diff --name-only` style — no leading slash. */
  path: string;
  /** Lines added; -1 for binary files. */
  added: number;
  /** Lines deleted; -1 for binary files. */
  deleted: number;
}

/**
 * A block pattern matches either a directory prefix (trailing slash) or an
 * exact file path.
 */
export interface BlockPattern {
  /** The path as written: `secrets/` for a directory, `Makefile` for exact. */
  readonly path: string;
  /** True iff `path` ends with `/`. */
  readonly isDirectory: boolean;
  /**
   * When true, the pattern cannot be removed via `!path` in the user spec.
   * Only `.github/` is locked by default (CI-rewrite escape hatch).
   */
  readonly locked: boolean;
  /**
   * When true, the pattern was explicitly added by the operator via
   * `LOOPPILOT_BLOCK_PATHS`.
   * `checkScopeBuildMode` enforces user-added patterns even when their path
   * matches a default-unlocked entry, so operators can re-block paths like
   * `dist/` or `package.json` in build mode.
   */
  readonly userAdded?: boolean;
}

export interface ScopeCheckPolicy {
  maxFiles: number;
  maxLines: number;
  /**
   * Final, merged block patterns. The post-fix step rejects any changed path
   * whose value matches one of these patterns (directory prefix or exact file).
   */
  blockPatterns: readonly BlockPattern[];
  /**
   * Root dotfiles explicitly unblocked via `!.gitignore`-style removals.
   * When a path matches `ROOT_DOTFILE_RE` and is present here it is allowed
   * instead of hard-blocked.
   */
  exemptedRootDotfiles?: ReadonlySet<string>;
}

/**
 * Built-in block defaults. Only `.github/` is locked: rewriting workflow YAML
 * would let an agent disable the rest of the scope check from inside its own
 * diff. The rest are overridable via `LOOPPILOT_BLOCK_PATHS=!<path>` so
 * operators can opt specific paths in (e.g. `!dist/` for vendored bundles
 * the loop is expected to regenerate).
 */
export const DEFAULT_BLOCK_PATTERNS: readonly BlockPattern[] = [
  { path: ".github/", isDirectory: true, locked: true },
  { path: ".husky/", isDirectory: true, locked: false },
  { path: ".git-hooks/", isDirectory: true, locked: false },
  { path: "hooks/", isDirectory: true, locked: false },
  { path: ".devcontainer/", isDirectory: true, locked: false },
  { path: ".vscode/", isDirectory: true, locked: false },
  { path: ".cursor/", isDirectory: true, locked: false },
  { path: "node_modules/", isDirectory: true, locked: false },
  { path: "dist/", isDirectory: true, locked: false },
  { path: "Makefile", isDirectory: false, locked: false },
  { path: "package.json", isDirectory: false, locked: false },
  { path: "package-lock.json", isDirectory: false, locked: false },
  { path: "tsconfig.json", isDirectory: false, locked: false },
];

// Fast lookup set for the built-in defaults — used by checkScopeBuildMode to
// distinguish default-unlocked patterns (relax) from operator-added entries (enforce).
const DEFAULT_BLOCK_PATTERN_PATHS = new Set(DEFAULT_BLOCK_PATTERNS.map((p) => p.path));

/**
 * Matches any single-segment root dotfile (`.gitignore`, `.editorconfig`,
 * `.nvmrc`, …). Not part of `DEFAULT_BLOCK_PATTERNS` because it's a wildcard
 * that needs regex evaluation; tracked separately and overridable per-file
 * via `LOOPPILOT_BLOCK_PATHS=!.gitignore` etc.
 */
const ROOT_DOTFILE_RE = /^\.[^/]+$/;

export const DEFAULT_SCOPE_POLICY: ScopeCheckPolicy = {
  maxFiles: 20,
  maxLines: 1000,
  blockPatterns: DEFAULT_BLOCK_PATTERNS,
  exemptedRootDotfiles: new Set(),
};

/**
 * Parsed `LOOPPILOT_BLOCK_PATHS` spec. `additions` are appended to the
 * block list; `removals` are deleted from it (matched literally against
 * `BlockPattern.path`, including the trailing slash for directories).
 *
 * `!.github/...` entries are dropped during parsing — the lock guarantees
 * that the corresponding pattern would survive removal anyway, but dropping
 * them up front lets the warning surface at the policy boundary instead of
 * being silently ignored inside `buildScopePolicy`.
 */
export interface BlockPathsSpec {
  additions: BlockPattern[];
  removals: BlockPattern[];
  /** Entries that targeted a locked pattern (`!.github/...`) and were ignored. */
  ignoredRemovals: string[];
}

/**
 * Parse a `.gitignore`-style block-paths spec.
 *
 * Syntax:
 *   - Comma-separated entries; surrounding whitespace trimmed; blank entries
 *     dropped.
 *   - Trailing `/` → directory prefix (`secrets/`).
 *   - No trailing `/` → exact file match (`Justfile`).
 *   - Leading `!` → remove from defaults (`!Makefile`). The `!.github/...`
 *     form is dropped and recorded in `ignoredRemovals` so the caller can
 *     warn the operator.
 */
export function parseBlockPathsSpec(raw: string): BlockPathsSpec {
  const spec: BlockPathsSpec = {
    additions: [],
    removals: [],
    ignoredRemovals: [],
  };
  if (raw === "") return spec;

  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const isRemoval = entry.startsWith("!");
    const rawPath = isRemoval ? entry.slice(1).trim() : entry;
    // Strip a leading `/` so operators can write `/secrets/` or `!/dist/`
    // following .gitignore conventions; repo-relative paths have no leading slash.
    const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
    if (path.length === 0) continue;

    if (isRemoval) {
      // `.github/` is the only locked default; refuse to remove it (or any
      // path under it, since `.github/workflows/foo.yml` would otherwise
      // sidestep the lock by being added through `!`).
      if (path === ".github/" || path.startsWith(".github/")) {
        spec.ignoredRemovals.push(path);
        continue;
      }
      spec.removals.push({ path, isDirectory: path.endsWith("/"), locked: false });
    } else {
      spec.additions.push({ path, isDirectory: path.endsWith("/"), locked: false, userAdded: true });
    }
  }

  return spec;
}

export interface ScopePolicyOverrides {
  /** Raw `LOOPPILOT_BLOCK_PATHS` spec; empty string keeps defaults. */
  blockPathsSpec?: string;
  maxFiles?: number;
  maxLines?: number;
}

/**
 * Build a `ScopeCheckPolicy` from action-input style overrides.
 *
 * Resolution order:
 *   1. Start from `DEFAULT_BLOCK_PATTERNS`.
 *   2. Apply removals from the spec — but only for unlocked entries;
 *      `.github/` survives any removal attempt.
 *   3. Append additions from the spec.
 *
 * `maxFiles` / `maxLines` of 0 or undefined fall back to defaults.
 */
export function buildScopePolicy(overrides: ScopePolicyOverrides): ScopeCheckPolicy {
  const spec = parseBlockPathsSpec(overrides.blockPathsSpec ?? "");

  const removals: BlockPattern[] = [...spec.removals];
  const additions: BlockPattern[] = [...spec.additions];

  const removalKeys = new Set(removals.map((p) => p.path));
  const surviving: BlockPattern[] = DEFAULT_BLOCK_PATTERNS.filter(
    (p) => p.locked || !removalKeys.has(p.path),
  );

  // Removals that match the root-dotfile wildcard (e.g. !.gitignore) exempt
  // those specific files from the ROOT_DOTFILE_RE fallback in matchBlockPattern.
  const exemptedRootDotfiles = new Set(
    removals.map((p) => p.path).filter((p) => ROOT_DOTFILE_RE.test(p)),
  );

  return {
    maxFiles: overrides.maxFiles && overrides.maxFiles > 0
      ? overrides.maxFiles
      : DEFAULT_SCOPE_POLICY.maxFiles,
    maxLines: overrides.maxLines && overrides.maxLines > 0
      ? overrides.maxLines
      : DEFAULT_SCOPE_POLICY.maxLines,
    blockPatterns: [...surviving, ...additions],
    exemptedRootDotfiles,
  };
}

export type ScopeViolationReason =
  | "path_traversal"
  | "hard_block_path"
  | "too_many_files"
  | "too_many_lines"
  | "binary_change";

export interface ScopeCheckOk {
  ok: true;
  changedFiles: number;
  totalLines: number;
}

export interface ScopeCheckViolation {
  ok: false;
  reason: ScopeViolationReason;
  message: string;
  offendingPaths: string[];
  /**
   * For `hard_block_path`, the subset of block patterns that the offending
   * paths matched. Lets the caller surface "the !path entry you need to set"
   * without re-running the matcher in the comment formatter.
   */
  matchedBlockPatterns?: BlockPattern[];
}

export type ScopeCheckResult = ScopeCheckOk | ScopeCheckViolation;

function isUnsafePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith("/")) return true;
  if (path.startsWith("../") || path === "..") return true;
  // Any `..` segment anywhere in the path is also unsafe.
  return path.split("/").includes("..");
}

function matchBlockPattern(
  path: string,
  patterns: readonly BlockPattern[],
  exemptedRootDotfiles: ReadonlySet<string> = new Set(),
): BlockPattern | null {
  for (const p of patterns) {
    if (p.isDirectory) {
      if (path.startsWith(p.path)) return p;
    } else if (path === p.path) {
      return p;
    }
  }
  if (ROOT_DOTFILE_RE.test(path) && !exemptedRootDotfiles.has(path)) {
    return { path, isDirectory: false, locked: false };
  }
  return null;
}

/**
 * Validate the claude-code-action diff against the configured policy.
 *
 * Ordering:
 *   1. Path traversal / absolute paths short-circuit everything; they indicate
 *      a malformed diff and should never be applied.
 *   2. Block patterns reject paths that match any configured pattern.
 *   3. Binary files (numstat `-`/`-`) are refused — `checkScope` cannot count
 *      their size and the CHECK_COMMAND rollback path would not catch them.
 *   4. Aggregate budgets (file count, line count) are checked last so the
 *      caller sees the more specific violation when both apply.
 */
export function checkScope(
  files: readonly ChangedFile[],
  policy: ScopeCheckPolicy = DEFAULT_SCOPE_POLICY,
): ScopeCheckResult {
  const traversal: string[] = [];
  const blocked: string[] = [];
  const blockedMatches: BlockPattern[] = [];
  const binary: string[] = [];
  let totalLines = 0;

  for (const file of files) {
    if (isUnsafePath(file.path)) {
      traversal.push(file.path);
      continue;
    }

    const match = matchBlockPattern(file.path, policy.blockPatterns, policy.exemptedRootDotfiles);
    if (match !== null) {
      blocked.push(file.path);
      blockedMatches.push(match);
      continue;
    }

    if (file.added < 0 || file.deleted < 0) {
      binary.push(file.path);
      continue;
    }

    totalLines += file.added + file.deleted;
  }

  if (traversal.length > 0) {
    return {
      ok: false,
      reason: "path_traversal",
      message: `Refusing to apply diff containing path-traversal or absolute paths: ${traversal.join(", ")}`,
      offendingPaths: traversal,
    };
  }

  if (blocked.length > 0) {
    return {
      ok: false,
      reason: "hard_block_path",
      message: `Diff touches blocked paths: ${blocked.join(", ")}`,
      offendingPaths: blocked,
      matchedBlockPatterns: blockedMatches,
    };
  }

  if (binary.length > 0) {
    return {
      ok: false,
      reason: "binary_change",
      message: `Diff contains binary changes which auto-fix cannot validate: ${binary.join(", ")}`,
      offendingPaths: binary,
    };
  }

  if (files.length > policy.maxFiles) {
    return {
      ok: false,
      reason: "too_many_files",
      message: `Diff changes ${files.length} files (limit ${policy.maxFiles})`,
      offendingPaths: files.map((f) => f.path),
    };
  }

  if (totalLines > policy.maxLines) {
    return {
      ok: false,
      reason: "too_many_lines",
      message: `Diff changes ${totalLines} lines (limit ${policy.maxLines})`,
      offendingPaths: files.map((f) => f.path),
    };
  }

  return {
    ok: true,
    changedFiles: files.length,
    totalLines,
  };
}

/**
 * Build-mode variant of `checkScope` (TY-281). Used by post-fix to validate
 * the FULL post-build diff (claude-code-action's edits plus `BUILD_COMMAND`
 * output) with relaxed rules so a repo opting into a build step does not
 * also have to opt every artifact path out of the default block list.
 *
 * Skipped vs `checkScope`:
 *   - Unlocked block patterns (default-blocked but un-lockable, e.g. `dist/`,
 *     `package.json`). The user explicitly chose `BUILD_COMMAND` to write to
 *     such paths; requiring a parallel `LOOPPILOT_BLOCK_PATHS=!dist/` is
 *     friction without benefit.
 *   - File count / line count budgets. Build artifacts are typically large
 *     and deterministic, and the pre-build `checkScope` already constrained
 *     claude-code-action's intent.
 *   - Binary check. Build output may legitimately be binary (WASM, generated
 *     assets, sourcemaps near the binary boundary).
 *
 * Still rejected:
 *   - Path traversal / absolute paths. These indicate a malformed numstat,
 *     never a legitimate build output.
 *   - **Locked** block patterns (`.github/`). The lock exists so the agent
 *     cannot disable the scope check itself by rewriting workflow YAML;
 *     letting `BUILD_COMMAND` write there would defeat that protection.
 *   - **Operator-added custom patterns** (entries in `LOOPPILOT_BLOCK_PATHS`
 *     that are not part of `DEFAULT_BLOCK_PATTERNS`, e.g. `secrets/`). Build
 *     mode relaxes only the built-in defaults; explicit policy additions must
 *     be honoured so the operator's scope policy is not bypassed.
 */
export function checkScopeBuildMode(
  files: readonly ChangedFile[],
  policy: ScopeCheckPolicy = DEFAULT_SCOPE_POLICY,
): ScopeCheckResult {
  const traversal: string[] = [];
  const blocked: string[] = [];
  const blockedMatches: BlockPattern[] = [];
  let totalLines = 0;

  // Only enforce locked patterns, operator-added custom entries, and default
  // paths that the operator explicitly re-blocked via LOOPPILOT_BLOCK_PATHS.
  // Default-list unlocked patterns (e.g. dist/, package.json) are relaxed so
  // BUILD_COMMAND output does not need separate exemptions for expected artifacts.
  // userAdded patterns are enforced even when their path matches a default so
  // operators can re-block a default (e.g. LOOPPILOT_BLOCK_PATHS=dist/) and
  // have that policy respected in build mode.
  // Checking against only the enforced set ensures that a more-specific custom
  // block nested under a relaxed default (e.g. dist/secrets/ inside dist/) is
  // still matched and enforced instead of being shadowed by the default.
  const enforcedPatterns = policy.blockPatterns.filter(
    (p) => p.locked || (p.userAdded ?? false) || !DEFAULT_BLOCK_PATTERN_PATHS.has(p.path),
  );

  for (const file of files) {
    if (isUnsafePath(file.path)) {
      traversal.push(file.path);
      continue;
    }

    const match = matchBlockPattern(
      file.path,
      enforcedPatterns,
      policy.exemptedRootDotfiles,
    );
    if (match !== null) {
      blocked.push(file.path);
      blockedMatches.push(match);
      continue;
    }

    if (file.added >= 0 && file.deleted >= 0) {
      totalLines += file.added + file.deleted;
    }
  }

  if (traversal.length > 0) {
    return {
      ok: false,
      reason: "path_traversal",
      message: `Refusing to apply diff containing path-traversal or absolute paths: ${traversal.join(", ")}`,
      offendingPaths: traversal,
    };
  }

  if (blocked.length > 0) {
    return {
      ok: false,
      reason: "hard_block_path",
      message: `BUILD_COMMAND output touches locked paths: ${blocked.join(", ")}`,
      offendingPaths: blocked,
      matchedBlockPatterns: blockedMatches,
    };
  }

  return {
    ok: true,
    changedFiles: files.length,
    totalLines,
  };
}

/**
 * Compact rename notation that `git diff --numstat` emits when `--no-renames`
 * is omitted: `src/{old.ts => new.ts}` or `{src/old.ts => dst/new.ts}`. The
 * `{...}` wrapping is what distinguishes synthetic rename paths from a real
 * filename that happens to contain ` => ` (rare, but valid on the filesystem).
 */
const RENAME_NOTATION_RE = /\{[^{}]+ => [^{}]+\}/;

/**
 * Parse `git diff --numstat <base>` output into ChangedFile entries.
 *
 * Format per line: `<added>\t<deleted>\t<path>`. For binary files,
 * git emits `-\t-\t<path>`, which we surface as `added=-1, deleted=-1`
 * so the caller can refuse them via `checkScope`.
 *
 * **Rename notation guard:** without `--no-renames`, git can emit
 * compact rename paths such as `src/{old.ts => new.ts}` or
 * `{src/old.ts => dst/new.ts}` that are not real filesystem paths.
 * Passing such a string straight into `git add -- <path>` or
 * `readFileSync(path)` fails. Callers should prefer `--no-renames`,
 * but as a defense-in-depth measure this parser silently drops any
 * line whose path matches the `{... => ...}` rename form so the
 * downstream pipeline cannot accidentally stage or read the synthetic
 * rename name. TY-285 #2: the filter is restricted to the wrapped form
 * — an earlier `path.includes(" => ")` substring check silently dropped
 * legitimate filenames that contained ` => ` (e.g. `src/arrow => fn.ts`).
 */
export function parseGitNumstat(output: string): ChangedFile[] {
  const lines = output.split("\n");
  const files: ChangedFile[] = [];
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const parts = raw.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    let path = rest.join("\t");
    if (path.length === 0) continue;
    // TY-306 #2: git emits C-quoted paths (`"src/foo\tbar.ts"`) when a path
    // contains tabs / newlines / embedded quotes. `-c core.quotepath=false`
    // (TY-285 #1) only suppresses quoting of non-ASCII bytes — control
    // characters are always quoted because the numstat separators are tab /
    // newline themselves. Decode the quoted form so scope-check sees the
    // same filename `parseDiffHeaderPath` (secret-scanner) does; otherwise
    // the literal `"..."` slips past block patterns and `stagePaths` fails
    // with ENOENT.
    if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
      path = unquoteGitPath(path.slice(1, -1));
    }
    if (RENAME_NOTATION_RE.test(path)) continue;
    const added = a === "-" ? -1 : Number.parseInt(a, 10);
    const deleted = d === "-" ? -1 : Number.parseInt(d, 10);
    if (
      (a !== "-" && !Number.isFinite(added)) ||
      (d !== "-" && !Number.isFinite(deleted))
    ) {
      continue;
    }
    files.push({ path, added, deleted });
  }
  return files;
}
