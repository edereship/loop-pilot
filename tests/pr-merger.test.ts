import { describe, expect, it } from "vitest";
import {
  mergeIfChecksPass,
  type MergerDeps,
  type WorkflowRunSummary,
} from "../src/pr-merger.js";

function captureLog() {
  const calls: { level: "info" | "warning"; message: string }[] = [];
  return {
    log: {
      info: (message: string) => calls.push({ level: "info", message }),
      warning: (message: string) => calls.push({ level: "warning", message }),
    },
    calls,
  };
}

// Stable mapping from workflow display name to a numeric workflow_id so that
// same-named workflows in tests get the same id without requiring callers to
// pass it explicitly.  Tests that need two distinct workflows with the same
// display name can pass an explicit workflowId override.
const _nameToWfId = new Map<string, number>();
let _nextWfId = 1;

function run(
  id: number,
  name: string,
  status: WorkflowRunSummary["status"],
  conclusion: WorkflowRunSummary["conclusion"],
  headSha = "abc123",
  workflowId?: number,
  event = "push",
): WorkflowRunSummary {
  if (workflowId === undefined) {
    if (!_nameToWfId.has(name)) _nameToWfId.set(name, _nextWfId++);
    workflowId = _nameToWfId.get(name)!;
  }
  return { id, workflow_id: workflowId, name, status, conclusion, head_sha: headSha, event };
}

interface FakeDeps {
  getPrHeadShaCalls: number;
  listCalls: number;
  mergeCalls: number;
  /** sha passed to each mergeSquash call (in order). */
  mergeShas: string[];
  sleepCalls: number[];
  deps: Partial<MergerDeps>;
}

function makeDeps(opts: {
  headShas?: string[];
  workflowRunPages: WorkflowRunSummary[][];
  mergeShouldFail?: boolean;
  selfRunId?: string;
  selfWorkflowName?: string;
  selfWorkflowPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Increment per poll loop iteration. */
  clockTickMs?: number;
}): FakeDeps {
  const headShas = opts.headShas ?? ["abc123"];
  let headIdx = 0;
  let runsIdx = 0;
  const record: FakeDeps = {
    getPrHeadShaCalls: 0,
    listCalls: 0,
    mergeCalls: 0,
    mergeShas: [],
    sleepCalls: [],
    deps: {},
  };
  let clock = 0;
  record.deps = {
    getPrHeadSha: async () => {
      record.getPrHeadShaCalls += 1;
      const sha = headShas[Math.min(headIdx, headShas.length - 1)];
      headIdx += 1;
      return sha;
    },
    // Omit getPrMergeSha so we only query by head sha; prevents a second
    // listWorkflowRuns call per poll that would skew listCalls counts and
    // duplicate test run pages. Tests that need merge-sha behaviour must
    // supply getPrMergeSha explicitly in opts (not yet supported by this
    // factory — pass it via mergeIfChecksPass overrides directly).
    getPrMergeSha: undefined,
    listWorkflowRuns: async () => {
      record.listCalls += 1;
      const page = opts.workflowRunPages[Math.min(runsIdx, opts.workflowRunPages.length - 1)];
      runsIdx += 1;
      return page;
    },
    mergeSquash: async (_o, _n, _pr, sha) => {
      record.mergeCalls += 1;
      record.mergeShas.push(sha);
      if (opts.mergeShouldFail) {
        throw new Error("not mergeable");
      }
    },
    sleep: async (ms: number) => {
      record.sleepCalls.push(ms);
      clock += opts.clockTickMs ?? ms;
    },
    now: () => clock,
    selfRunId: opts.selfRunId ?? "",
    selfWorkflowName: opts.selfWorkflowName ?? "",
    selfWorkflowPath: opts.selfWorkflowPath ?? "",
    pollIntervalMs: opts.pollIntervalMs ?? 100,
    timeoutMs: opts.timeoutMs ?? 60_000,
  };
  return record;
}

describe("mergeIfChecksPass — green path", () => {
  it("merges when all workflow runs are completed/success", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    // Codex P1: mergeSquash must receive the verified HEAD sha so the
    // downstream `gh pr merge --match-head-commit` can refuse a race-win
    // push that landed after the last polling read.
    expect(fake.mergeShas).toEqual(["abc123"]);
    expect(fake.sleepCalls).toEqual([]);
    expect(calls.some((c) => c.level === "info" && c.message.includes("succeeded"))).toBe(true);
  });

  it("treats neutral / skipped conclusions as success", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),
        run(2, "neutral-job", "completed", "neutral"),
        run(3, "skipped-job", "completed", "skipped"),
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("excludes the loop's own workflow run (GITHUB_RUN_ID) from the wait", async () => {
    // Without self-exclusion the loop would block waiting for the run it
    // is currently inside, which can never complete.
    const fake = makeDeps({
      workflowRunPages: [[
        run(999, "auto-review-loop", "in_progress", null), // self
        run(1, "ci", "completed", "success"),
      ]],
      selfRunId: "999",
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });
});

describe("mergeIfChecksPass — superseded runs (P1)", () => {
  it("ignores an older failed run when a later re-run of the same workflow succeeded", async () => {
    // GitHub returns all historical runs for a SHA. A workflow re-triggered
    // after a transient failure produces a new run (higher id) with a success
    // conclusion while the old failed run remains in the list. Only the latest
    // run per workflow should be evaluated.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "failure"),   // older, superseded
        run(2, "ci", "completed", "success"),   // newer re-run
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("treats the latest run as failed even when an older run for the same workflow succeeded", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),   // older successful run
        run(2, "ci", "completed", "failure"),   // newer run (now failing)
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });
});

describe("mergeIfChecksPass — workflow_id deduplication", () => {
  it("treats two distinct workflow files with the same display name as independent runs", async () => {
    // Two different .yml files can share the same `name:` field.  With name-
    // based deduplication one would silently overwrite the other, potentially
    // dropping a failing run and allowing the merge to proceed.  Using
    // workflow_id (stable per file) ensures both are evaluated independently.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 101),  // workflow file A: failing
        run(2, "CI", "completed", "success", "abc123", 102),  // workflow file B: succeeding
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });
});

describe("mergeIfChecksPass — concurrent event triggers (P1)", () => {
  it("blocks merge when same workflow fails for one trigger event even if it succeeds for another", async () => {
    // Same workflow file can be triggered by multiple events (e.g. push and
    // pull_request) simultaneously for the same head_sha. Deduplicating only
    // by workflow_id would keep just the run with the higher id (success) and
    // silently drop the push-triggered failure, making this gate fail-open.
    // Deduplicating by (workflow_id, event) evaluates each trigger independently.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 10, "push"),
        run(2, "CI", "completed", "success", "abc123", 10, "pull_request"),
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("allows merge when a re-run of the same workflow and event succeeds after an earlier failure", async () => {
    // A manual re-run produces a new run (higher id) with the same event type.
    // The old failed run should be superseded by the newer successful re-run.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 10, "push"),  // superseded
        run(2, "CI", "completed", "success", "abc123", 10, "push"),  // re-run success
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });
});

describe("mergeIfChecksPass — failure path", () => {
  it("refuses to merge when any non-self run has a failure conclusion", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),
        run(2, "build", "completed", "failure"),
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toContain("Skipping auto-merge");
    expect(warning?.message).toContain("build (failure)");
  });

  it.each([
    ["cancelled"],
    ["timed_out"],
    ["action_required"],
    ["startup_failure"],
    ["stale"],
  ])("treats %s as a failure", async (conclusion) => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", conclusion)]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(
      calls.find((c) => c.level === "warning")?.message,
    ).toContain(conclusion);
  });
});

describe("mergeIfChecksPass — polling path", () => {
  it("polls until a pending run completes successfully, then merges", async () => {
    const fake = makeDeps({
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "success")],
      ],
      pollIntervalMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.listCalls).toBe(3);
    expect(fake.sleepCalls).toEqual([100, 100]);
    expect(fake.mergeCalls).toBe(1);
    expect(calls.some((c) => c.message.includes("Waiting for"))).toBe(true);
  });

  it("polls until a pending run completes with failure, then skips", async () => {
    const fake = makeDeps({
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "failure")],
      ],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(
      calls.find((c) => c.level === "warning")?.message,
    ).toContain("failure");
  });

  it("skips with a timeout warning when CI exceeds timeoutMs", async () => {
    // 100ms poll interval, clock advances 100ms per sleep, 250ms budget →
    // after 3 polls (200ms wall time) the next failure check triggers timeout.
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "in_progress", null)]],
      pollIntervalMs: 100,
      timeoutMs: 250,
      clockTickMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toMatch(/timed out after/);
  });

  it("aborts when PR HEAD sha changes during polling", async () => {
    const fake = makeDeps({
      headShas: ["abc123", "def456"],
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "success")],
      ],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toContain("HEAD changed");
    expect(warning?.message).toContain("abc123");
    expect(warning?.message).toContain("def456");
  });
});

describe("mergeIfChecksPass — error handling", () => {
  it("skips with a warning when the initial HEAD sha read fails", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => {
        throw new Error("network down");
      },
      listWorkflowRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to read PR HEAD sha",
    );
  });

  it("skips with a warning when listWorkflowRuns fails", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      listWorkflowRuns: async () => {
        throw new Error("rate limit");
      },
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to list workflow runs",
    );
  });

  it("warns (non-fatal) when mergeSquash itself fails", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
      mergeShouldFail: true,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toMatch(/Failed to merge PR #42 \(non-fatal\)/);
  });

  it("skips when initial HEAD sha is empty", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "",
      listWorkflowRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "empty HEAD sha",
    );
  });
});

describe("mergeIfChecksPass — no other runs", () => {
  it("polls until a non-self CI run appears, then merges", async () => {
    // Guard against the race where this workflow checks CI status before
    // other workflows for the same HEAD have been created in the Actions API.
    const fake = makeDeps({
      workflowRunPages: [
        // First poll: only the self run is visible.
        [run(999, "auto-review-loop", "in_progress", null)],
        // Second poll: a non-self CI run appears and has completed.
        [run(999, "auto-review-loop", "in_progress", null), run(1, "ci", "completed", "success")],
      ],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(1);
  });

  it("merges after two grace polls when no non-self CI runs ever appear", async () => {
    // Repos that have no workflows besides the auto-review loop should be
    // able to merge without waiting for the full timeout. A single empty poll
    // is insufficient because CI with queue delays can still return zero runs
    // on the first retry. After two consecutive empty poll intervals the
    // absence of other runs is treated as "no CI configured" and auto-merge proceeds.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "auto-review-loop", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(2);
  });

  it("does not apply two-poll no-CI shortcut after timeout has elapsed", async () => {
    // Bug scenario: pollIntervalMs=40s, timeoutMs=60s — after two sleeps the
    // elapsed time (80s) exceeds the timeout, so the no-CI shortcut (pollCount>=2)
    // must NOT trigger a merge. The timeout guard must be checked before the
    // merge condition.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "auto-review-loop", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 40_000,
      timeoutMs: 60_000,
      clockTickMs: 40_000,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toMatch(/timed out after/);
  });
});

describe("mergeIfChecksPass — getPrMergeSha error handling (Finding 1)", () => {
  it("skips with a warning when getPrMergeSha throws (fail-closed)", async () => {
    // A transient API failure for the merge-sha lookup must abort rather than
    // silently continue with head-sha runs only: on repos whose CI runs against
    // the merge ref, proceeding without the merge sha would leave others empty
    // and the two-empty-polls path could merge without ever validating CI.
    const { log, calls } = captureLog();
    let listCalls = 0;

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => { throw new Error("rate-limit"); },
      listWorkflowRuns: async () => { listCalls += 1; return [run(1, "ci", "completed", "success")]; },
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(listCalls).toBe(1);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to read PR merge commit sha",
    );
  });
});

describe("mergeIfChecksPass — merge sha pending (Finding 2)", () => {
  it("does not apply two-poll shortcut while getPrMergeSha returns null", async () => {
    // GitHub can return null for merge_commit_sha while it computes the merge
    // ref in the background. Repos that run CI only on pull_request (merge
    // ref) produce zero runs under the head sha during this window. The
    // two-empty-polls shortcut must not fire while the merge sha is null.
    let mergeShaCallCount = 0;
    let listCalls = 0;
    let mergeCalls = 0;
    const clock = { t: 0 };

    await mergeIfChecksPass("o", "r", 42, "tok", { info: () => {}, warning: () => {} }, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => {
        mergeShaCallCount += 1;
        // Return null for first two calls (GitHub still computing), then a real sha.
        if (mergeShaCallCount <= 2) return null;
        return "merge-sha-xyz";
      },
      listWorkflowRuns: async (_o, _n, sha) => {
        listCalls += 1;
        // Only return a success run when queried for the merge sha.
        if (sha === "merge-sha-xyz") return [run(1, "ci", "completed", "success")];
        return [];
      },
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 100; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 60_000,
    });

    // Should have merged after merge sha became available (3rd call).
    expect(mergeCalls).toBe(1);
    // Must NOT have merged on the 2nd or earlier poll while merge sha was null.
    expect(mergeShaCallCount).toBeGreaterThanOrEqual(3);
  });

  it("blocks merge when getPrMergeSha returns null even if head-SHA runs are complete", async () => {
    // When getPrMergeSha is configured and returns null, GitHub is still
    // computing the merge ref. CI that runs only on the merge ref has not
    // appeared yet — even if head-SHA runs are already complete.  Merging on
    // `others.length > 0` alone would bypass those merge-ref checks.
    let mergeShaCallCount = 0;
    let mergeCalls = 0;
    const clock = { t: 0 };

    await mergeIfChecksPass("o", "r", 42, "tok", { info: () => {}, warning: () => {} }, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => {
        mergeShaCallCount += 1;
        // Return null for first two calls, then a real sha.
        if (mergeShaCallCount <= 2) return null;
        return "merge-sha-xyz";
      },
      listWorkflowRuns: async (_o, _n, sha) => {
        // Head-SHA already has a completed success run from the start.
        if (sha === "abc123") return [run(2, "lint", "completed", "success")];
        if (sha === "merge-sha-xyz") return [run(3, "ci", "completed", "success")];
        return [];
      },
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 100; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 60_000,
    });

    // Must have merged only after merge sha became available (3rd call).
    expect(mergeCalls).toBe(1);
    expect(mergeShaCallCount).toBeGreaterThanOrEqual(3);
  });

  it("still applies two-poll shortcut when getPrMergeSha is not provided", async () => {
    // When the dep is absent entirely (no merge-ref CI expected), the
    // two-empty-polls shortcut must still work so repos without CI can merge.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "auto-review-loop", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    // makeDeps sets getPrMergeSha: undefined, so the shortcut is not gated.
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(2);
  });
});

describe("mergeIfChecksPass — workflow-name self-exclusion fallback (Finding 3)", () => {
  it("excludes loop runs by workflow name when self run ID is not in the run list", async () => {
    // When triggered via issue_comment, GITHUB_SHA is the default-branch
    // commit, so the current run (ID 999) is absent from the PR head/merge-sha
    // run queries. The name-based fallback must remove all loop runs so that a
    // stale failure from a prior trigger does not block the merge.
    const fake = makeDeps({
      workflowRunPages: [[
        run(100, "auto-review-loop", "completed", "failure"),  // stale loop run, not current
        run(1, "ci", "completed", "success"),                   // real CI run
      ]],
      selfRunId: "999",         // current run is NOT in the list
      selfWorkflowName: "auto-review-loop",
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("blocks merge when a non-loop run fails even with the workflow-name fallback active", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(100, "auto-review-loop", "completed", "failure"),  // stale loop, should be excluded
        run(1, "ci", "completed", "failure"),                   // real CI failure
      ]],
      selfRunId: "999",
      selfWorkflowName: "auto-review-loop",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("uses path to disambiguate when two workflow files share the same display name", async () => {
    // A different CI workflow happens to have the same display name "auto-review-loop"
    // but lives at a different file path and has a different workflow_id. Without
    // path-based disambiguation the wrong workflow would be excluded, letting a
    // real CI failure through. With selfWorkflowPath set, only runs whose path
    // matches are treated as self-runs and excluded.
    const loopRun: WorkflowRunSummary = {
      id: 100,
      workflow_id: 10,
      name: "auto-review-loop",
      path: ".github/workflows/auto-review-loop.yml",
      status: "completed",
      conclusion: "failure",
      head_sha: "abc123",
      event: "push",
    };
    const impostor: WorkflowRunSummary = {
      id: 200,
      workflow_id: 20,  // different workflow file, same display name
      name: "auto-review-loop",
      path: ".github/workflows/other-ci.yml",
      status: "completed",
      conclusion: "failure",  // this failure must NOT be excluded
      head_sha: "abc123",
      event: "push",
    };
    const fake = makeDeps({
      workflowRunPages: [[loopRun, impostor]],
      selfRunId: "999",              // current run is NOT in the list
      selfWorkflowName: "auto-review-loop",
      selfWorkflowPath: ".github/workflows/auto-review-loop.yml",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    // The impostor's failure must block the merge.
    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("strips @ref suffix from workflow run path before comparing to selfWorkflowPath", async () => {
    // The GitHub Actions API returns workflow_runs[].path with a @ref suffix
    // (e.g. ".github/workflows/auto-review-loop.yml@refs/heads/main"), whereas
    // selfWorkflowPath is derived from GITHUB_WORKFLOW_REF with the @ref part
    // stripped. Without normalisation the equality check always fails and the
    // loop workflow is not excluded, causing stale loop failures to block merge.
    const loopRun: WorkflowRunSummary = {
      id: 100,
      workflow_id: 10,
      name: "auto-review-loop",
      path: ".github/workflows/auto-review-loop.yml@refs/heads/main",
      status: "completed",
      conclusion: "failure",
      head_sha: "abc123",
      event: "push",
    };
    const ciRun: WorkflowRunSummary = {
      id: 200,
      workflow_id: 20,
      name: "CI",
      path: ".github/workflows/ci.yml@refs/heads/main",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      event: "push",
    };
    const fake = makeDeps({
      workflowRunPages: [[loopRun, ciRun]],
      selfRunId: "999",              // current run is NOT in the list
      selfWorkflowName: "auto-review-loop",
      selfWorkflowPath: ".github/workflows/auto-review-loop.yml",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    // loopRun should be excluded (it's ours); ciRun is green → merge proceeds.
    expect(fake.mergeCalls).toBe(1);
    expect(calls.find((c) => c.level === "warning")).toBeUndefined();
  });
});
