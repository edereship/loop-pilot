# UX Review Prompt — production readiness

> Paste this whole document as the first user message of a fresh Claude Code
> session. The goal is to find every **operator-facing UX defect** that would
> hurt adoption, slow incident response, or confuse a maintainer who has
> never seen this codebase before. Quality is prioritised over speed —
> a thorough pass requires reading every PR comment template, every workflow
> input description, every stop-reason label, and every doc page. Expect
> hours, not minutes.

This prompt is the **UX** companion to `security.md` and `defects.md`. Do
**not** file security or correctness bugs here; cross-link to the other
prompts when relevant.

---

## 0. Who the "user" is in this codebase

This Action is consumed by **two distinct user personas**. A finding that
hurts either one is in scope.

### Persona 1 — Operator (the dominant user)
A maintainer / on-call engineer at a repository that has installed the
Action. They interact with the system through:
- The PR timeline: hidden state comment, visible status comment, terminal
  notification comments, fix-summary comments, re-`@codex review` posts,
  CHECK_COMMAND failure comments.
- Workflow logs in the Actions UI (`core.info` / `warning` / `error`).
- Repository variables and secrets (configuration knobs).
- The `/restart-review` slash command (and its `--hard` variant).

Their decisions: "is the loop healthy?", "do I need to intervene?", "how do
I unstick this PR?", "is the next iteration going to cost me?", "did the
agent push a commit I should review?".

### Persona 2 — Installer (rare but high-leverage)
A repository owner setting up the Action for the first time. They interact
through:
- `README.md` quickstart.
- `init/action.yml` / `loop/action.yml` input descriptions.
- The two workflow examples in `README.md` and in `.github/workflows/`.
- `docs/` (deep reference, not skimmed end-to-end).

Their decisions: "which token do I need?", "what permissions?", "does this
action gate cleanly off a label?", "can I dry-run this?".

You are **not** auditing for the agent's UX (Claude is not a user here).

## 1. Operating rules

- **Walk the system as the operator would.** Open a PR mentally. Imagine
  the first event — `pull_request.opened`. Read every comment the Action
  produces, in order, and ask: "if I had never seen this Action before,
  would I know what to do next?".
- **Read whole files.** Comment templates live next to non-template code in
  `comment-poster.ts`, `status-comment.ts`, and `restart-command.ts`. Read
  each file end-to-end so you see every wording the system can emit, not
  just the first one.
- **No speculative UX gripes.** Every finding must cite the exact wording
  (with `path:line`) and propose a concrete replacement string. "This could
  be clearer" without a rewrite is not a finding.
- **Distinguish UX defects from defects/security.** If a stop reason is
  emitted incorrectly (wrong reason for the situation), that is a
  **defect**, file it through `defects.md`. If the stop reason is correct
  but the label / wording / suggested next action is unhelpful, that is a
  **UX defect**, file it here.
- **Quality over speed.** A real UX walkthrough takes several hours. If
  you finish in under an hour you almost certainly skipped a path.
- **Smallest patch wins.** Do not propose redesigning the comment system or
  switching to a dashboard. UX fixes are usually: a different word, a
  reordered field, a missing link, a better default.

## 2. Surfaces to audit (mandatory coverage)

### 2.1 First-run installation (Persona 2)
- `README.md` — does the quickstart make it obvious which token is required,
  which is optional, and what happens if the operator forgets one? Does the
  reader hit a working state at the end of the quickstart, or are there
  unstated prerequisites (variable defaults, repo settings, label setup)?
- `init/action.yml` and `loop/action.yml` — every `description:` and every
  `default:`. Are descriptions written for the installer or for the
  maintainer? Do dangerous defaults (`AUTO_REVIEW_FULL_AUTO=true`,
  `MAX_REVIEW_ITERATIONS=20`, `AUTO_REVIEW_AUTO_MERGE=true`) get warned
  about?
- Are the **error messages on missing required inputs** clear enough that
  the operator can fix them without opening the source code? Run a mental
  `npm run check` with a deliberately misconfigured workflow and trace what
  the operator sees.
- Compare README quickstart against `.github/workflows/auto-review-init.yml`
  and `.github/workflows/auto-review-loop.yml` — do they drift?

### 2.2 Steady-state PR timeline (Persona 1)
Walk a full happy-path PR mentally:
1. PR opened with the auto-review label.
2. `init` posts the hidden state comment and the initial `@codex review`.
3. Codex review arrives.
4. Loop pre-fix decides to act, posts a "fixing" status entry.
5. claude-code-action runs.
6. Post-fix runs CHECK_COMMAND, commits, pushes, re-posts `@codex review`.
7. Codex returns "no major issues".
8. Loop transitions to `done`, posts the terminal notification.

For each step, look at the visible PR comments and ask:
- Does the operator know which Action emitted each comment, and why?
- Is there a noisy comment-storm (multiple notifications for one event)?
- Is the **status comment** the canonical place to look, or does the
  operator need to scroll through 10 PR comments to reconstruct state?
- Are timestamps useful (UTC, second precision, parseable)? Do entries say
  *when* something happened, not just *that* it happened?
- Are commit SHAs surfaced in operator-readable form (short + linked) or
  just as a raw 40-char hash?

Now walk the **unhappy paths**:
- CHECK_COMMAND fails: is the failure tail (`previousCheckFailure`)
  surfaced to the operator in a way they can act on, or only to the agent?
- Scope violation: is it clear *which* path was blocked and *why* (locked
  vs. default block vs. user-added block)?
- Secret leak suspected: is the operator told exactly what to do, including
  the warning that `/restart-review` (soft) will be rejected?
- Loop detected: does the explanation differentiate "same finding tried with
  base tier, retrying with escalated" from "real oscillation, stopping"?
- `max_turns_exceeded`: does the operator understand whether to bump
  `CLAUDE_CODE_MAX_TURNS` or to expect escalation on retry?
- Workflow crash / fail-safe (TY-282 #2A / #2B / TY-283): does the
  operator see a single coherent notification, or two slightly different
  comments fired by different fail-safes?

### 2.3 Status comment (`auto-review-status`)
- `src/status-comment.ts` — the `renderStatusCommentBodyUnchecked` output.
- Field-by-field: `Current`, `Last commit`, `Open findings`, `Next action`.
  Are these the right four headers? Is `Next action` always a real
  imperative the operator can do, or sometimes a tautology?
- 30-entry cap, 16 000-char per-entry cap — when the comment hits either
  cap, what does the operator see? Is the truncation marker discoverable?
- Permalinks — `buildStatusCommentPermalink`. Do all terminal notifications
  link back to the status comment for full history?
- Is there a clear "this Action is healthy, no action needed" steady state
  the operator can recognise at a glance?

### 2.4 Stop-reason labels (`src/types.ts` `STOP_REASON_LABELS`)
- Read every label string. For each, ask:
  - Does it tell the operator **what happened** (cause) **and** **what to
    do** (next step)?
  - Is the language consistent across labels (verb tense, voice, length)?
  - Does the label translate well to a notification subject line, where
    the operator may only see the first ≤ 80 characters?
- `STOP_REASON_LABELS` is the only source of truth for these strings —
  check that `comment-poster.ts` / `status-comment.ts` use it everywhere
  and don't re-spell stop reasons inline.

### 2.5 Slash commands and recovery (`src/restart-command.ts`)
- `/restart-review` and `/restart-review --hard` — does the system tell the
  operator the difference *before* they run the command, not just after?
- Error wording on the rejection paths:
  - `unsupported_option`
  - `unsupported_status`
  - `state_corrupted`
  - `secret_leak_requires_hard_restart`
  - permission-check rejection (`canRestart` false)
- Is the rejection comment actionable ("you need --hard because ...") or
  just diagnostic ("status was foo")?
- When a fork-PR author runs `/restart-review`, what happens? Is the
  rejection message kind without being misleading?

### 2.6 Notifications and noise
- Every code path that posts a top-level PR comment via `postComment` or
  the workflow YAML's fail-safe steps. Are they de-duplicated correctly
  (TY-282 90 s window)?
- When a PR has been in the loop for 5 iterations, how many comments are on
  the timeline? Is it overwhelming?
- Is there a place where adding a single emoji + label upgrade (e.g.
  `✅ Auto-review completed`, `🛑 Auto-review stopped`, `⚠️ Auto-review init
  failed`) would make the timeline scannable, and is the existing usage
  consistent?

### 2.7 Documentation discoverability and accuracy
- `docs/README.md` — is the entry point clear for: "I'm onboarding the
  Action", "I'm debugging a stuck PR", "I'm tuning costs"?
- `docs/operations/stop-and-recovery.md` — does every `STOP_REASON_LABELS`
  key have a recovery section? Are the recovery sections kept in sync
  with the code (`src/restart-command.ts`)?
- `docs/operations/scope-policy.md` — does it explain the
  `AUTO_REVIEW_BLOCK_PATHS=!<path>` syntax with an example for every common
  case (re-enable `dist/`, lock down `Justfile`, etc.)?
- Runbooks — are there step-by-step recovery procedures, or only design
  rationale? An operator should be able to recover a stuck PR from the
  docs alone in under 5 minutes.
- Drift between docs and code — every `vars.*` and `secrets.*` mentioned in
  docs should still exist in `config.ts`; every code-side knob should still
  be documented.

### 2.8 Repository variable / secret naming and defaults
- Is the set of `AUTO_REVIEW_*` variables internally consistent
  (`AUTO_REVIEW_LABEL`, `AUTO_REVIEW_FULL_AUTO`, `AUTO_REVIEW_BLOCK_PATHS`,
  `AUTO_REVIEW_PUSH_TOKEN`, `AUTO_REVIEW_SEVERITY_THRESHOLD`,
  `AUTO_REVIEW_AUTO_MERGE`, `AUTO_REVIEW_RESTART_ROLES`,
  `AUTO_REVIEW_STATE_COMMENT_AUTHORS`)?
- Are defaults safe-by-default (label gate on, full-auto off, auto-merge
  off, push-token recommended-not-required)? Where the default is unsafe,
  is there a prominent doc warning?
- Do variable names imply the right scope (per-repo, per-PR, etc.)?
- Are there variables that share a prefix but feel like they belong to
  different subsystems (suggesting renaming or grouping)?

### 2.9 Cost and quota visibility
- Does the operator see how many iterations have been spent vs the budget
  in the status comment?
- Does the operator see which model tier was used for each iteration?
- When `auto-review-fix` label is added to a PR that already has a long
  history, does the operator get a "this will cost ≈ $X" estimate? (If
  the answer is "no and that's intentional", the answer should at least be
  in the docs.)
- `codex_usage_limit` handling — when Codex quota fires, does the operator
  know it's a quota problem (resolvable by waiting / upgrading) and not a
  bug they need to debug?

### 2.10 Internationalisation
- The docs are primarily in Japanese; the comment templates are in English.
  Operators in mixed-language teams will see both. Is the English in the
  comment templates correct, idiomatic, and unambiguous? (Specifically:
  past tense vs progressive, "auto-fix" vs "auto-review", "stopped" vs
  "halted" vs "paused".)
- Check `src/comment-poster.ts` `STOP_REASON_LABELS` and the workflow YAML
  inline `BODY=$'...'` strings.

## 3. Investigation method

Work in this sequence. Do not skip phases.

### Phase 1 — Persona walks (≈ 60 min)
1. **Installer walk.** Open `README.md` from scratch. Pretend you have
   never used this Action. Try to follow the quickstart, *writing down
   every place you would have asked a question*. Look at the input
   descriptions in `init/action.yml` / `loop/action.yml`. Trace each
   `${{ vars.* }}` and `${{ secrets.* }}` reference.
2. **Operator happy-path walk.** Read every comment template (`comment-poster.ts`,
   `status-comment.ts`, and the inline `BODY=` strings in
   `.github/workflows/*.yml`). Sequence them as they would appear in a
   green PR run. Write down every wording that would confuse a maintainer
   skimming on mobile.
3. **Operator unhappy-path walks.** For each `StopReason` in `src/types.ts`,
   reconstruct the operator's view: the status comment, the terminal
   notification, the recommended recovery. Mark every reason whose
   recovery story is incomplete, contradictory, or buried in docs.

### Phase 2 — Surface walk (the bulk of the time)
Walk each §2.X surface and capture candidate findings as you go. Always
quote the exact existing wording and propose the exact replacement.

### Phase 3 — Severity rank and dedupe
- Merge findings that share a root cause (e.g. one inconsistent stop label
  shows up in 4 places — file one finding with all 4 locations).
- Severity rubric:
  - **P0** — operator cannot recover a stuck PR from docs + PR comments
    alone; installer cannot complete setup without reading source code;
    notification is silent on a state the operator must respond to.
  - **P1** — operator can recover, but the path is non-obvious; comment
    noise / contradiction wastes ≥ 5 minutes per incident; misleading
    label that would cause an operator to do the wrong thing.
  - **P2** — confusing wording that doesn't change behaviour, missing
    cross-link, inconsistent verb tense across labels.
  - **P3** — micro-copy polish, capitalisation, punctuation, emoji
    consistency.

## 4. Output contract

Produce **one** final message in this exact shape.

```
# UX review — <YYYY-MM-DD>

## Summary
<3–6 lines. State whether the codebase's operator-facing surface is, in your
assessment, ready to promote to production as-is, ready with the listed
patches, or not ready.>

## Findings

### UX-<NN> — <one-line title>  [P0 | P1 | P2 | P3] (confidence: high | medium | low)

**Persona:** <Operator | Installer | Both>
**Surface:** <§2.X label>
**Location:** `path/to/file:LSTART-LEND` (every place the wording / behaviour appears)

**Current behaviour**
<≤ 5 lines. Quote the exact wording or describe what the operator sees.>

**Why it hurts**
<≤ 5 lines. What decision does the operator (or installer) get wrong, slow,
or stuck on? Tie it to a concrete situation, not a feeling.>

**Proposed change**
<Exact replacement wording, or an exact sequence change. If the fix is a
default change, name the default's current value and the proposed value.>

**Affected callers / docs to sync**
<Every other file that holds a copy of this wording or a contradicting
description. Missing sync is a separate finding only when it is independent.>

### UX-<NN+1> — ...
```

Append a **Coverage matrix** at the bottom that lists every §2.X surface
and states `walked: yes` or `walked: no` plus the files / artefacts you
walked for it.

```
## Coverage matrix

| Surface | Walked | Artefacts | Findings |
| ------- | ------ | --------- | -------- |
| 2.1 First-run installation | yes | README.md, init/action.yml, loop/action.yml | UX-01 |
| 2.2 Steady-state PR timeline | yes | src/comment-poster.ts, src/status-comment.ts, .github/workflows/*.yml | UX-03, UX-04 |
| ...                          |     |     |     |
```

## 5. Anti-patterns to avoid in the report

- "We should redesign the status comment" — out of scope. Propose the
  smallest copy / field change that makes the existing design work.
- Style preferences ("I would phrase this differently") with no operator
  cost — out of scope.
- "Add a dashboard / Slack integration" — out of scope. Use only the
  GitHub surface.
- Docs-only nits without operator impact — fold them into the surface
  finding they affect, not as standalone findings.
- Restating a defect (wrong stop reason, wrong recovery path) as a UX
  problem — file in `defects.md` and cross-link.
- Findings that boil down to "missing translation" — only file if the
  English / Japanese mismatch causes a concrete operator misstep.
