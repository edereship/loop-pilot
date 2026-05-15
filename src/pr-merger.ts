import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";

const execFileAsync = promisify(execFile);

export interface MergerLogger {
  info: (message: string) => void;
  warning: (message: string) => void;
}

/**
 * Enable GitHub native auto-merge (squash) for the given PR.
 *
 * Uses `gh pr merge --auto --squash`, which queues the PR to merge once
 * required status checks pass and branch protection rules are satisfied.
 * Any failure (already-merged PR, branch protection disallowed, repo settings
 * blocking auto-merge, missing token scope) is logged as a warning and
 * swallowed: a stuck auto-merge must never block the loop from finishing
 * cleanly or prevent a human from merging manually.
 */
export async function enableAutoMergeSquash(
  owner: string,
  name: string,
  pr: number,
  token: string,
  log: MergerLogger,
): Promise<void> {
  try {
    await execFileAsync(
      "gh",
      ["pr", "merge", String(pr), "--auto", "--squash", "--repo", `${owner}/${name}`],
      { env: buildGhEnv(token) },
    );
    log.info(`[pr-merger] Auto-merge (squash) enabled for PR #${pr}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warning(
      `[pr-merger] Failed to enable auto-merge for PR #${pr} (non-fatal): ${message}`,
    );
  }
}
