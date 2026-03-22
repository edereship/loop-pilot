import { execFileSync, exec } from "node:child_process";
import { promisify } from "node:util";
import * as core from "@actions/core";

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
 */
function removeAnsiSequences(output: string): string {
  return output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
    const anyError = error as any;
    const stdout = anyError.stdout ? String(anyError.stdout) : "";
    const stderr = anyError.stderr ? String(anyError.stderr) : "";
    const message = anyError.message || String(error);
    return [stdout, stderr, message];
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
 * - On failure: rolls back modified files via `git checkout -- <file>`,
 *   then returns sanitized error output
 */
export async function runCheckCommand(
  checkCommand: string,
  modifiedFiles: string[]
): Promise<CheckResult> {
  // Strip sensitive env vars to prevent exfiltration via malicious check commands.
  // Use denylist approach: remove all known secret-bearing keys.
  // GITHUB_TOKEN / GH_TOKEN carry contents:write scope and must not leak.
  const safeEnv = { ...process.env };
  delete safeEnv.ANTHROPIC_API_KEY;
  delete safeEnv.GITHUB_TOKEN;
  delete safeEnv.GH_TOKEN;
  // GitHub Actions passes action inputs as INPUT_<NAME> env vars
  for (const key of Object.keys(safeEnv)) {
    if (key.startsWith("INPUT_ANTHROPIC") || key.startsWith("INPUT_GITHUB")) {
      delete safeEnv[key];
    }
  }

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
    // Rollback on failure
    try {
      // Rollback modified files using execFileSync to prevent shell injection
      if (modifiedFiles.length > 0) {
        for (const file of modifiedFiles) {
          execFileSync("git", ["checkout", "--", file], {
            encoding: "utf-8",
          });
        }
      }

    } catch (rollbackError) {
      core.error(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }

    // Extract error details
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
