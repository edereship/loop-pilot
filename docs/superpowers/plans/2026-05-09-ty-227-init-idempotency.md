# TY-227 Workflow A Init Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate `@codex review` requests from near-simultaneous Workflow A runs while preserving label-gated and full-auto trigger semantics.

**Architecture:** Add a small exported `runInit` entry point that accepts loaded config and dependency functions, keeping CLI behavior intact while making init behavior unit-testable. Serialize Workflow A per PR with GitHub Actions job-level concurrency. Keep workflow trigger conditions unchanged except for concurrency.

**Tech Stack:** TypeScript, Vitest, GitHub Actions YAML, existing `gh`-based state manager.

---

### Task 1: Test Init Idempotency

**Files:**
- Create: `tests/main-init.test.ts`
- Modify: `src/main-init.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/main-init.test.ts` with tests that call `runInit` using fake dependencies:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../src/state-manager.js";
import type { Config } from "../src/config.js";
import { runInit } from "../src/main-init.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 90,
  checkCommand: "npm run check",
  maxFilesPerIteration: 10,
  maxInputTokensPerFile: 30000,
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 10,
  stabilizeCount: 3,
  codexReviewMarker: "Codex Review",
  codexReviewRequestToken: "codex-token",
  anthropicApiKey: "",
  githubToken: "github-token",
  repoOwner: "team-yubune",
  repoName: "test-auto-ai-review",
  prNumber: 227,
  triggerCommentId: 0,
  triggerCommentBody: "",
  triggerUserLogin: "",
  prHeadRef: "linear/TY-227",
  prTitle: "TY-227",
  autoReviewLabel: "",
  autoReviewFullAuto: false,
  autoReviewRestartRoles: "author,write,maintain,admin",
};
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/main-init.test.ts`

Expected: fail because `runInit` is not exported.

- [ ] **Step 3: Implement minimal injectable init runner**

Export `runInit(config, deps)` from `src/main-init.ts`. Use existing modules as default dependencies for CLI execution.

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run tests/main-init.test.ts`

Expected: pass.

### Task 2: Add Workflow A Concurrency Tests and YAML

**Files:**
- Modify: `.github/workflows/auto-review-init.yml`
- Modify: `tests/workflow-trigger.test.ts`

- [ ] **Step 1: Write failing workflow assertion**

Add assertions that Workflow A contains `jobs.init.concurrency`, groups by PR number, and uses `cancel-in-progress: false`.

- [ ] **Step 2: Run targeted workflow tests and verify failure**

Run: `npx vitest run tests/workflow-trigger.test.ts`

Expected: fail because concurrency is absent.

- [ ] **Step 3: Add concurrency to Workflow A**

Add under `jobs.init`:

```yaml
concurrency:
  group: auto-review-init-${{ github.repository }}-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

- [ ] **Step 4: Verify targeted workflow tests pass**

Run: `npx vitest run tests/workflow-trigger.test.ts`

Expected: pass.

### Task 3: Docs and Verification

**Files:**
- Modify: `docs/architecture/event-design.md`
- Modify: `docs/operations/security.md`

- [ ] **Step 1: Document init idempotency**

Update architecture docs to state Workflow A is serialized per PR and no-ops when state already progressed past `initialized`.

- [ ] **Step 2: Run verification**

Run:

```bash
npm run check
npm run bundle
npx vitest run tests/main-init.test.ts tests/workflow-trigger.test.ts
git diff --check
```

Expected: all commands exit 0.
