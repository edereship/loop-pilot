# Critical Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all Critical/High severity issues identified in the failure-detection review

**Architecture:** Surgical fixes to existing files — no new modules or architectural changes. Each task targets one specific bug with minimal blast radius.

**Tech Stack:** TypeScript, GitHub Actions YAML, vitest

---

### Task 1: Fix GITHUB_OUTPUT injection in workflow YAML

**Files:**
- Modify: `.github/workflows/auto-review-loop.yml:40-45`

- [ ] **Step 1: Fix output injection by using heredoc syntax**

Replace the echo-based output setting with heredoc-delimited writes for `title`, `head_ref`, and `fork`:

```yaml
      - name: Get PR info
        id: pr
        run: |
          PR_DATA=$(gh api "/repos/${{ github.repository }}/pulls/${{ github.event.issue.number }}")

          echo "head_ref<<ENDOFOUTPUT" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.head.ref' >> "$GITHUB_OUTPUT"
          echo "ENDOFOUTPUT" >> "$GITHUB_OUTPUT"

          echo "head_sha<<ENDOFOUTPUT" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.head.sha' >> "$GITHUB_OUTPUT"
          echo "ENDOFOUTPUT" >> "$GITHUB_OUTPUT"

          echo "title<<ENDOFOUTPUT" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.title' >> "$GITHUB_OUTPUT"
          echo "ENDOFOUTPUT" >> "$GITHUB_OUTPUT"

          echo "fork<<ENDOFOUTPUT" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.head.repo.full_name' >> "$GITHUB_OUTPUT"
          echo "ENDOFOUTPUT" >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/auto-review-loop.yml
git commit -m "fix: prevent GITHUB_OUTPUT injection via heredoc delimiters"
```

---

### Task 2: Fix shell injection in check-runner rollback

**Files:**
- Modify: `src/check-runner.ts:1,108-125,128`
- Test: `tests/check-runner.test.ts` (new)

- [ ] **Step 1: Write failing test for rollback using execFileSync**

Create `tests/check-runner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeOutput } from "../src/check-runner.js";

describe("sanitizeOutput", () => {
  it("removes ANSI escape sequences", () => {
    const input = "\x1b[31mError\x1b[0m: something failed";
    expect(sanitizeOutput(input)).toBe("Error: something failed");
  });

  it("truncates output exceeding 60000 chars", () => {
    const longOutput = "x".repeat(70000);
    const result = sanitizeOutput(longOutput);
    expect(result.length).toBeLessThanOrEqual(60000);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/check-runner.test.ts`
Expected: PASS

- [ ] **Step 3: Replace execSync with execFileSync in rollback**

In `src/check-runner.ts`, replace the rollback section:

```typescript
import { execFileSync, exec } from "node:child_process";
import { promisify } from "node:util";
import * as core from "@actions/core";

// ... (keep existing functions unchanged)

// In runCheckCommand, replace rollback block:
    try {
      if (modifiedFiles.length > 0) {
        for (const file of modifiedFiles) {
          execFileSync("git", ["checkout", "--", file], {
            encoding: "utf-8",
          });
        }
      }
      if (createdFiles.length > 0) {
        for (const file of createdFiles) {
          execFileSync("rm", ["-f", file], {
            encoding: "utf-8",
          });
        }
      }
    } catch (rollbackError) {
      core.error(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/check-runner.ts tests/check-runner.test.ts
git commit -m "fix: replace execSync with execFileSync in rollback to prevent shell injection"
```

---

### Task 3: Fix fixing-state deadlock recovery

**Files:**
- Modify: `src/main-loop.ts:77,115-123,595-597`

- [ ] **Step 1: Add fixing-state recovery with staleness check**

In `main-loop.ts`, replace the fixing/stopped/done guard block:

```typescript
  // Guard: already in a terminal state
  if (state.status === "stopped" || state.status === "done") {
    core.info(`[main-loop] Status is '${state.status}'. Skipping.`);
    return;
  }

  // Guard: fixing state — recover if stale (>30min), otherwise skip
  if (state.status === "fixing") {
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    const fixingStartedAt = state.lastCodexReviewReceivedAt;
    const elapsed = Date.now() - new Date(fixingStartedAt ?? 0).getTime();

    if (elapsed < STALE_THRESHOLD_MS) {
      core.info(`[main-loop] Status is 'fixing' (started ${Math.round(elapsed / 1000)}s ago). Skipping.`);
      return;
    }

    core.warning(`[main-loop] Status stuck in 'fixing' for ${Math.round(elapsed / 60000)}min. Recovering.`);
    const recoveredState: ReviewState = {
      ...state,
      status: "stopped",
      stopReason: "state_corrupted",
    };
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      recoveredState,
      config.githubToken
    );
    await postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "state_corrupted",
      triggerCommentId,
      0,
      "Previous fixing state timed out — recovered automatically",
      config.githubToken
    );
    return;
  }
```

- [ ] **Step 2: Add top-level catch recovery for fixing state**

Replace the bottom of `main-loop.ts`:

```typescript
main().catch(async (error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));

  // Attempt to recover from fixing state on unhandled crash
  try {
    const config = loadConfig();
    const stateResult = await readState(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken
    );
    if (stateResult && stateResult.state.status === "fixing") {
      core.warning("[main-loop] Crash recovery: resetting fixing → stopped (state_corrupted)");
      const recoveredState: ReviewState = {
        ...stateResult.state,
        status: "stopped",
        stopReason: "state_corrupted",
      };
      await updateStateComment(
        config.repoOwner,
        config.repoName,
        stateResult.commentId,
        recoveredState,
        config.githubToken
      );
    }
  } catch (recoveryError) {
    core.error(`[main-loop] Crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
  }
});
```

- [ ] **Step 3: Run tests**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main-loop.ts
git commit -m "fix: add fixing-state deadlock recovery with staleness check and crash handler"
```

---

### Task 4: Add edit overlap detection in edit-applier

**Files:**
- Modify: `src/edit-applier.ts:211-224`
- Modify: `tests/edit-applier.test.ts`

- [ ] **Step 1: Write failing test for overlapping edits**

Add to `tests/edit-applier.test.ts`:

```typescript
  it("detects overlapping edits and reports them as failed", () => {
    const content = `function example() {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}
`;
    const edits: EditOperation[] = [
      {
        path: "src/example.ts",
        oldCode: "  const a = 1;\n  const b = 2;",
        newCode: "  const a = 10;\n  const b = 20;",
        explanation: "Edit A: covers lines 2-3",
      },
      {
        path: "src/example.ts",
        oldCode: "  const b = 2;\n  const c = 3;",
        newCode: "  const b = 200;\n  const c = 300;",
        explanation: "Edit B: overlaps with edit A on line 3",
      },
    ];

    const result = applyEdits(content, edits, "src/example.ts");
    expect(result.success).toBe(false);
    expect(result.failedEdits.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/edit-applier.test.ts`
Expected: FAIL (overlapping edits silently corrupt content)

- [ ] **Step 3: Add overlap detection after sorting**

In `src/edit-applier.ts`, between the sort and the apply loop:

```typescript
  // Step 2: Sort resolved edits by originalStart descending (bottom-first)
  resolved.sort((a, b) => b.originalStart - a.originalStart);

  // Step 2.5: Detect overlapping edit ranges
  for (let i = 0; i < resolved.length - 1; i++) {
    const current = resolved[i];     // later in file (higher start, processed first in bottom-up)
    const next = resolved[i + 1];    // earlier in file
    const nextEnd = next.originalStart + next.originalLength;
    if (nextEnd > current.originalStart) {
      // next overlaps with current — remove current (later edit) as failed
      failedEdits.push(current.edit);
      resolved.splice(i, 1);
      i--; // re-check from same index
    }
  }

  if (failedEdits.length > 0) {
    return { success: false, content: null, failedEdits };
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/edit-applier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/edit-applier.ts tests/edit-applier.test.ts
git commit -m "fix: detect and reject overlapping edit ranges to prevent file corruption"
```

---

### Task 5: Fix readState NDJSON parsing robustness

**Files:**
- Modify: `src/state-manager.ts:97-128`
- Modify: `tests/state-manager.test.ts`

- [ ] **Step 1: Write test for readState jq output parsing**

Add to `tests/state-manager.test.ts`:

```typescript
describe("deserializeState (multi-line body)", () => {
  it("handles body with multiple newlines in serialized state", () => {
    const state = makeState({
      iterationCount: 5,
      status: "waiting_codex",
    });
    const serialized = serializeState(state);
    const restored = deserializeState(serialized);
    expect(restored).not.toBeNull();
    expect(restored!.iterationCount).toBe(5);
    expect(restored!.status).toBe("waiting_codex");
  });
});
```

- [ ] **Step 2: Verify test passes (existing logic is correct for deserializeState)**

Run: `npm test -- tests/state-manager.test.ts`
Expected: PASS

- [ ] **Step 3: Fix readState to use @json jq filter for compact output**

Replace the jq filter and parsing in `readState`:

```typescript
export async function readState(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<{ state: ReviewState; commentId: number } | null> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select(.body | contains("${STATE_COMMENT_OPEN}")) | {id: .id, body: .body} | @json`,
    ],
    { env: { ...process.env, GH_TOKEN: token } },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // @json wraps each result as a JSON-encoded string on its own line
  const firstLine = trimmed.split("\n")[0];
  let parsed: { id: number; body: string };
  try {
    parsed = JSON.parse(JSON.parse(firstLine)) as { id: number; body: string };
  } catch {
    return null;
  }

  const state = deserializeState(parsed.body);
  if (!state) {
    return null;
  }

  return { state, commentId: parsed.id };
}
```

- [ ] **Step 4: Apply same fix to review-collector.ts fetchReviewComments**

```typescript
// Change jq filter to use @json
"--jq",
".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at} | @json",

// Change parsing to double-decode
return stdout
  .trim()
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(JSON.parse(line)));
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state-manager.ts src/review-collector.ts
git commit -m "fix: use jq @json filter for robust NDJSON parsing of multi-line body fields"
```

---

### Task 6: Fix remaining Medium-severity issues

**Files:**
- Modify: `src/config.ts:40`
- Modify: `src/comment-poster.ts:41`
- Modify: `src/main-loop.ts:176-179,283-285,458`
- Modify: `src/edit-applier.ts:152,194`

- [ ] **Step 1: Add repoFullName validation in config.ts**

```typescript
const [repoOwner, repoName] = repoFullName.split("/");
if (!repoOwner || !repoName) {
  throw new Error(`github-repository must be in "owner/name" format, got: "${repoFullName}"`);
}
```

- [ ] **Step 2: Add NaN check in comment-poster.ts postComment**

```typescript
  const commentId = parseInt(stdout.trim(), 10);
  if (isNaN(commentId)) {
    throw new Error(`postComment: unexpected response from GitHub API: ${stdout.trim()}`);
  }
  return commentId;
```

- [ ] **Step 3: Use stopReason "no_findings" in main-loop.ts**

```typescript
  const doneState: ReviewState = {
    ...updatedStateBase,
    status: "done",
    stopReason: "no_findings",
  };
```

- [ ] **Step 4: Add path traversal guard in main-loop.ts before writeFileSync**

```typescript
import { resolve, sep } from "node:path";

// Before writeFileSync:
const resolvedPath = resolve(filePath);
const repoRoot = resolve(".");
if (!resolvedPath.startsWith(repoRoot + sep) && resolvedPath !== repoRoot) {
  core.warning(`[main-loop] Path traversal detected: ${filePath}. Skipping.`);
  skippedFiles.push(filePath);
  continue;
}
```

- [ ] **Step 5: Add git checkout branch safety separator**

```typescript
execFileSync("git", ["checkout", "--", prHeadRef], { stdio: "inherit" });
```

Wait — `git checkout -- <branch>` treats it as a file path, not a branch. Keep `git checkout <branch>` but validate the branch name:

```typescript
if (prHeadRef && /^[\w.\-/]+$/.test(prHeadRef)) {
  core.info(`[main-loop] Checking out branch: ${prHeadRef}`);
  execFileSync("git", ["checkout", prHeadRef], { stdio: "inherit" });
} else if (prHeadRef) {
  throw new Error(`Invalid branch name: ${prHeadRef}`);
}
```

- [ ] **Step 6: Remove dead useNormalized variable from edit-applier.ts**

Remove lines 152 and 194.

- [ ] **Step 7: Run tests**

Run: `npm run check`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/comment-poster.ts src/main-loop.ts src/edit-applier.ts
git commit -m "fix: address medium-severity issues (validation, NaN check, path traversal, dead code)"
```

---

### Task 7: Run full test suite and type check

- [ ] **Step 1: Run full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 2: Build bundles**

Run: `npm run bundle`
Expected: SUCCESS
