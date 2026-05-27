import { ghApi } from "./gh.js";

export type FetchPrLabelsFn = (
  owner: string,
  name: string,
  pr: number,
  token: string,
) => Promise<string[]>;

/**
 * Fetch the current label names attached to a PR.
 * Uses gh API so that label changes between trigger time and run time
 * (e.g., a maintainer removed the LoopPilot label) are observed.
 */
export const fetchPrLabels: FetchPrLabelsFn = async (
  owner,
  name,
  pr,
  token,
) => {
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/labels`,
      "--paginate",
      "--jq",
      ".[].name",
    ],
    token,
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/**
 * Check whether a PR currently carries the gate label.
 *
 * Caller responsibilities:
 * - Decide whether the gate applies at all (e.g., skip when full-auto mode is on).
 * - Resolve the effective label name (e.g., apply DEFAULT_LOOPPILOT_LABEL when the
 *   user-configured value is empty) before calling.
 *
 * Matching is case-insensitive to align with the workflow YAML `contains()` check
 * and avoid a state where the workflow triggers but the runtime gate skips fixes.
 *
 * Fail-safe: an empty `requiredLabel` returns false (a misconfigured caller should
 * not silently bypass the gate).
 */
export function isAutoReviewAllowed(
  requiredLabel: string,
  currentLabels: readonly string[],
): boolean {
  if (requiredLabel === "") return false;
  const normalized = requiredLabel.toLowerCase();
  return currentLabels.some((label) => label.toLowerCase() === normalized);
}
