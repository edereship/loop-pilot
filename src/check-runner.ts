import { exec } from "node:child_process";
import { promisify } from "node:util";
import { stripSecretEnv } from "./secrets.js";

const execAsync = promisify(exec);

export interface CheckResult {
  success: boolean;
  output: string;
}

/**
 * Remove ANSI escape sequences from output string.
 *
 * Why: Terminal output contains ANSI color codes that pollute logs.
 * We strip them for cleaner output storage and display.
 *
 * TY-275 #7: covers more than the basic CSI SGR subset. Each alternative:
 *   1. CSI sequences (`ESC [ ... <letter>`). Parameters include digits, `;`
 *      separators, AND private-parameter markers `?`, `>`, `<`, `=` used by
 *      modes like `\x1b[?1049h` (alternate-screen). The previous regex
 *      missed these and left bare `?...h` in the output.
 *   2. OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`) used by terminals
 *      to set titles, hyperlinks, etc. Often emitted by progress reporters.
 *   3. Two-byte ESC-prefixed sequences for charset designation
 *      (`\x1b(B`, `\x1b)0`, …) emitted by some shells before / after
 *      mode-switching.
 */
function removeAnsiSequences(output: string): string {
  return output.replace(
    /\x1b\[[\d;?><=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g,
    "",
  );
}

/**
 * Truncate output while preserving first and last lines if over 60000 chars.
 *
 * Strategy:
 * - Keep first 20 lines (head)
 * - Add "... (truncated) ..." marker
 * - Keep last 50 lines (tail)
 * - Slice to 60000 chars max
 */
function truncateIfNeeded(output: string): string {
  if (output.length <= 60000) {
    return output;
  }

  const lines = output.split("\n");
  const headLines = lines.slice(0, 20).join("\n");
  const tailLines = lines.slice(-50).join("\n");
  const marker = "\n... (truncated) ...\n";

  let result = headLines + marker + tailLines;

  if (result.length > 60000) {
    result = result.slice(0, 60000);
  }

  return result;
}

/**
 * Sanitize output by removing ANSI sequences and truncating if necessary.
 */
export function sanitizeOutput(output: string): string {
  const cleaned = removeAnsiSequences(output);
  return truncateIfNeeded(cleaned);
}

/**
 * Extract stdout, stderr, and error message from an execution error.
 *
 * Returns tuple: [stdout, stderr, errorMessage]
 */
function extractErrorOutput(
  error: unknown
): [string, string, string] {
  if (error instanceof Error) {
    // TY-276 #6: narrow the exec-error shape instead of `as any`. node's exec
    // attaches stdout / stderr as `unknown`-typed properties to the thrown
    // Error; everything else falls through to `String(error)`.
    const exec = error as Error & { stdout?: unknown; stderr?: unknown };
    const stdout = exec.stdout !== undefined ? String(exec.stdout) : "";
    const stderr = exec.stderr !== undefined ? String(exec.stderr) : "";
    return [stdout, stderr, exec.message || String(error)];
  }

  return ["", "", String(error)];
}

/**
 * Execute a check command and return the result.
 *
 * Behavior:
 * - Runs checkCommand via shell with 5min timeout
 * - Sensitive env vars (ANTHROPIC_API_KEY, INPUT_ANTHROPIC*) are stripped
 * - On success: returns sanitized stdout + stderr
 * - On failure: returns sanitized error output. The caller (post-fix) is
 *   responsible for reverting the working tree via `resetWorkingTree`
 *   (`git reset --hard HEAD && git clean -ffd`). Earlier versions of this
 *   function also did a per-file `git checkout -- <file>` rollback for the
 *   `modifiedFiles` argument, but that duplicated post-fix's reset and could
 *   leave partial restores when the per-file loop failed mid-way (TY-276 #2).
 */
export async function runCheckCommand(
  checkCommand: string,
): Promise<CheckResult> {
  // Strip sensitive env vars to prevent exfiltration via malicious check commands.
  // The denylist is centralized in `secrets.ts` so a new Config-level secret
  // (TY-264) is automatically removed from both child env and setSecret
  // registration. All `INPUT_*` action inputs are also stripped as
  // defense-in-depth — CHECK_COMMAND runs as user code, not as the action.
  const safeEnv = stripSecretEnv(process.env);

  try {
    const { stdout, stderr } = await execAsync(checkCommand, {
      timeout: 5 * 60 * 1000, // 5 minutes in milliseconds
      encoding: "utf-8",
      env: safeEnv,
    });

    const combinedOutput = stdout + (stderr ? "\n" + stderr : "");
    return {
      success: true,
      output: sanitizeOutput(combinedOutput),
    };
  } catch (error) {
    const [stdout, stderr, errorMessage] = extractErrorOutput(error);
    const combinedOutput =
      stdout +
      (stderr ? "\n" + stderr : "") +
      (errorMessage ? "\nError: " + errorMessage : "");

    return {
      success: false,
      output: sanitizeOutput(combinedOutput),
    };
  }
}
