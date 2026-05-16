/**
 * Diff-scope validation for claude-code-action outputs.
 *
 * After `anthropics/claude-code-action@v1` finishes editing the repo, the
 * workflow runs this check against `git diff --numstat HEAD` (or equivalent)
 * to confirm the agent stayed within the policy defined in
 * `docs/operations/security.md` ("Claude Code Action 実行制御" / 変更スコープ検査).
 *
 * Violations cause the post-fix step to revert and stop with
 * `stop_reason: scope_violation`.
 */

export interface ChangedFile {
  /** Repo-relative path. `git diff --name-only` style — no leading slash. */
  path: string;
  /** Lines added; -1 for binary files. */
  added: number;
  /** Lines deleted; -1 for binary files. */
  deleted: number;
}

export interface ScopeCheckPolicy {
  maxFiles: number;
  maxLines: number;
  /**
   * A path is in scope if it starts with one of these prefixes
   * (after the hard-block check). Use trailing slashes (`src/`).
   */
  allowedPathPrefixes: readonly string[];
  /**
   * Patterns matched against the full path. Any hit is a hard
   * block, regardless of allowedPathPrefixes.
   */
  hardBlockPatterns: readonly RegExp[];
  /**
   * Repo-relative paths (exact match against `file.path`) that opt out of
   * `hardBlockPatterns` (TY-255). Used when ops explicitly want to let
   * claude-code-action touch `package.json` / `tsconfig.json` etc. Default
   * `[]` keeps the strict boundary intact.
   *
   * `.github/` paths are always blocked even when listed here, because
   * CI rewrites would let an agent disable the rest of the scope check
   * from inside the diff itself.
   */
  hardBlockOverride: readonly string[];
}

export const DEFAULT_SCOPE_POLICY: ScopeCheckPolicy = {
  maxFiles: 20,
  maxLines: 1000,
  allowedPathPrefixes: ["src/", "tests/", "docs/"],
  hardBlockPatterns: [
    /^\.github\//,
    /^node_modules\//,
    /^dist\//,
    /^package\.json$/,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
    /^\.[^/]+$/,
  ],
  hardBlockOverride: [],
};

export type ScopeViolationReason =
  | "path_traversal"
  | "hard_block_path"
  | "disallowed_path"
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
}

export type ScopeCheckResult = ScopeCheckOk | ScopeCheckViolation;

function isUnsafePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith("/")) return true;
  if (path.startsWith("../") || path === "..") return true;
  // Any `..` segment anywhere in the path is also unsafe.
  return path.split("/").includes("..");
}

/**
 * Validate the claude-code-action diff against the configured policy.
 *
 * Ordering rationale:
 *   1. Path traversal / absolute paths short-circuit everything; they indicate
 *      a malformed diff and should never be applied.
 *   2. Hard-block patterns are checked before allowedPathPrefixes so that
 *      e.g. `.github/workflows/foo.yml` fails even if `.github` were ever
 *      added to allowedPathPrefixes by mistake.
 *   3. allowedPathPrefixes act as the positive allow-list for everything else.
 *   4. Aggregate budgets (file count, line count) are checked last so the
 *      caller sees the more specific violation when both apply.
 */
export function checkScope(
  files: readonly ChangedFile[],
  policy: ScopeCheckPolicy = DEFAULT_SCOPE_POLICY
): ScopeCheckResult {
  const traversal: string[] = [];
  const blocked: string[] = [];
  const disallowed: string[] = [];
  const binary: string[] = [];
  let totalLines = 0;

  const overrideSet = new Set(policy.hardBlockOverride);

  for (const file of files) {
    if (isUnsafePath(file.path)) {
      traversal.push(file.path);
      continue;
    }

    if (policy.hardBlockPatterns.some((re) => re.test(file.path))) {
      // TY-255: allow the diff if ops opted this exact path into the
      // override list. `.github/` is never overridable — letting a repair
      // edit workflow YAML would let the agent disable the rest of the
      // scope check from inside its own diff.
      const overridable =
        !file.path.startsWith(".github/") && overrideSet.has(file.path);
      if (!overridable) {
        blocked.push(file.path);
        continue;
      }
    }

    const isAllowed = policy.allowedPathPrefixes.some((prefix) =>
      file.path.startsWith(prefix)
    );
    if (!isAllowed) {
      disallowed.push(file.path);
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
      message: `Diff touches hard-blocked paths (see docs/operations/security.md): ${blocked.join(", ")}`,
      offendingPaths: blocked,
    };
  }

  if (disallowed.length > 0) {
    return {
      ok: false,
      reason: "disallowed_path",
      message: `Diff touches paths outside the allow-list (${policy.allowedPathPrefixes.join(", ")}): ${disallowed.join(", ")}`,
      offendingPaths: disallowed,
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
 * line whose path contains the ` => ` token so the downstream pipeline
 * cannot accidentally stage or read the synthetic rename name.
 */
export function parseGitNumstat(output: string): ChangedFile[] {
  const lines = output.split("\n");
  const files: ChangedFile[] = [];
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const parts = raw.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const path = rest.join("\t");
    if (path.length === 0) continue;
    if (path.includes(" => ")) continue;
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
