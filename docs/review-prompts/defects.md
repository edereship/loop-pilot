# Defects / Bugs Review Prompt — production readiness

> Paste this whole document as the first user message of a fresh Claude Code
> session. The goal is to find **functional bugs, edge-case crashes, race
> conditions, and correctness regressions** in the auto-review loop before
> it is promoted from PoC to production. Quality is prioritised over speed —
> a thorough pass on this codebase takes hours and is expected to return a
> small number of high-confidence findings rather than a long list of nits.

This prompt is the **defects** companion to `security.md` and `ux.md`. Do
**not** restate security or UX findings here unless the underlying root cause
is a functional defect (e.g. a race in `state-manager` that happens to also
let an attacker forge a state — file the defect, point to the security
prompt for the impact analysis).

---

## 0. Role and operating rules

You are a senior software engineer reviewing this repository for the bugs
that would surface in production but were not caught by the existing tests
(`tests/`, ~30 files, ~88+ vitest cases). You are not looking for code-style
issues, not proposing refactors, not auditing security posture.

Operating rules:

- **Read whole files.** A bug review that reads only the function under
  discussion will miss every cross-function invariant violation. Open each
  source file once, end to end, and only then start writing findings.
- **No speculative bugs.** Every finding must be reproducible from `path:line`.
  If you cannot describe the exact inputs that trigger it, drop it or mark
  it `confidence: low` with a sketch of what is missing.
- **Tests are evidence, not absolution.** "There is a test for this" does not
  prove a function is correct — read the test, check what it actually
  asserts, and look for the boundary it does not cover. Conversely, missing
  tests are a coverage gap, not a bug, unless you can demonstrate the
  uncovered behaviour is wrong.
- **Cite, don't paraphrase.** Quote ≤ 5 lines per finding and give exact line
  ranges.
- **Dispatch sub-agents for breadth, read critical files yourself.** Use
  `Explore` agents to find every `execFileSync`, every `ghApi` callsite,
  every place a state field is written, every place an iteration counter
  changes. Read `state-manager.ts`, `main-pre-fix.ts`, `main-post-fix.ts`,
  `restart-command.ts`, `scope-checker.ts`, `secret-scanner.ts`,
  `claude-code-repair-request.ts`, `comment-poster.ts`, and `status-comment.ts`
  yourself, top to bottom.
- **Time budget: take what you need.** If you finish in under an hour you
  have almost certainly skipped a surface — the codebase has > 8 000 lines of
  TypeScript and several hundred lines of workflow YAML.
- **Smallest patch wins.** Do not propose architectural redesigns. A bug fix
  is a bug fix; refactors belong in a separate PR.

## 1. System overview (read before opening any file)

- GitHub composite Action with three entrypoints: `init/` (Workflow A on
  `pull_request`), and `loop/pre-fix` + `loop/post-fix` (Workflow B on
  `pull_request_review` and `issue_comment`).
- Loop state lives in **two** PR comments:
  - `auto-review-state` — hidden JSON, single source of truth for the state
    machine (`initialized` → `waiting_codex` → `fixing` → `done` | `stopped`).
  - `auto-review-status` — visible markdown transcript for operators.
- Each iteration: pre-fix loads state, computes findings, may transition to
  `fixing`; `claude-code-action` runs; post-fix validates the diff
  (`scope-checker` + `secret-scanner` + `CHECK_COMMAND` + optional
  `BUILD_COMMAND`), commits, pushes, re-posts `@codex review`, and writes
  the new state.
- Multiple stop reasons (`src/types.ts` `STOP_REASON_LABELS`) — loop
  termination is **not** a single happy path; each branch has its own
  notification + state mutation contract.
- The hidden state JSON has a runtime validator (`validateState` in
  `state-manager.ts`) for fields touched on the read path. Fields added in
  later TY-numbers are tolerated as optional for backward compatibility.

Read these files first, in this order:

1. `README.md`
2. `docs/architecture/system-overview.md`
3. `docs/architecture/flow-and-state.md`
4. `docs/architecture/event-design.md`
5. `docs/operations/stop-and-recovery.md`
6. `docs/operations/check-and-rollback.md`
7. `docs/specs/severity-parser.md`, `docs/specs/loop-detection.md`,
   `docs/specs/claude-code-repair-request.md`
8. `src/types.ts`, `src/config.ts`
9. `.github/workflows/auto-review-init.yml`,
   `.github/workflows/auto-review-loop.yml`

## 2. Bug classes to hunt for (mandatory coverage)

For each class, state in your notes what you are looking for **before** you
search. The labels (`BUG-CLS-X`) are referenced in §5's output contract.

### 2.1 State-machine correctness (`BUG-CLS-1`)
- Every transition out of `fixing`: is the hidden state always cleared
  (`stopReason`, `previousCheckFailure`, `fixingStartedAt`, etc.) in a way
  consistent with `applyRestartToState` expectations?
- Are there code paths that write `status: fixing` without also setting
  `fixingStartedAt`? Vice versa?
- Can `iterationCount` go negative, overflow, double-increment, or fail to
  increment on a CHECK_COMMAND retry?
- `lastProcessedReviewId` ordering vs. GitHub's review-id allocation — what
  happens if Codex re-posts a review with an older id (rerun)?
- `findingsHashHistory` trimming (`MAX_HISTORY_ENTRIES = 3`) vs. the
  loop-detector's "oscillation" check — can a hash that lives only in the
  trimmed-out tail still be the oscillation evidence?
- Crash-recovery paths (`demoteFixingOnCrash`, stale-`fixing` detector,
  workflow-level fail-safes in `auto-review-loop.yml` TY-282 / TY-283):
  do they leave a state another iteration can recover from, or do they
  paint the loop into a corner that only `/restart-review --hard` can
  unstick?

### 2.2 Concurrency / TOCTOU (`BUG-CLS-2`)
- `state-comment-locker.ts` + `updateStateComment` — the `expectedUpdatedAt`
  preflight closes a multi-second window, but the comment between
  `If-Unmodified-Since` removal note in `state-manager.ts:480-489` and the
  PATCH is unprotected. Find every place a second writer could clobber.
- GitHub `concurrency:` is at the job level — what happens when two
  `pull_request_review.submitted` events arrive within the
  `STABILIZE_INTERVAL_SECONDS` window?
- `gh api ... --paginate`: any place where the action assumes ascending
  chronological order? GitHub's documented order is "ascending creation
  time", but pagination boundaries can interleave under heavy edit traffic.
- Optimistic-lock retry in `state-comment-locker.ts` — does it loop forever
  on a permanent 412? Does it lose updates if the writer changes shape
  between reads?

### 2.3 Input parsing and validation (`BUG-CLS-3`)
- `parseRestartCommand` (`src/restart-command.ts`) — every branch of the
  multi-line normalisation. `validateState` (`src/state-manager.ts:72`) —
  every field, plus the "unknown extra fields" case.
- `severity-parser.ts` — Codex output variant handling, the `null` severity
  case, file-level findings (`line: null`).
- `parseGitNumstat` (`src/scope-checker.ts`) — rename notation,
  quoted-path notation, binary entries (`-\t-\t`).
- `parseStateCommentRecord` and the `@json` double-decode dance — what does
  it do with a body containing `\n` or `\r`?
- `findStatusComment` / `upsertStatusComment` — re-entrant safety when a
  previous run left a malformed status comment.
- Configuration: every `core.getInput` and every env-driven default in
  `src/config.ts` — what does the code do with empty strings, whitespace,
  negative numbers, `NaN`, values that parse as numbers but are outside
  realistic bounds (`MAX_REVIEW_ITERATIONS=0`, `DEBOUNCE_SECONDS=86400`)?

### 2.4 External-command invocation (`BUG-CLS-4`)
- Every `execFileSync` in `src/git.ts` and elsewhere — argument arrays vs.
  shell quoting, exit-code handling, stderr propagation, encoding (the
  default `utf-8` decode of binary content), max-buffer overflow on long
  outputs.
- `runCheckCommand` and `runBuildCommand` — child env propagation
  (`stripSecretEnv`), timeout handling, partial output capture on kill.
- `gh api` invocations through `src/gh.ts` — auth header construction,
  retries, rate-limit / 5xx handling, the `--raw-field body=...` quirk
  (TY-269) and what happens if `body` itself starts with `--`.
- Token-bearing pushes (`pushWithToken`) — what if the push half-succeeds
  (refs updated, hook rejects), what cleanup is required?

### 2.5 Diff / patch handling (`BUG-CLS-5`)
- `extractAddedContentFromUnifiedDiff` (`src/secret-scanner.ts`) — the
  state machine boundaries, `+++` real-data lines vs file headers, quoted
  paths, tab / non-ASCII filenames, CRLF normalisation, BOM handling.
- `scope-checker.ts` size budget — 20 files / 1000 lines policy, build-mode
  relaxation; does `checkScopeBuildMode` correctly enforce user-added
  patterns even when they match a default-unlocked entry?
- Untracked file enumeration vs. tracked diff — paths that appear in both?
  Symlinks? Submodules?
- Rollback paths (`resetWorkingTree` = `git reset --hard HEAD && git clean
  -ffd`) — what happens when the index has staged-and-unstaged conflicting
  state from a partial commit?

### 2.6 Time, timestamps, and timeouts (`BUG-CLS-6`)
- `nowIso()` resolution (second-truncated) vs comparisons against
  GitHub's millisecond-precision `updated_at`.
- `toHttpDate` round-trip — DST? Locale-dependent? Invalid input?
- Stale-`fixing` detection threshold — what is it, where is it enforced, and
  does the value survive `/restart-review`?
- Auto-merge polling (`autoMergePollSeconds`, `autoMergeTimeoutMinutes`) —
  off-by-one on the timeout, behaviour when `head_sha` changes mid-poll
  (force push), tie-breaking when multiple runs share a `head_sha`.
- The 90-second TY-282 dedup window — what happens at exactly 90 s?

### 2.7 Comment-body composition (`BUG-CLS-7`)
- `serializeState` 65 000-byte fallback — does the trimmed-history fallback
  still satisfy `MAX_HISTORY_ENTRIES` invariants the next iteration relies
  on?
- `truncatePreviousCheckFailure` — multi-byte truncation, what if the tail
  ends mid-escape sequence (UTF-8, ANSI colour code)?
- Status-comment entry budget (`MAX_ENTRIES = 30`,
  `MAX_ENTRY_BODY_LENGTH = 16 000`) — total body vs GitHub's 65 536-byte
  limit when both the visible history and hidden JSON-data block are
  written.
- Permalinks (`buildStatusCommentPermalink`) — repo with `.` / `~` in name,
  URL-unsafe owner names.
- gh CLI `--raw-field` (`-F`) vs `--field` (`-f`) — every callsite that
  takes a user-controllable value (any of: finding body, `previousCheckFailure`,
  Codex review text, comment bodies).

### 2.8 Loop detection and model tiering (`BUG-CLS-8`)
- `src/loop-detector.ts` + `src/findings-hash.ts` — hash stability across
  whitespace changes, ordering of findings, comment edits.
- `modelTier` propagation: legacy entries without `modelTier`,
  the rule that "directly previous match" allows escalation but
  oscillation halts (`docs/specs/loop-detection.md`).
- `src/model-selector.ts` — the four escalation reasons, the one-shot
  behaviour of `previous_max_turns_exceeded`, transitions of `stopReason`
  across iterations.

### 2.9 Recovery and notifications (`BUG-CLS-9`)
- `src/crash-recovery.ts` — `demoteFixingOnCrash`, exception swallowing,
  duplicate stop-notification windows (TY-282 #2A / #2B / TY-283).
- `comment-poster.ts` terminal notifications — dedup against the
  workflow-level fail-safe; correct stop-reason mapping.
- `/restart-review` paths — `state_corrupted` escape hatch, the
  `secret_leak_requires_hard_restart` branch, soft vs hard mode side
  effects (clearing `iterationCount`, `findingsHashHistory`, `stopReason`,
  `previousCheckFailure`, `fixingStartedAt`).

### 2.10 Backward compatibility (`BUG-CLS-10`)
- Every "added by TY-2XX, missing in legacy state" field — does the
  normalisation path in `deserializeState` cover every code path that later
  reads the field? Or are there callers that destructure before
  normalisation runs?
- Old labels / variables (`AUTO_REVIEW_BLOCK_PATHS` vs deprecated
  predecessors, `CLAUDE_CODE_MODEL` removal in TY-242, etc.) — are
  deprecation paths still wired to fail cleanly with a useful message?

### 2.11 Test/code drift (`BUG-CLS-11`)
- Tests in `tests/` that assert behaviour the code no longer implements,
  or vice versa.
- Test fixtures (`tests/fixtures/`) that lock in an incorrect format and
  hide a parser bug.
- `vitest.config.ts` / `tsconfig.test.json` — anything that would let a
  test silently skip (e.g. `testTimeout` set to 0, `pool: forks` with a
  flaky resource).

## 3. Investigation method

Work in this sequence. Do not skip phases.

### Phase 1 — Orient (≈ 30–60 min)
1. Read every file listed in §1.
2. Draw the state-machine diagram from `flow-and-state.md` on paper. Note
   every read and write of `auto-review-state`. This is your
   "where can state get corrupted" worklist.
3. Map each `StopReason` to the code path that emits it and the recovery
   path operators have. This is your "what does a stuck PR look like"
   worklist.

### Phase 2 — Class walk (the bulk of the time)
For each `BUG-CLS-X` in §2:
1. Restate the bug class in your notes.
2. Read the cited files end to end.
3. For each function, list the **preconditions** it assumes and the
   **postconditions** it promises. Then look for callers that violate the
   pre, and consumers that rely on a post the function does not actually
   guarantee.
4. Run targeted searches via `Explore` agents to find every callsite of the
   primitives you flagged. Write candidate findings; do not yet polish.
5. For each candidate, construct a **concrete reproduction**: the PR
   comment / env value / sequence of GitHub events that triggers the bug.
   If you cannot, downgrade or drop.

### Phase 3 — Test triangulation (≈ 30–60 min)
For each candidate finding, find the existing test(s) most adjacent to it:
- If a test exists and passes despite the bug, write down **why** the test
  misses the bug (input not exercised, assertion too loose, mock too
  permissive). This sharpens the finding and gives you the patch hint.
- If no test exists, note that gap in the finding's "test impact" field.
  Do not file the test gap as a separate finding.

### Phase 4 — Severity rank and de-duplicate
- Merge findings that share a root cause.
- Drop anything you cannot tie to `path:line`.
- Severity rubric:
  - **P0** — silent data loss, silent push of wrong commit / wrong branch,
    state corruption that leaves the loop stuck without operator-visible
    notification, infinite spend (loop won't terminate / can re-enter
    forever), commit of unverified diff to the PR branch.
  - **P1** — observable crash / loud failure but with operator confusion or
    iteration-budget waste; race conditions that lose updates ≤ once per
    week of normal use; recovery paths that fail under realistic conditions.
  - **P2** — rare-edge crashes (input shapes Codex / Claude rarely produce),
    log noise that obscures real failures, drift between docs and code.
  - **P3** — micro-bugs with no realistic operator impact, suggested
    hardening, missing-test gaps tied to a concrete bug class.

## 4. Output contract

Produce **one** final message in this exact shape.

```
# Defects review — <YYYY-MM-DD>

## Summary
<3–6 lines. State whether the codebase is, in your assessment, functionally
ready to promote to production as-is, ready with the listed patches, or
not ready.>

## Findings

### BUG-<NN> — <one-line title>  [P0 | P1 | P2 | P3] (confidence: high | medium | low)

**Class:** <2.X label>
**Location:** `path/to/file.ts:LSTART-LEND` (and others if relevant)

**What is wrong**
<≤ 8 lines, plain English. Quote ≤ 5 lines of code if it sharpens the point.>

**Trigger**
<Concrete inputs / sequence of events. If reproduction requires a specific
upstream behaviour (e.g. Codex emitting a particular comment shape), say so.>

**Symptom**
<What the operator sees on the PR, what state is left behind, what cost
is incurred.>

**Test impact**
<Which existing test(s) you expected to catch this and why they didn't.
"No adjacent test" is acceptable here when honest.>

**Suggested patch**
<Smallest concrete change. Cite the function and the lines you would edit.>

### BUG-<NN+1> — ...
```

Append a **Coverage matrix** at the bottom that lists every §2.X class and
states `read: yes` or `read: no` plus the files you read for it.

```
## Coverage matrix

| Class | Read | Files | Findings |
| ----- | ---- | ----- | -------- |
| 2.1 State-machine correctness | yes | src/state-manager.ts, src/main-post-fix.ts, ... | BUG-01, BUG-04 |
| 2.2 Concurrency / TOCTOU      | yes | src/state-comment-locker.ts, ... | (none) |
| ...                            |     |       |          |
```

## 5. Anti-patterns to avoid in the report

- "This file would benefit from a refactor" — out of scope.
- Style / naming nits — out of scope.
- Missing tests as a top-level finding — fold into the bug they would have
  caught (`Test impact`).
- "Consider adding observability for X" — out of scope unless the absence
  of the signal hides a bug class that has already fired.
- Findings that depend on a hypothetical future change to a dependency
  (`if claude-code-action changes its CLI flags ...`) — out of scope unless
  the project's documented assumption is already drifting.
- Restating known TY-2XX fixes as findings — confirm them in the Coverage
  matrix instead.
