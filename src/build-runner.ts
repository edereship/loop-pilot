import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeOutput } from "./check-runner.js";
import { stripSecretEnv } from "./secrets.js";

const execAsync = promisify(exec);

export interface BuildResult {
  success: boolean;
  output: string;
}

/**
 * Execute the post-fix `build-command` (TY-281). Mirrors `runCheckCommand`
 * in terms of secret stripping, output sanitization, and timeout — but does
 * not perform any per-path rollback. The outer post-fix flow handles
 * working-tree reset on failure via `resetWorkingTree`, which also cleans
 * up any partial artifacts the build may have written.
 */
export async function runBuildCommand(buildCommand: string): Promise<BuildResult> {
  const safeEnv = stripSecretEnv(process.env);

  try {
    const { stdout, stderr } = await execAsync(buildCommand, {
      timeout: 5 * 60 * 1000,
      maxBuffer: 100 * 1024 * 1024,
      encoding: "utf-8",
      env: safeEnv,
    });
    const combined = stdout + (stderr ? "\n" + stderr : "");
    return { success: true, output: sanitizeOutput(combined) };
  } catch (error) {
    const anyError = error as { stdout?: string; stderr?: string; message?: string };
    const stdout = anyError.stdout ? String(anyError.stdout) : "";
    const stderr = anyError.stderr ? String(anyError.stderr) : "";
    const message = anyError.message ? String(anyError.message) : String(error);
    const combined =
      stdout + (stderr ? "\n" + stderr : "") + "\nError: " + message;
    return { success: false, output: sanitizeOutput(combined) };
  }
}
