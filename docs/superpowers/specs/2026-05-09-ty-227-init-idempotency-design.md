# TY-227 Workflow A Init Idempotency Design

## Goal

Prevent duplicate `@codex review` requests when Workflow A receives both `pull_request.opened` and `pull_request.labeled` for the same PR creation, while keeping the existing label-gated and full-auto trigger semantics.

## Decisions

- Keep Workflow A triggers as `opened`, `ready_for_review`, and `labeled`.
- Add PR-scoped Workflow A `init` job concurrency with `cancel-in-progress: false` so near-simultaneous init jobs are serialized without unrelated skipped label events replacing a pending init job.
- Make `src/main-init.ts` idempotent:
  - If an existing valid state is `waiting_codex`, `fixing`, `done`, or `stopped`, exit without resetting state and without posting `@codex review`.
  - If an existing valid state is `initialized`, treat it as incomplete initialization and continue posting `@codex review`.
  - Keep current corrupted-state recovery: overwrite the corrupted state with a fresh state and continue initialization.
- Keep full-auto semantics label-independent:
  - Draft PRs do not start init.
  - Non-draft same-repository PRs start init on `opened` or `ready_for_review`.
  - `labeled` events remain ignored under full-auto mode.
- Keep default-strict semantics label-gated:
  - Draft PRs do not start init.
  - Non-draft PRs start when the gate label is already present on `opened` / `ready_for_review`.
  - Non-draft PRs start when the gate label is added via `labeled`.

## Test Strategy

- Add unit coverage around the init decision so existing progressed/terminal states become no-op and `initialized` still resumes initialization.
- Add workflow text assertions for job-level PR-scoped concurrency and the existing trigger guards that encode the default-strict and full-auto cases.
- Keep tests independent of live GitHub APIs by mocking `readState`, `updateStateComment`, `createStateComment`, and `postCodexReviewRequest`.

## Out of Scope

- Changing the trigger set.
- Changing corrupted-state recovery behavior.
- Changing `/restart-review` behavior, except allowing explicit `/restart-review --hard` recovery from `fixing` so Workflow A can remain a no-op for that state.
- Live E2E validation beyond creating the PR with the gate label.
