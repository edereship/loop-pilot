/**
 * Derive `Bash(...)` entries for `claude-code-action`'s `--allowedTools` from
 * the configured CHECK_COMMAND.
 *
 * The repair prompt instructs Claude Code to run CHECK_COMMAND as final
 * verification. When the downstream repository sets CHECK_COMMAND to
 * something other than the historical `npm run check` default (e.g.
 * `pnpm run check`, `pytest -xvs`, `make check`), the hard-coded npm
 * allowlist in `loop/action.yml` blocks that command and the action
 * exhausts `--max-turns` without succeeding.
 *
 * Safety model:
 *   - Only commands whose first token is in {@link CHECK_COMMAND_BINARY_WHITELIST}
 *     are accepted. Anything else (`rm`, `curl`, custom shell scripts, …)
 *     is rejected and the baseline allowlist is returned unchanged.
 *   - The full command must match {@link CHECK_COMMAND_SAFE_CHAR_RE}. This
 *     excludes shell metacharacters (`;`, `&`, `|`, `>`, `<`, `` ` ``,
 *     `$`, parens, quotes, commas, newlines, backslashes, globs), so an
 *     accepted command cannot smuggle in command substitution, redirection,
 *     chaining, or break the comma-separated `--allowedTools` list.
 */

/**
 * Baseline `Bash(...)` entries that are always included. These cover the
 * historical npm setup commands and the git read-only triplet documented in
 * `docs/operations/security.md`. They are intentionally kept even when
 * CHECK_COMMAND uses a non-npm package manager — the extra entries are
 * harmless (Claude Code only invokes them when relevant) and removing them
 * would regress existing npm projects.
 */
export const BASELINE_BASH_ALLOWED_TOOLS: readonly string[] = [
  "Bash(npm ci)",
  "Bash(npm run check)",
  "Bash(npm test)",
  "Bash(npm run build)",
  "Bash(git status)",
  "Bash(git diff)",
  "Bash(git log)",
];

/**
 * First-token whitelist of CHECK_COMMAND binaries. Only commands starting
 * with one of these names are eligible to be added to `--allowedTools`.
 *
 * Selection criterion: package managers, test runners, and task runners
 * commonly used as CHECK_COMMAND. Anything that can run arbitrary shell
 * (e.g. `bash`, `sh`, `eval`) is intentionally excluded.
 */
export const CHECK_COMMAND_BINARY_WHITELIST: readonly string[] = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pnpx",
  "pytest",
  "python",
  "python3",
  "make",
  "cargo",
  "go",
  "mise",
  "task",
  "just",
];

/**
 * Characters allowed anywhere in a CHECK_COMMAND that can be promoted to a
 * `Bash(...)` entry. Excludes shell metacharacters and any character that
 * would corrupt the comma-separated `--allowedTools` list or its
 * `Bash(...)` framing.
 *
 * Allowed: ASCII alphanumerics, space, and a small set of punctuation
 * (`._-/=:@+`) that covers package manager flags (`--frozen-lockfile`),
 * scripts with colons (`make test:unit`), versioned commands
 * (`go@1.22 test`), and so on.
 */
export const CHECK_COMMAND_SAFE_CHAR_RE = /^[A-Za-z0-9 ._/=:@+\-]+$/;

export interface DerivedAllowedBashTools {
  /** Final allowlist (baseline plus CHECK_COMMAND when accepted). */
  tools: string[];
  /**
   * Reason CHECK_COMMAND was not added. `null` when it was either added
   * successfully or already covered by the baseline.
   */
  rejection: string | null;
}

/** Result of validating a CHECK_COMMAND string. */
export interface CheckCommandValidation {
  ok: boolean;
  /** Populated when `ok === false`. */
  reason?: string;
}

/**
 * Validate that a CHECK_COMMAND is safe to embed in a `Bash(...)` allowlist
 * entry. Returns `ok: false` with a short reason on rejection.
 */
export function validateCheckCommand(rawCommand: string): CheckCommandValidation {
  const command = rawCommand.trim();
  if (command.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  if (!CHECK_COMMAND_SAFE_CHAR_RE.test(command)) {
    return {
      ok: false,
      reason: "contains characters outside the safe set (shell metacharacter or quote)",
    };
  }
  const firstToken = command.split(" ")[0] ?? "";
  if (!CHECK_COMMAND_BINARY_WHITELIST.includes(firstToken)) {
    return {
      ok: false,
      reason: `binary '${firstToken}' is not in the CHECK_COMMAND whitelist`,
    };
  }
  return { ok: true };
}

/**
 * Build the final list of `Bash(...)` allowlist entries for
 * `claude-code-action`'s `--allowedTools`.
 *
 * Always returns the baseline entries. When `checkCommand` validates and
 * is not already covered, appends `Bash(<checkCommand>)`. When validation
 * fails, returns the baseline only and surfaces `rejection`.
 */
export function deriveAllowedBashTools(checkCommand: string): DerivedAllowedBashTools {
  const baseline = [...BASELINE_BASH_ALLOWED_TOOLS];
  const trimmed = checkCommand.trim();

  const validation = validateCheckCommand(trimmed);
  if (!validation.ok) {
    return { tools: baseline, rejection: validation.reason ?? "rejected" };
  }

  const entry = `Bash(${trimmed})`;
  if (baseline.includes(entry)) {
    return { tools: baseline, rejection: null };
  }
  return { tools: [...baseline, entry], rejection: null };
}

/**
 * Serialize the allowlist entries for the `--allowedTools` argument.
 *
 * Comma-separated with no spaces, matching the format
 * `loop/action.yml` already uses.
 */
export function serializeAllowedBashTools(tools: readonly string[]): string {
  return tools.join(",");
}
