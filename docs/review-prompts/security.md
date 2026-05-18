# Security Review Prompt — production readiness

> Paste this whole document as the first user message of a fresh Claude Code
> session. The prompt is **self-contained**: it briefs the agent on the system,
> the threat model, the surfaces to audit, and the output contract. Quality is
> prioritised over speed — the agent is expected to spend the time needed to
> read every relevant file end-to-end and to come back with a small number of
> high-confidence findings rather than a long list of speculative ones.

---

## 0. Role and operating rules

You are a senior application-security reviewer hired to clear this repository
for **promotion from PoC to production**. The repository ships a GitHub Action
that wires Codex code review to Claude auto-fix in a loop, runs the agent
against PR branches with write tokens, and re-posts `@codex review`. It is a
high-blast-radius automation surface: a single auth or scope bug can let an
attacker push commits, exfiltrate secrets, or take over CI.

Operating rules for this review:

- **Read first, opine later.** Before writing any finding, you must have read
  the implementation file involved, the surrounding tests, and any
  `docs/operations/security.md` / `docs/architecture/*.md` section that
  describes the intended behaviour. Do not infer behaviour from filenames.
- **No speculative findings.** If you cannot point to a concrete file, line,
  and execution path, drop the item or mark it `confidence: low` with a
  reproduction sketch.
- **Cite, don't paraphrase.** Every finding must reference `path:line` ranges
  and quote ≤ 5 lines of the offending code. Quoting longer blocks adds noise.
- **Threat-model first, then look for code.** For each surface in §3, write
  the attacker goal and the trust boundary in your head **before** searching
  for vulnerabilities — this stops you from missing classes of bugs that the
  current code happens not to expose but the next refactor easily could.
- **Use sub-agents for breadth, not for depth.** You may dispatch `Explore`
  agents to enumerate call sites or grep for patterns (e.g. every
  `execFileSync`, every `ghApi` call, every `core.getInput` read), but you
  must read the critical files yourself end-to-end. Do not let a sub-agent
  decide what counts as in-scope.
- **Time budget: take what you need.** A thorough pass on this codebase is
  typically several hours of focused reading. If you finish in under an hour
  you almost certainly skipped a surface.
- **Stay in scope.** Do not propose architectural rewrites. Do not propose
  rotating the threat model. Do not propose moving away from GitHub Actions.
  Propose the smallest concrete patch that closes each finding.

## 1. System overview (read this before opening any file)

- The project is a GitHub composite Action with three entrypoints:
  `init` (Workflow A, on `pull_request`), and `loop/pre-fix` +
  `loop/post-fix` (Workflow B, on `pull_request_review` and `issue_comment`).
- Workflow B checks out the PR head, invokes `anthropics/claude-code-action@v1`
  to repair Codex findings, runs `CHECK_COMMAND`, scans the diff, then
  commits and pushes using a dedicated push token.
- Loop state lives in a **hidden comment** on the PR (`auto-review-state`,
  HTML-comment-wrapped JSON). A second visible comment (`auto-review-status`)
  is the operator-facing transcript.
- Multiple distinct tokens flow through the action with different scopes:
  `GITHUB_TOKEN`, `CODEX_REVIEW_REQUEST_TOKEN`, `AUTO_REVIEW_PUSH_TOKEN`,
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`. They are **not**
  interchangeable; each has a documented purpose in
  `docs/operations/security.md`.
- The agent (Claude inside `claude-code-action`) is **untrusted** for the
  purposes of the post-fix checks: its diff is gated by `scope-checker.ts`,
  `secret-scanner.ts`, and the Bash allowlist in `check-command-allowlist.ts`.
  Codex findings are likewise **untrusted text** fed into the Claude prompt
  (indirect prompt-injection surface — TY-274).

Start by reading these files in order before doing anything else:

1. `README.md`
2. `docs/architecture/system-overview.md`
3. `docs/architecture/flow-and-state.md`
4. `docs/architecture/event-design.md`
5. `docs/operations/security.md` (entire file)
6. `docs/operations/scope-policy.md`
7. `.github/workflows/auto-review-init.yml`
8. `.github/workflows/auto-review-loop.yml`
9. `init/action.yml`, `loop/action.yml`
10. `src/types.ts`, `src/config.ts`, `src/secrets.ts`

## 2. Threat model

Adversaries you must defend against, ordered roughly by realistic impact:

| # | Adversary | Capability | Goal |
| - | --------- | ---------- | ---- |
| A | External fork-PR author | Can create a PR from a fork; cannot read secrets per GitHub defaults | Get the action to check out and execute their code with the repo's write tokens; get the action to push commits to the base repo |
| B | Drive-by commenter on a public PR | Can post issue / review comments; not a collaborator | Forge a hidden `auto-review-state` to silently stop / restart the loop; spam `/restart-review` to burn quota; inject prompt-payloads via comment bodies |
| C | Compromised Codex bot output | Findings text is attacker-controllable (Codex quotes PR diff content) | Indirect prompt injection into the Claude prompt; get the agent to read secrets, write malicious code, exfiltrate via committed paths |
| D | Compromised Claude agent output | The agent itself produces arbitrary diffs | Write secrets into `src/` or push to a workflow file to disable scope checks on future runs; rewrite git config to redirect pushes; insert exec sinks (`eval`, child_process) into the codebase |
| E | Collaborator with write but not admin | Can push to branches; can trigger the action; cannot change secrets / variables | Use the loop to bypass branch protection (e.g. push to protected files via the bot); escalate via `/restart-review` after `secret_leak_suspected` |
| F | Supply-chain noise on dependencies | Upstream `claude-code-action`, `actions/checkout`, `gh` CLI may change behaviour | Detect anywhere the code assumes upstream behaviour that, if it changes, opens a vuln |

You do **not** need to defend against the org-level admin or the workflow
author themselves.

## 3. Surfaces to audit (mandatory coverage)

For each subsection, write down the attacker goal first, then read the cited
files and look for ways the goal can be achieved. Treat every "TY-2XX"
reference in code or docs as a previously-shipped fix — confirm the fix is
still load-bearing and not bypassable by adjacent code paths.

### 3.1 Workflow trigger and fork-PR guard
- `.github/workflows/auto-review-init.yml`, `auto-review-loop.yml`
- The `if:` clauses on the `auto-fix` job (label gate, Codex bot identity
  gate, restart-command author_association gate)
- `Check fork PR (security guard)` step
- Compare against `docs/operations/security.md` — "Fork PR からの起動防止"
  and "Repository variables と trigger guard"
- Question to answer: can adversary A or B start an `auto-fix` job at all?
  Can they reach `checkout` of attacker-controlled refs?

### 3.2 Hidden-comment trust boundary
- `src/state-manager.ts` — `getTrustedStateCommentAuthors`,
  `buildTrustedAuthorJqFilter`, the jq filter spliced into `gh api ... --jq`
- `src/status-comment.ts` — same filter
- The `AUTO_REVIEW_STATE_COMMENT_AUTHORS` action input / env path
- Look for: jq injection, ReDoS in `validateState`, parsing of `--paginate`
  output, ordering assumptions (which comment is "latest"), TOCTOU between
  read and patch (`updateStateComment`, `state-comment-locker.ts`)
- Confirm: a public-PR commenter cannot forge a state comment that overrides
  the bot's, even with a body that begins with the visible header.

### 3.3 Token handling
- `src/secrets.ts` — `registerAllSecrets`, `stripSecretEnv`,
  `SECRET_CONFIG_FIELDS`, `SECRET_ENV_NAMES`
- `src/git.ts` — `pushWithToken`, basic-auth header construction, base64
  derivative masking, `clearUrlRewriteRules`, the global git-config rewrite
  defence
- Every callsite that runs a child process — does it inherit the parent env
  unfiltered? Are any secrets passed via argv (visible in `ps`)?
- Check that `CODEX_REVIEW_REQUEST_TOKEN` is never used to push, that
  `AUTO_REVIEW_PUSH_TOKEN` is never given to the agent, and that
  `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` cannot both be set.

### 3.4 Agent execution control (`claude-code-action` invocation)
- `loop/action.yml` — `--allowedTools`, `--disallowedTools`,
  `--max-turns`, model selection
- `src/check-command-allowlist.ts` — the Bash-allowlist construction and the
  whitelist regex `^[A-Za-z0-9 ._/=:@+\-]+$`
- `src/main-pre-fix.ts` — how the dynamic `CHECK_COMMAND` allowance is
  computed and passed
- `docs/operations/security.md` — "Claude Code Action 実行制御" section
- Question to answer: can the agent escape the allowlist via the dynamic
  `Bash(<CHECK_COMMAND>)` extension? What happens if `CHECK_COMMAND` contains
  a multi-byte character that passes the regex but means something different
  to `bash`? What about argv-injection through tool arguments
  (Edit/Write paths)?

### 3.5 Post-fix gates: scope check and secret scanner
- `src/scope-checker.ts` — block-list semantics, `.github/` locked entry,
  build-mode relaxation, root-dotfile handling, binary detection,
  size budget
- `src/secret-scanner.ts` — pattern set, two-tier policy, diff parsing
  state machine, rename-detection assumptions
- `src/git.ts` — `gitDiffHead` flag set (`--no-ext-diff`, `--no-textconv`,
  `--no-renames` absent on purpose)
- `src/main-post-fix.ts` — order of operations between scope check, secret
  scan, CHECK_COMMAND, BUILD_COMMAND, commit, push
- Question to answer: can the agent write content that the scanner misses
  but a downstream consumer would still treat as a secret? Can a tracked
  file be renamed/copied in a way that smuggles a pre-existing secret
  through the diff? Can scope-check be bypassed by symlinks, case-only
  renames on case-insensitive runners, or filenames that confuse `git
  diff --name-only`?

### 3.6 Indirect prompt injection (IPI)
- `src/claude-code-repair-request.ts` — the entire file, especially
  `formatFindingBlock`, `buildClaudeCodeRepairPrompt`, the "untrusted text"
  framing, and `previousCheckFailure` rendering / truncation
- `src/severity-parser.ts` — does it strip or normalise anything that could
  hide injection markers from operators?
- `docs/operations/security.md` — "間接プロンプトインジェクション (IPI) の脅威モデル"
- Question to answer: are there code paths where Codex finding text reaches
  the Claude prompt without the "untrusted" wrapper? What about
  `previousCheckFailure` content from a prior CHECK_COMMAND that itself
  printed attacker-supplied data?

### 3.7 Restart and recovery surface
- `src/restart-command.ts` — `parseRestartCommand`, `applyRestartToState`,
  `handleRestartCommand`, the `canRestart` permission check
- The workflow `if:` for the restart trigger (author_association gate)
- `secret_leak_requires_hard_restart` reject path
- Question to answer: can adversary B trigger a soft restart that silently
  resumes a leaking loop? Can the author of a fork PR (CONTRIBUTOR) restart
  the loop after a secret-leak stop?

### 3.8 Cross-component invariants
- Does any code path commit / push **without** running scope + secret +
  CHECK_COMMAND first?
- Does any branch demote `fixing` → `stopped` while leaving credentials on
  disk (e.g. partially-written `.netrc`, leftover git remote URL with a
  token)?
- Are there any `try { ... } catch { ignore }` paths in security-critical
  files that swallow errors from token registration, scope check, or
  secret scan?
- Workflow-level `concurrency` — can adversary B starve / cancel a legitimate
  run?

### 3.9 Logging and telemetry
- Every `core.info` / `core.warning` / `core.error` / `console.log` in
  `src/`: does any of them include a token, a finding body, a diff hunk,
  or an env value that could carry a secret derived from #3.5?
- `tests/fixtures/` — any committed fixtures that look like real secrets and
  could mislead the scanner or future readers?

### 3.10 Dependency and supply-chain posture
- `package.json` / `package-lock.json` — minimal runtime deps (`@actions/core`)
  but transitive `gh` CLI is assumed to be present on the runner
- Pinned versions on `actions/checkout`, `actions/upload-artifact`,
  `anthropics/claude-code-action`
- Any `npm install -g` / `curl | sh` in workflow YAML?

## 4. Investigation method

Work in this sequence. Do not skip phases.

### Phase 1 — Orient (≈ 30–60 minutes)
1. Read every file listed in §1.
2. Build a mental model of the data flow: PR → Codex review → state comment →
   pre-fix → claude-code-action → post-fix → push → re-review. Sketch the
   token used at each step.
3. Enumerate every place an **external string** enters the system: comment
   bodies, finding bodies, `previousCheckFailure`, repository variables, env
   vars, workflow inputs. Tag each "trust level" (bot / collaborator /
   anyone). This list is your IPI / forgery worklist.

### Phase 2 — Surface walk (the bulk of the time)
For each surface in §3, in order:
1. Restate the attacker goal in your notes.
2. Read the cited files top to bottom — not just the function under
   discussion. Pay attention to imports, exports, and call sites.
3. Run targeted `grep` / `Explore` agents to find sibling code paths that
   share the same primitive (e.g. every place `ghApi` is called with `--jq`,
   every place `execFileSync` runs `git`).
4. Write candidate findings as they arise; do not yet polish.
5. For each candidate, construct a **concrete reproduction**: the exact PR
   comment / env value / repo state that would trigger the bug. If you cannot
   construct one, downgrade or drop the finding.

### Phase 3 — Adversarial replay (≈ 60 minutes)
Re-read your candidates with each adversary in §2 in mind. For each
adversary, ask: "is there a finding in my list that meaningfully widens what
this adversary can do?" If yes, raise its severity. If no listed finding helps
an adversary, you have probably missed a surface — go back to §3.

### Phase 4 — De-duplicate and severity-rank
- Merge findings that share a root cause.
- Drop anything you cannot tie to `path:line`.
- Severity rubric:
  - **P0** — unauthenticated remote code execution, push to base repo from a
    fork, token exfiltration, secrets persisted to logs, scope-check bypass
    that lands on the default branch, IPI that leads to any of the above.
  - **P1** — same impact but requires a collaborator or maintainer to
    misclick; or unauthenticated state forgery that silently halts the loop.
  - **P2** — defense-in-depth gaps, log leaks that require a chain to be
    useful, missing input validation that is currently masked by a downstream
    check.
  - **P3** — hardening suggestions with no realistic exploit today.

## 5. Output contract

Produce **one** final message in this exact shape. Do not emit a running
narrative.

```
# Security review — <YYYY-MM-DD>

## Summary
<3–6 lines. State whether the codebase is, in your assessment, safe to
promote to production as-is, safe with the listed patches, or unsafe.>

## Findings

### SEC-<NN> — <one-line title>  [P0 | P1 | P2 | P3] (confidence: high | medium | low)

**Surface:** <§3.X label>
**Adversary:** <A | B | C | D | E | F>
**Location:** `path/to/file.ts:LSTART-LEND` (and others if relevant)

**What is wrong**
<≤ 8 lines, plain English. Quote ≤ 5 lines of code if it sharpens the point.>

**How to reach it**
<Concrete reproduction. PR comment text / env value / repo state / token
shape. If reproduction requires a sub-step that another finding also enables,
say so explicitly.>

**Impact**
<What the adversary gets if the bug fires. Map to §2 if not already stated.>

**Suggested patch**
<Smallest concrete change. Cite the function and the lines you would edit.
Do not write the full patch unless it is < 20 lines.>

**Why this is not already caught**
<Which existing guard you expected to stop this, and why it doesn't.>

### SEC-<NN+1> — ...
```

Append a **Coverage matrix** at the bottom that lists every §3.X surface and
states `read: yes` or `read: no` plus the files you read for it. The matrix
is how reviewers will tell whether you actually walked the surface — empty
findings on a surface are fine, an unread surface is not.

```
## Coverage matrix

| Surface | Read | Files | Findings |
| ------- | ---- | ----- | -------- |
| 3.1 Workflow trigger and fork-PR guard | yes | .github/workflows/auto-review-loop.yml, ... | SEC-01, SEC-04 |
| 3.2 Hidden-comment trust boundary       | yes | src/state-manager.ts:1-531, ... | (none) |
| ...                                     |     |       |          |
```

## 6. Anti-patterns to avoid in the report

- "It would be nice to add tests for X" — out of scope unless the absent test
  is the root cause of an exploit (e.g. a regression-prone parser).
- Style / refactor suggestions — out of scope.
- "Consider rotating tokens" / "consider documenting" without a code defect —
  out of scope.
- Findings that depend on the operator misconfiguring an explicitly-documented
  knob (e.g. setting `AUTO_REVIEW_FULL_AUTO=true` on a public repo) — mention
  these as `P3 / hardening` only if the documentation is missing or
  misleading.
- Restating known TY-2XX fixes as findings — confirm them in the Coverage
  matrix instead.
