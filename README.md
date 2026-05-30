# LoopPilot

**English** | [日本語](README.ja.md)

> AI review-fix loop for GitHub pull requests — runs a loop of Codex review × Claude auto-fix as a GitHub Action.

LoopPilot is a GitHub Action that, when a PR is opened, asks Codex (`chatgpt-codex-connector[bot]`) for a code review, and has [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) auto-fix the P0–P3 findings Codex returns. After every fix it runs `CHECK_COMMAND` (default `npm run check`), and any fix that fails to satisfy the scope policy, hard-block, size budget, or secret scanner is reverted. When findings run out it stops with `done`; if they can't be resolved or the iteration limit is reached it stops with `stopped`. Both outcomes are surfaced via a status comment on the PR and notifications.

For design details, see [`docs/README.md`](docs/README.md).

## How it works

1. **Workflow A (init)** — when a PR is opened and passes the gate, LoopPilot is initialized and posts the first `@codex review`.
2. **Codex** performs the code review and returns a summary comment and inline comments.
3. **Workflow B (loop)** — detects the Codex review, then `claude-code-action` fixes the findings → `CHECK_COMMAND` → scope / secret check → commit / push → `@codex review` again.
4. Steps 2–3 repeat until there are no findings, ending with `done` (optionally auto-merge). On reaching the limit, being unable to fix, a scope violation, etc., it stops with `stopped`.

Fork PRs are disabled by the security guards in both workflows (only PRs from the same repository are targeted).

## Prerequisites

- A repository with GitHub Actions enabled where **commit / push to PRs in the same repository is permitted**.
- The target repository has the **ChatGPT Codex GitHub integration (Codex GitHub App)** installed, so that a review is triggered by `@codex review`.
- An **Anthropic API key** or a **Claude Code subscription OAuth token** (either one).
- A toolchain that can run `CHECK_COMMAND`. The default is Node.js / npm. To use pytest, go test, make, etc., switch via the caller's `language` input (`node` / `python` / `go` / `rust` / `none`).
- For required tokens and permissions, see [Tokens & required permissions](#tokens--required-permissions-fine-grained-pat).

## Quickstart

There are two ways to install. Either the **`gh looppilot` CLI (recommended, one command)** or **manually pasting in the thin callers**. In both cases, only the Codex GitHub App integration and injecting secrets are manual steps (the CLI walks you through them). Finally, perform [Before your first PR (manual steps)](#before-your-first-pr-manual-steps).

### 1. Install with the `gh looppilot` CLI (recommended)

```bash
# 1. Install the CLI extension (once)
gh extension install team-yubune/gh-looppilot

# 2. Run it in the directory of the repo you want to install into
cd path/to/your-repo
gh looppilot init
```

`gh looppilot init` does the following in a single command:

- Auto-detects the toolchain (Node / Python / Go / Rust / Make) and suggests `CHECK_COMMAND` and the caller's `language`
- Generates two thin callers (`.github/workflows/looppilot-{init,loop}.yml`, referencing `@v1`)
- Idempotently creates the gate label `loop-pilot`
- Displays the manual steps that can't be automated (Codex App integration, injecting secrets)
- Finally runs a **pre-flight check** to surface configuration gaps (label / Codex integration / secret / toolchain) before your first PR

After installation, you can re-check the configuration any time with `gh looppilot doctor` (read-only). `--json` also produces machine-readable output. Next, perform [Before your first PR (manual steps)](#before-your-first-pr-manual-steps).

> If you want to paste it in manually instead of using the CLI, go to "2. Install manually" below. The mechanism is the same (thin caller → reusable workflow `@v1`), and the generated artifacts are identical.

### 2. Install manually (without the CLI)

#### 2-1. Create the gate label (or full-auto)

By default, only PRs labeled `loop-pilot` are targeted by LoopPilot. Unless you **first do one of the following** in the adopter repository, even after pasting in the workflows the `if:` condition evaluates to `false` and no run is generated in the Actions tab.

**Option A: Create the label (recommended, controllable per PR)**

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run LoopPilot on this PR"
```

Adding this label to a PR triggers Workflow A / B. Nothing happens on PRs without the label (no workflow run is generated either).

**Option B: Enable on all PRs (full-auto)**

Setting the repository variable `LOOPPILOT_FULL_AUTO=true` triggers LoopPilot on all non-fork PRs.

For the detailed spec of the label gate, see [`docs/architecture/event-design.md`](docs/architecture/event-design.md).

#### 2-2. Add the caller workflows

LoopPilot itself is distributed as a **reusable workflow (`workflow_call`)**. The adopter only places two thin callers that write just the trigger event and secrets / permissions (each ~15–22 lines). The `if:` conditions, Codex marker detection, fork guard, toolchain setup, and crash fail-safe are all consolidated into the reusable workflow, so changes such as the marker are reflected across all adopters by re-pointing `@v1` (resolving the distributed versioning problem).

> **How to pass secrets**: Within the same org you can use `secrets: inherit`. **Adopters in a different org cannot use `secrets: inherit`** (same-org only), so enumerate the secrets explicitly as in the sample below. `GITHUB_TOKEN` is auto-provided by Actions, so it does not need to be enumerated.

#### Workflow A — initialize when a PR is opened

```yaml
# .github/workflows/looppilot-init.yml
name: LoopPilot Init

on:
  pull_request:
    types: [opened, ready_for_review, labeled]

jobs:
  init:
    # The caller's job grants GITHUB_TOKEN permissions (the reusable workflow's token is capped by the caller)
    permissions:
      contents: read
      pull-requests: write
      issues: write
    uses: team-yubune/loop-pilot/.github/workflows/init.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

#### Workflow B — fix loop driven by Codex reviews

```yaml
# .github/workflows/looppilot-loop.yml
name: LoopPilot Loop

on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  loop:
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read        # For the auto-merge guard. Can be omitted if you don't use LOOPPILOT_AUTO_MERGE
    uses: team-yubune/loop-pilot/.github/workflows/loop.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
      LOOPPILOT_PUSH_TOKEN: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
      # Set exactly one of ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    with:
      language: node   # node | python | go | rust | none
```

`@v1` is the stable release tag (a moving tag that auto-tracks the latest `v1.x.y`). If you want to pin it, use `@v1.2.3` or a commit SHA. `@main` may receive breaking changes, so it is not recommended for production. For details, see [release procedure](docs/operations/releasing.md).

All repository variables (`CHECK_COMMAND` / `LOOPPILOT_LABEL` / `MAX_REVIEW_ITERATIONS`, etc.; [Configuration (Repository variables)](#configuration-repository-variables)) are resolved in the **adopter's own repository** (the `vars` / `github` context is resolved on the caller, by GitHub spec). There is no need to restate these in the thin caller.

#### Non-Node toolchains (`language` input)

You can switch the environment that runs `CHECK_COMMAND` / `BUILD_COMMAND` with a single caller `language` input. The `loop` itself runs on the runner's Node, so `language` only controls the validation environment.

| `language` | Setup | Dependency install |
|---|---|---|
| `node` (default) | `actions/setup-node@v5` (Node 24, npm cache) | `npm ci` if `package-lock.json` exists |
| `python` | `actions/setup-python@v5` (3.x) | `pip install -r` if `requirements.txt` exists |
| `go` | `actions/setup-go@v5` (stable) | — |
| `rust` | `rustup` stable (minimal) | — |
| `none` | None (uses runner pre-installs, e.g. make / gcc) | — |

Set `CHECK_COMMAND` (`vars.CHECK_COMMAND`) to match the toolchain you chose (e.g. `pytest` for Python, `go test ./...` for Go, `make check` for Make).

> This repository itself also dogfoods LoopPilot in `.github/workflows/looppilot-{init,loop}.yml`. Because these are callers in the same repo, they use `secrets: inherit` and a local reference to the reusable workflow (`./.github/workflows/{init,loop}.yml`); the sample above for external adopters replaces these with a tagged ref + explicitly enumerated secrets. For the internal implementation of the reusable workflow, see [`.github/workflows/loop.yml`](.github/workflows/loop.yml) / [`init.yml`](.github/workflows/init.yml).

## Before your first PR (manual steps)

Whether you install via the CLI or manually, the following are **manual steps that can't be automated due to platform constraints**. After running the CLI's `gh looppilot init`, perform these steps before opening your first PR.

1. **Integrate the Codex GitHub App with the target repository.** Install the [ChatGPT Codex](https://chatgpt.com/codex) GitHub integration and enable the target repo. Without this, posting `@codex review` won't return a review (pre-flight will show `codex.connection = unknown`).
2. **Register the secrets** (values can't be set from the command; inject them via the GitHub UI or `gh secret set`).
   - `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` (one of them, **required**)
   - `CODEX_REVIEW_REQUEST_TOKEN` (recommended; the fine-grained PAT of the user integrated with Codex)
   - `LOOPPILOT_PUSH_TOKEN` (if you use branch protection required checks or auto-merge)
   - For details, see [Tokens & required permissions](#tokens--required-permissions-fine-grained-pat) below.
3. **Verify with pre-flight.** Run `gh looppilot doctor` and confirm that `error` is 0 (`warning` / `unknown` are acceptable).
4. **Open your first PR** (add the gate label `loop-pilot`; not needed in full-auto). Expected flow:
   - init posts a **state comment** and **`@codex review`**
   - On receiving the Codex review, loop starts: Claude fix → `CHECK_COMMAND` → commit/push → `@codex review` again
   - When findings at or above the threshold are resolved, it ends with **`done / no_findings`**. If they can't be resolved, the stop reason is stated explicitly on the PR

```bash
# Example of injecting secrets
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>          # The value is entered at the prompt
gh secret set CODEX_REVIEW_REQUEST_TOKEN --repo <owner>/<repo>
gh looppilot doctor                                            # Confirm error is 0
```

## Tokens & required permissions (Fine-grained PAT)

LoopPilot uses three kinds of GitHub tokens and one kind of Anthropic credential. The GitHub tokens are separated by purpose, and you should grant each **only the permissions it needs**.

- Scope every PAT **to just the one target repository** (avoid granting org-wide).
- For fine-grained PATs, `Metadata: Read-only` is auto-granted (required), so it is omitted from the tables below.
- Always store tokens in GitHub Actions **Repository secrets** (they are automatically masked in logs).

### 1. `GITHUB_TOKEN` (Actions built-in / not a PAT)

A token auto-generated by Actions. It is not a PAT; you narrow its permissions in the workflow's `permissions:` block.

| Workflow | permissions |
|---|---|
| Workflow A (`looppilot-init.yml`) | `contents: read`, `pull-requests: write`, `issues: write` |
| Workflow B (`looppilot-loop.yml`) | `contents: write`, `pull-requests: write`, `issues: write`, `actions: read` |

- **`issues: write` / `pull-requests: write`** — reading/writing the hidden state comment / status comment / various notifications, reading PR metadata / inline review comments / labels, and executing auto-merge.
- **`contents: write`** (Workflow B only) — a fallback for pushing the repair commit with `GITHUB_TOKEN` when `LOOPPILOT_PUSH_TOKEN` is not set. Workflow A only checks out and does not push, so `contents: read`.
- **`actions: read`** (Workflow B only) — required only when `LOOPPILOT_AUTO_MERGE=true`. Before auto-merging, it checks via `/actions/runs` whether other CI runs on HEAD are green. Without it, the API returns 403 and auto-merge is always skipped. Can be omitted if you don't use auto-merge.

### 2. `CODEX_REVIEW_REQUEST_TOKEN` (Fine-grained PAT, optional / recommended for production)

A token for posting the `@codex review` comment **as a user already integrated with Codex** to trigger and re-trigger Codex's review. When not set, it falls back to `GITHUB_TOKEN` (= `github-actions[bot]`), but bot posts don't reliably trigger Codex, so a PAT of the integrated user is recommended.

**Issued by:** a user who has integrated ChatGPT Codex with GitHub (in production, replacing it with a dedicated machine user or a GitHub App is recommended).

**Fine-grained PAT — Repository permissions:**

| Permission | Level | Required? | Purpose |
|---|---|---|---|
| Pull requests | Read and write | **Required** | Post `@codex review` to the PR conversation (`POST /repos/{owner}/{repo}/issues/{pr}/comments`. A comment addressed to a PR number is authorized by the Pull requests permission for a fine-grained PAT) |
| Issues | Read and write | Recommended | Insurance against the comment endpoint shared by issues/PRs |

It is **not used** for push, checkout, reading/writing the state comment, or fetching findings (those use `GITHUB_TOKEN`). For details, see [`docs/operations/security.md`](docs/operations/security.md#codex-review-request-token).

### 3. `LOOPPILOT_PUSH_TOKEN` (Fine-grained PAT or GitHub App token, optional / effectively required in production)

A token dedicated to the `git push` of the repair commit. Because of the spec where **GitHub does not fire `pull_request: synchronize` for commits pushed with `GITHUB_TOKEN`**, when not set the required CI checks are not re-run against auto-fix commits, leaving a path where `dist/` drift or typecheck regressions first surface on main after merge. Setting it is strongly recommended in the following cases:

- You enforce **required CI checks** with branch protection
- You run auto-fix → auto-merge with `LOOPPILOT_AUTO_MERGE=true`
- You include **drift that can only be detected in CI**, such as committed build artifacts / generated code / lockfiles

**Issued by:** a fine-grained PAT of a machine user scoped to the target repository, or a GitHub App installation token. Being an actor other than `GITHUB_TOKEN` is the condition for required checks to re-run.

**Fine-grained PAT — Repository permissions:**

| Permission | Level | Required? | Purpose |
|---|---|---|---|
| Contents | Read and write | **Required** | Push the repair commit to the PR head branch |

`.github/` is hard-blocked by the scope check so the repair commit never touches workflow files, so the **`Workflows` permission is not needed**. It is **not used** for posting `@codex review`, comments, or claude-code-action inputs. For details, see [`docs/operations/security.md`](docs/operations/security.md#looppilot-push-token).

### 4. `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (either one)

The credential for `claude-code-action`. It is not a GitHub token. Set **exactly one** (if both / neither are set, pre-fix fails fast at startup).

| Secret | Purpose | Billing |
|---|---|---|
| `ANTHROPIC_API_KEY` | Direct Anthropic API calls | Anthropic API usage-based billing |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription (Pro / Max). Issued with `claude setup-token` | Consumes subscription usage |

The fail fast when both are set is to prevent the accident of "intending to switch to the subscription but forgetting to remove the API key, so billing continues." For details, see [`docs/operations/security.md`](docs/operations/security.md) (notes on authentication / using the subscription).

### Secrets summary

| Secret | Required? | Overview |
|---|---|---|
| `GITHUB_TOKEN` | Automatic | Auto-provided by Actions. Narrow permissions with `permissions:` |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | One of them required | Authentication for claude-code-action |
| `CODEX_REVIEW_REQUEST_TOKEN` | Optional (recommended) | Post `@codex review` as the integrated user |
| `LOOPPILOT_PUSH_TOKEN` | Optional (effectively required in production) | For pushing the repair commit. Needed to re-run required checks |

## Configuration (Repository variables)

All are optional and work safely with defaults when not set. Here is an excerpt of the commonly used ones (for all inputs, see [`loop/action.yml`](loop/action.yml) / [`init/action.yml`](init/action.yml)).

| Variable | Default | Description |
|---|---|---|
| `LOOPPILOT_LABEL` | `loop-pilot` | Only PRs with this label are targeted (default-strict). **You must create the label in the repo and add it to the PR** (no run is generated if it isn't created) |
| `LOOPPILOT_FULL_AUTO` | `false` | `true` disables the label gate (triggers on all non-fork PRs) |
| `MAX_REVIEW_ITERATIONS` | `20` | Maximum number of fixes per PR |
| `CHECK_COMMAND` | `npm run check` | The validation command run after a fix (validated by an allowlist; shell metacharacters / unallowed binaries fail fast) |
| `BUILD_COMMAND` | (empty = skip) | An optional build that runs after `CHECK_COMMAND` passes and before staging. Keeps generated artifacts like `dist/` from drifting from `src/`. Consolidate multiple steps into an npm script / Makefile |
| `LOOPPILOT_SEVERITY_THRESHOLD` | `P3` | Ignore severities below this. `P3` targets all of P0–P3, `P2` skips P3, etc. |
| `LOOPPILOT_AUTO_MERGE` | `false` | Auto squash-merge on reaching `done / no_findings`. **Requires enabling repo Settings → General → "Allow auto-merge"**. On skips due to CI failure / HEAD change / timeout, etc., the reason is notified via a PR comment |
| `LOOPPILOT_BLOCK_PATHS` | (empty) | A `.gitignore`-style block-path spec. `secrets/` (dir), `Justfile` (file), `!Makefile` (clear default). `!.github/...` is ignored (`.github/` is locked) |
| `CLAUDE_CODE_MODEL_BASE` | `claude-sonnet-4-6` | Base-tier model. Used on iterations where escalation conditions are not met |
| `CLAUDE_CODE_MODEL_ESCALATED` | `claude-opus-4-7` | Escalated tier. Used for P0 findings, a failed prior CHECK, or recurrence of the same findings. Setting it equal to `BASE` disables tiering |
| `CODEX_BOT_LOGIN` | `chatgpt-codex-connector[bot]` | The Codex bot's login name (for overriding when the integration target changes) |
| `CODEX_REVIEW_MARKER` | `Codex Review` | The detection marker for the Codex summary comment |
| `LOOPPILOT_RESTART_ROLES` | `author,write,maintain,admin` | Roles allowed to use `/restart-review` |
| `LOOPPILOT_STATE_COMMENT_AUTHORS` | (empty = `github-actions[bot]`) | Trusted authors of the hidden state comment. Set this when writing with a GitHub App / machine user |

> If you use auto-merge, go to repository Settings → General → Pull Requests → **enable "Allow auto-merge"**. If left disabled, `gh pr merge --auto` fails immediately, and the reason is notified via a `⏸️ Auto-merge skipped` PR comment.

## Documentation

- [`docs/README.md`](docs/README.md) — overall table of contents
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — design overview
- [`docs/architecture/flow-and-state.md`](docs/architecture/flow-and-state.md) — flow / state management
- [`docs/operations/security.md`](docs/operations/security.md) — secrets / token permissions / scope check / authentication
- [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) — stop conditions and `/restart-review`
- [`docs/operations/scope-policy.md`](docs/operations/scope-policy.md) — change scope inspection and `LOOPPILOT_BLOCK_PATHS`

## Development

```bash
npm ci
npm run check     # tsc --noEmit + tests/ typecheck + vitest run
npm run bundle    # Regenerate dist/
```

When you open a PR, CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) checks typecheck / test / dist drift. After changing `src/`, regenerate `dist/` with `npm run bundle` and commit it (the published action runs `dist/`).

## License

[MIT](LICENSE)
