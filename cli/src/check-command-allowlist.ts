/**
 * CHECK_COMMAND safety validation for the CLI (TY-346).
 *
 * VENDORED from the action's `src/check-command-allowlist.ts` (ADR-0001: the CLI
 * lives in a separate repo and deliberately does not import action code). Keep
 * the whitelist, safe-char regex, and the `validateCheckCommand` semantics in
 * sync with the source of truth; the test mirrors the action's cases so drift
 * surfaces in CI.
 *
 * The CLI only needs the *validation* half (warn/reject an unsafe CHECK_COMMAND
 * before writing it into a generated caller / suggesting it). The action-side
 * `deriveAllowedBashTools` / `Bash(...)` framing is not needed here.
 */

/** First-token whitelist of CHECK_COMMAND binaries. */
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
 * Characters allowed anywhere in a CHECK_COMMAND. Excludes shell
 * metacharacters and anything that would corrupt the comma-separated
 * `--allowedTools` list the action builds from this command.
 */
export const CHECK_COMMAND_SAFE_CHAR_RE = /^[A-Za-z0-9 ._/=:@+\-]+$/;

export interface CheckCommandValidation {
  ok: boolean;
  /** Populated when `ok === false`. */
  reason?: string;
}

/**
 * Validate that a CHECK_COMMAND is safe. Mirrors the action's rules so the CLI
 * never suggests / writes a command the action would reject at runtime.
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
