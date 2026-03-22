import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSeverity } from "./severity-parser";
import type { Finding, RawReviewComment } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Fetches PR inline review comments from GitHub API using the gh CLI.
 *
 * Why NDJSON via --jq: gh's --paginate flag accumulates pages into a single
 * JSON array by default, which can exhaust memory for large PRs. Streaming
 * one object per line (NDJSON) via .[] | {...} keeps memory usage constant.
 */
export async function fetchReviewComments(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string
): Promise<RawReviewComment[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
      "--paginate",
      "--jq",
      ".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at}",
    ],
    { env: { ...process.env, GH_TOKEN: githubToken } }
  );

  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Filters raw review comments by bot login and timestamp, parses severity,
 * and returns only P0/P1 findings.
 *
 * Why strict greater-than for timestamp: a comment received exactly at
 * lastReceivedAt was already processed in the previous iteration.
 */
export function filterAndParseComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null
): Finding[] {
  return comments
    .filter((comment) => comment.user.login === botLogin)
    .filter(
      (comment) =>
        lastReceivedAt === null || comment.createdAt > lastReceivedAt
    )
    .flatMap((comment) => {
      const parsed = parseSeverity(comment.body);
      if (parsed.severity !== "P0" && parsed.severity !== "P1") {
        return [];
      }
      const finding: Finding = {
        severity: parsed.severity,
        path: comment.path,
        line: comment.line ?? 0,
        title: parsed.title,
        body: parsed.body,
      };
      return [finding];
    });
}
