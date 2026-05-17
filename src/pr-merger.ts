import { setTimeout as sleep } from "node:timers/promises";
import { ghApi } from "./gh.js";

export interface MergerLogger {
  info: (message: string) => void;
  warning: (message: string) => void;
}

/**
 * Workflow run subset that `mergeIfChecksPass` cares about. Mirrors the
 * shape returned by `GET /repos/{owner}/{repo}/actions/runs?head_sha=…`.
 */
export interface WorkflowRunSummary {
  id: number;
  /** Stable numeric identifier for the workflow definition (file). Two runs of the same
   * workflow file share the same workflow_id even if the display name is changed. */
  workflow_id: number;
  name: string;
  /** Relative path of the workflow file, e.g. `.github/workflows/ci.yml`. Unique per workflow
   * file; two files that share the same display name will have different paths. */
  path?: string;
  /** queued, in_progress, completed, waiting, requested, pending. */
  status: string;
  /** success, failure, cancelled, neutral, skipped, timed_out, action_required, startup_failure, stale, or null. */
  conclusion: string | null;
  head_sha: string;
  /** GitHub event that triggered this run (e.g. push, pull_request, workflow_dispatch). */
  event: string;
}

export interface MergerDeps {
  /** Returns the PR's current HEAD sha. */
  getPrHeadSha: (owner: string, name: string, pr: number, token: string) => Promise<string>;
  /**
   * Returns the PR's current merge commit sha, or null when unavailable.
   * `pull_request`/`pull_request_review` CI runs index themselves under this
   * sha rather than the head branch sha, so we must query both to avoid
   * missing those runs.
   */
  getPrMergeSha?: (owner: string, name: string, pr: number, token: string) => Promise<string | null>;
  /** Returns all workflow runs that target the given commit. */
  listWorkflowRuns: (
    owner: string,
    name: string,
    sha: string,
    token: string,
  ) => Promise<WorkflowRunSummary[]>;
  /**
   * Runs `gh pr merge <pr> --auto --squash --match-head-commit <sha> --repo …`.
   * Throws on failure. `expectedHeadSha` is the sha we verified the CI on;
   * `--match-head-commit` makes GitHub refuse the merge if HEAD moved
   * between our last poll and this call (race between push and merge).
   * `--auto` queues the merge when required checks are still pending (e.g.,
   * when this workflow is itself a required status check); GitHub executes the
   * queued merge once all required checks pass.
   */
  mergeSquash: (
    owner: string,
    name: string,
    pr: number,
    expectedHeadSha: string,
    token: string,
  ) => Promise<void>;
  /** Sleep helper (overridden in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Wall-clock source for the timeout budget. */
  now: () => number;
  /**
   * `GITHUB_RUN_ID` of the auto-review-loop run invoking this. The matching
   * workflow run is excluded from the pending / failure check so the loop
   * does not wait for itself. Empty string disables self-exclusion.
   */
  selfRunId: string;
  /**
   * `GITHUB_WORKFLOW` name of the auto-review-loop workflow. Used to exclude
   * all previous loop runs when the current run is not found by its run ID
   * (e.g. issue_comment triggers set GITHUB_SHA to the default-branch commit,
   * so the current run is absent from PR head/merge-sha run queries). Empty
   * string disables this name-based fallback.
   */
  selfWorkflowName: string;
  /**
   * Workflow file path extracted from `GITHUB_WORKFLOW_REF`
   * (e.g. `.github/workflows/auto-review-loop.yml`). When non-empty, used
   * together with `selfWorkflowName` in the name-based fallback to
   * disambiguate workflows that share the same display name but live in
   * different files.  Empty string falls back to name-only matching.
   */
  selfWorkflowPath: string;
  /** Poll interval between check-status reads. */
  pollIntervalMs: number;
  /** Hard budget for the entire wait. Skip + warn after this elapses. */
  timeoutMs: number;
}

/**
 * Conclusions that we treat as "CI failed" and refuse to auto-merge.
 *
 * `cancelled` is included because operators routinely cancel runs they no
 * longer trust; auto-merging a PR with a cancelled required job would be
 * surprising. `action_required` and `startup_failure` indicate the run
 * could not produce a verdict and must not be silently treated as green.
 */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

export const DEFAULT_AUTO_MERGE_POLL_INTERVAL_MS = 15 * 1000;
export const DEFAULT_AUTO_MERGE_TIMEOUT_MS = 10 * 60 * 1000;

function defaultMergerDeps(overrides: Partial<MergerDeps> = {}): MergerDeps {
  return {
    getPrHeadSha: async (owner, name, pr, token) => {
      const stdout = await ghApi(
        [
          "api",
          `/repos/${owner}/${name}/pulls/${pr}`,
          "--jq",
          ".head.sha",
        ],
        token,
      );
      return stdout.trim();
    },
    getPrMergeSha: async (owner, name, pr, token) => {
      const stdout = await ghApi(
        [
          "api",
          `/repos/${owner}/${name}/pulls/${pr}`,
          "--jq",
          ".merge_commit_sha // empty",
        ],
        token,
      );
      const trimmed = stdout.trim();
      return trimmed || null;
    },
    listWorkflowRuns: async (owner, name, sha, token) => {
      // `--paginate` follows Link headers so PRs with > 100 workflow runs
      // still surface every failure / pending entry. Without it a failure on
      // page 2+ would be invisible and re-introduce the merge-through-CI
      // bypass this guard exists to prevent.
      //
      // `gh api --paginate` concatenates each page's JSON object verbatim
      // (one object per line of stdout when the response is an object).
      // Use `--jq` to extract `workflow_runs[]` from every page and rebuild
      // the array on our side, which works regardless of how `gh` decides
      // to concatenate the page envelopes.
      const stdout = await ghApi(
        [
          "api",
          "--paginate",
          `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
          "--jq",
          ".workflow_runs[]",
        ],
        token,
      );
      const runs: WorkflowRunSummary[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          runs.push(JSON.parse(trimmed) as WorkflowRunSummary);
        } catch {
          // A line we cannot parse could be a pending/failed run; dropping it
          // would make the gate fail open.  Throw so the caller aborts the
          // merge with a warning (fail-closed).
          throw new Error(`Failed to parse workflow-run record: ${trimmed}`);
        }
      }
      return runs;
    },
    mergeSquash: async (owner, name, pr, expectedHeadSha, token) => {
      await ghApi(
        [
          "pr",
          "merge",
          String(pr),
          "--auto",
          "--squash",
          "--match-head-commit",
          expectedHeadSha,
          "--repo",
          `${owner}/${name}`,
        ],
        token,
      );
    },
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
    selfRunId: process.env.GITHUB_RUN_ID ?? "",
    selfWorkflowName: process.env.GITHUB_WORKFLOW ?? "",
    selfWorkflowPath: (() => {
      // GITHUB_WORKFLOW_REF has the form "owner/repo/.github/workflows/ci.yml@refs/…".
      // Extract just the path segment so we can match against WorkflowRunSummary.path.
      const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
      const m = ref.match(/^[^/]+\/[^/]+\/(.+)@/);
      return m ? m[1] : "";
    })(),
    pollIntervalMs: DEFAULT_AUTO_MERGE_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_AUTO_MERGE_TIMEOUT_MS,
    ...overrides,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Auto-merge guard (TY-277).
 *
 * Replaces the previous `enableAutoMergeSquash` path that delegated CI gating
 * to GitHub's native auto-merge: `gh pr merge --auto` only waits for required
 * checks defined in branch protection, so a repo without required-check
 * configuration would silently merge through a failing CI.
 *
 * Behaviour:
 *   1. Read the PR's current HEAD sha.
 *   2. List workflow runs targeting that sha; exclude the run hosting this
 *      pre-/post-fix step (`GITHUB_RUN_ID`).
 *   3. If any non-self run has a failed conclusion → skip + warn.
 *   4. If all non-self runs are completed (none failed) → `gh pr merge --squash`
 *      and return.
 *   5. Otherwise (something still pending) → sleep `pollIntervalMs` and
 *      revisit. Before each poll, re-read the HEAD sha and bail with a warning
 *      if it changed (a human pushed a new commit while we were waiting; the
 *      old CI verdict no longer reflects what would be merged).
 *   6. If the wait exceeds `timeoutMs`, skip + warn.
 *
 * All failure paths are non-fatal: the workflow finishes `success` and a
 * human can merge manually. The cost of refusing to merge is low; the cost
 * of merging through a failing CI is high.
 */
export async function mergeIfChecksPass(
  owner: string,
  name: string,
  pr: number,
  token: string,
  log: MergerLogger,
  overrides: Partial<MergerDeps> = {},
): Promise<void> {
  const deps = defaultMergerDeps(overrides);

  let initialHeadSha: string;
  try {
    initialHeadSha = await deps.getPrHeadSha(owner, name, pr, token);
  } catch (err) {
    log.warning(
      `[pr-merger] Skipping auto-merge for PR #${pr}: failed to read PR HEAD sha (${errMessage(err)}).`,
    );
    return;
  }
  if (initialHeadSha === "") {
    log.warning(
      `[pr-merger] Skipping auto-merge for PR #${pr}: empty HEAD sha.`,
    );
    return;
  }

  log.info(
    `[pr-merger] Auto-merge check for PR #${pr} at ${initialHeadSha} (poll ${Math.round(deps.pollIntervalMs / 1000)}s, timeout ${Math.round(deps.timeoutMs / 60000)} min).`,
  );

  const startedAt = deps.now();
  let pollCount = 0;

  while (true) {
    if (pollCount > 0) {
      // Re-read HEAD sha so a new push during the wait aborts the auto-merge
      // instead of using stale CI evidence.
      let currentSha: string;
      try {
        currentSha = await deps.getPrHeadSha(owner, name, pr, token);
      } catch (err) {
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to re-read PR HEAD during polling (${errMessage(err)}).`,
        );
        return;
      }
      if (currentSha !== initialHeadSha) {
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: PR HEAD changed during CI wait (${initialHeadSha} → ${currentSha}). The new commit needs its own review/CI cycle; re-trigger via /restart-review.`,
        );
        return;
      }
    }

    let runs: WorkflowRunSummary[];
    try {
      runs = await deps.listWorkflowRuns(owner, name, initialHeadSha, token);
    } catch (err) {
      log.warning(
        `[pr-merger] Skipping auto-merge for PR #${pr}: failed to list workflow runs (${errMessage(err)}).`,
      );
      return;
    }

    // Re-read the merge commit sha each iteration so that base-branch moves
    // (which change the merge ref even when PR HEAD is unchanged) are reflected
    // in the run query rather than evaluated against a stale sha.
    let mergeSha: string | null = null;
    // True when getPrMergeSha is available but returned null/empty, meaning
    // GitHub has not yet computed the merge commit sha (transient state).
    // While this flag is set we must not apply the "two empty polls = no CI"
    // shortcut: repos whose CI runs only on the pull_request merge ref would
    // produce zero runs for the head sha during this window and could be
    // merged prematurely.
    let mergeShaLookupNull = false;
    if (deps.getPrMergeSha) {
      try {
        const ms = await deps.getPrMergeSha(owner, name, pr, token);
        if (ms && ms !== initialHeadSha) {
          mergeSha = ms;
        } else if (!ms) {
          mergeShaLookupNull = true;
        }
      } catch (err) {
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to read PR merge commit sha (${errMessage(err)}).`,
        );
        return;
      }
    }

    // Combine with runs indexed under the merge commit sha (pull_request CI).
    let allRuns = runs;
    if (mergeSha) {
      let mergeRuns: WorkflowRunSummary[];
      try {
        mergeRuns = await deps.listWorkflowRuns(owner, name, mergeSha, token);
      } catch (err) {
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to list workflow runs (${errMessage(err)}).`,
        );
        return;
      }
      const seenIds = new Set(runs.map((r) => r.id));
      allRuns = [...runs];
      for (const r of mergeRuns) {
        if (!seenIds.has(r.id)) allRuns.push(r);
      }
    }

    // Exclude the auto-review-loop workflow entirely (not just the current run)
    // so that previous loop attempts on the same commit (e.g. transient infra
    // failures that left a `failure`/`cancelled` conclusion) do not permanently
    // block auto-merge. We identify the loop's workflow by the workflow_id of
    // the current run; if the current run isn't in the list (e.g. issue_comment
    // triggers set GITHUB_SHA to the default-branch commit, not the PR HEAD SHA,
    // so the current run is absent from the head/merge-sha run queries), infer
    // our workflow's id from a stale loop run visible in the list. workflow_id
    // is a stable numeric identifier per workflow file and is unique across
    // different files even when they share the same display name, so filtering
    // by it avoids incorrectly excluding a different workflow that happens to
    // have the same name as the loop workflow.
    const selfWorkflowId = deps.selfRunId !== ""
      ? allRuns.find((r) => String(r.id) === deps.selfRunId)?.workflow_id
      : undefined;

    const others: WorkflowRunSummary[] = selfWorkflowId !== undefined
      ? allRuns.filter((r) => r.workflow_id !== selfWorkflowId)
      : deps.selfRunId !== "" && deps.selfWorkflowName !== ""
        ? (() => {
            // Self run absent from list (e.g. issue_comment trigger). Infer our
            // workflow's stable id from the first matching stale run. When
            // selfWorkflowPath is available (from GITHUB_WORKFLOW_REF) we
            // require the run's path to match as well, so a different workflow
            // file that happens to share the same display name is not
            // incorrectly identified as ours and excluded.
            const inferredId = allRuns.find((r) =>
              r.name === deps.selfWorkflowName &&
              (deps.selfWorkflowPath === "" || r.path === undefined || r.path.replace(/@.*$/, "") === deps.selfWorkflowPath)
            )?.workflow_id;
            return inferredId !== undefined
              ? allRuns.filter((r) => r.workflow_id !== inferredId)
              : allRuns;
          })()
        : deps.selfRunId !== ""
          ? allRuns.filter((r) => String(r.id) !== deps.selfRunId)
          : allRuns;

    // Keep only the latest run per (workflow_id, event) pair so that an older
    // failed run that was subsequently re-triggered succeeding does not
    // permanently block auto-merge. Re-runs share the same event type as the
    // original run, so they're collapsed correctly. Two concurrent runs of the
    // same workflow file triggered by *different* events (e.g. push and
    // pull_request) are treated as independent entries and both evaluated —
    // collapsing them by workflow_id alone would allow a failure on one event
    // to be hidden by a success on another, making this gate fail-open.
    const latestByWorkflowAndEvent = new Map<string, WorkflowRunSummary>();
    for (const r of others) {
      const key = `${r.workflow_id}:${r.event}`;
      const existing = latestByWorkflowAndEvent.get(key);
      if (!existing || r.id > existing.id) {
        latestByWorkflowAndEvent.set(key, r);
      }
    }
    const deduped = Array.from(latestByWorkflowAndEvent.values());

    const failed = deduped.filter(
      (r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion),
    );
    if (failed.length > 0) {
      const names = failed
        .map((r) => `${r.name} (${r.conclusion})`)
        .join(", ");
      log.warning(
        `[pr-merger] Skipping auto-merge for PR #${pr}: ${failed.length} CI run(s) failed: ${names}.`,
      );
      return;
    }

    const pending = deduped.filter((r) => r.status !== "completed");
    // P2: merge when all current runs are complete (no pending). If there are
    // no non-self runs yet, wait two poll intervals before merging so that CI
    // workflows that haven't been queued yet (queue delay, API lag) get a
    // chance to appear. A single empty poll is insufficient because the first
    // retry can still return zero runs on repos with delayed CI. After two
    // consecutive empty polls (pollCount >= 2), treat absence as "no CI
    // configured" and merge unconditionally.
    const elapsedMs = deps.now() - startedAt;
    if (elapsedMs >= deps.timeoutMs) {
      if (others.length === 0) {
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: timed out after ${Math.round(deps.timeoutMs / 60000)} min waiting for non-self CI runs to appear.`,
        );
      } else {
        const pendingNames = pending.map((r) => r.name).join(", ");
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: timed out after ${Math.round(deps.timeoutMs / 60000)} min with ${pending.length} CI run(s) still pending: ${pendingNames}.`,
        );
      }
      return;
    }

    if (pending.length === 0 && !mergeShaLookupNull && (others.length > 0 || pollCount >= 2)) {
      try {
        await deps.mergeSquash(owner, name, pr, initialHeadSha, token);
        log.info(
          `[pr-merger] Auto-merge (squash) succeeded for PR #${pr} at ${initialHeadSha}.`,
        );
      } catch (err) {
        log.warning(
          `[pr-merger] Failed to merge PR #${pr} (non-fatal): ${errMessage(err)}.`,
        );
      }
      return;
    }
    // others.length === 0 and pollCount < 2: CI may not have been queued yet;
    // fall through to sleep and retry.

    pollCount += 1;
    if (others.length === 0) {
      log.info(
        `[pr-merger] Waiting for non-self CI runs to appear for PR #${pr} (poll ${pollCount}).`,
      );
    } else {
      const pendingNames = pending.map((r) => r.name).join(", ");
      log.info(
        `[pr-merger] Waiting for ${pending.length} CI run(s) on PR #${pr} (poll ${pollCount}): ${pendingNames}.`,
      );
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}
