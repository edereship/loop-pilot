import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as core from "@actions/core";

/**
 * `git rev-parse HEAD`. On failure, logs a `core.warning(...)` prefixed with
 * `[label]` and returns `""` so callers can decide whether to bail out.
 *
 * `label` (`"pre-fix"` / `"post-fix"`) preserves the original log prefix the
 * pre-fix and post-fix entrypoints used before this helper was extracted.
 */
export function readHeadSha(label: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
  } catch (error) {
    core.warning(
      `[${label}] Could not read HEAD sha: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "";
  }
}

/**
 * `git checkout <ref>`. A failure here means the workflow cannot operate on
 * the intended PR ref (e.g. force-push / branch-rename race). Propagating
 * the error lets the outer crash-recovery demote `fixing` back to a terminal
 * status; swallowing it would let claude-code-action and post-fix run
 * against whatever ref happens to be checked out, producing commits on the
 * wrong branch or surprise push failures.
 */
export function checkoutBranch(ref: string): void {
  execFileSync("git", ["checkout", ref], { stdio: "inherit" });
}

/** `git diff --numstat --no-renames HEAD` (raw stdout). */
export function gitDiffNumstat(): string {
  return execFileSync("git", ["diff", "--numstat", "--no-renames", "HEAD"], {
    encoding: "utf-8",
  });
}

/** `git ls-files --others --exclude-standard` (raw stdout). */
export function gitListUntracked(): string {
  return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf-8",
  });
}

/**
 * Read a file from the working tree. Returns `null` when the file is missing
 * or contains a NUL byte (treated as binary; `checkScope` refuses binary
 * entries).
 */
export function readWorkingTreeFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    if (content.includes(0)) return null;
    return content.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * `git reset --hard HEAD` followed by `git clean -ffd`. The double-force
 * clean removes untracked directories and nested git working trees, so
 * files newly written by claude-code-action do not survive a "rollback" and
 * pollute subsequent iterations of the same job.
 */
export function resetWorkingTree(): void {
  execFileSync("git", ["reset", "--hard", "HEAD"], { stdio: "inherit" });
  execFileSync("git", ["clean", "-ffd"], { stdio: "inherit" });
}

/** `git add -- <paths>`. No-op when `paths` is empty. */
export function stagePaths(paths: string[]): void {
  if (paths.length === 0) return;
  execFileSync("git", ["add", "--", ...paths], { stdio: "inherit" });
}

/**
 * `git diff --cached --quiet`. Returns `true` when there are staged changes
 * (the command exits non-zero), `false` when the index matches HEAD.
 */
export function hasStagedChanges(): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { stdio: "inherit" });
    return false;
  } catch {
    return true;
  }
}

/** `git commit -m <message>`. */
export function commit(message: string): void {
  execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
}

/** `git push`. */
export function push(): void {
  execFileSync("git", ["push"], { stdio: "inherit" });
}
