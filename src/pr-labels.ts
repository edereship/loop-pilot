import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";

const execFileAsync = promisify(execFile);

export type FetchPrLabelsFn = (
  owner: string,
  name: string,
  pr: number,
  token: string,
) => Promise<string[]>;

/**
 * Fetch the current label names attached to a PR.
 * Uses gh API so that label changes between trigger time and run time
 * (e.g., a maintainer removed the auto-review label) are observed.
 */
export const fetchPrLabels: FetchPrLabelsFn = async (
  owner,
  name,
  pr,
  token,
) => {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/labels`,
      "--paginate",
      "--jq",
      ".[].name",
    ],
    { env: buildGhEnv(token) },
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/**
 * Decide whether the auto-review loop should proceed for a PR.
 *
 * - When `requiredLabel` is empty, gating is disabled (preserves PoC behavior).
 * - When `requiredLabel` is set, the PR must currently carry that label.
 *   Labels are matched case-sensitively to align with GitHub's label semantics.
 */
export function isAutoReviewAllowed(
  requiredLabel: string,
  currentLabels: readonly string[],
): boolean {
  if (requiredLabel === "") return true;
  return currentLabels.includes(requiredLabel);
}
