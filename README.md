# LoopPilot

**English** | [日本語](README.ja.md)

> An AI review-fix loop for GitHub pull requests. LoopPilot asks Codex to review a PR, lets Claude fix the findings, runs your checks, and repeats until the PR is clean.

LoopPilot runs as GitHub Actions reusable workflows. You do not host a service, run a server, or install anything in production. The recommended setup path is the [`gh looppilot` CLI](https://github.com/team-yubune/gh-looppilot).

## Start here

```bash
# 1. Install once. Requires Node >= 20 and an authenticated GitHub CLI.
gh extension install team-yubune/gh-looppilot

# 2. Run inside the repository where you want LoopPilot.
cd path/to/your-repo
gh looppilot init

# 3. Check the setup after adding the required manual secrets.
gh looppilot doctor
```

After `gh looppilot init`, complete the two manual steps below: connect the Codex GitHub App and add one Claude credential. Then open a PR and add the `loop-pilot` label.

## What LoopPilot does

1. A PR is opened with the `loop-pilot` label.
2. LoopPilot posts `@codex review`.
3. Codex reviews the PR and reports findings.
4. Claude fixes the findings through `anthropics/claude-code-action`.
5. LoopPilot runs `CHECK_COMMAND`, checks scope and secrets, commits the fix, and asks Codex to review again.
6. The loop ends as `done` when findings are gone, or `stopped` when a guard, limit, or validation failure needs human attention.

Safety guards are built in: fork PRs are ignored, `.github/` is locked, changes are scope-checked, secrets are scanned, and every fix must pass your configured validation command.

## Requirements

| Requirement | Why it matters |
|---|---|
| GitHub Actions enabled | LoopPilot runs entirely in Actions. |
| Same-repository PR branches | Fork PRs are intentionally blocked for security. |
| ChatGPT Codex GitHub integration | `@codex review` must trigger Codex in the target repo. |
| One Claude credential | Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. |
| A validation command | Default is `npm run check`; customize with `CHECK_COMMAND`. |

## Install with the CLI

`gh looppilot init` is the preferred installer. It:

- detects your toolchain and suggests `CHECK_COMMAND`
- creates `.github/workflows/looppilot-init.yml`
- creates `.github/workflows/looppilot-loop.yml`
- creates the `loop-pilot` gate label
- prints the manual steps that GitHub does not allow the CLI to complete
- runs a pre-flight check

Use `gh looppilot doctor` any time to re-check configuration. Add `--json` for machine-readable output.

## Manual steps before the first PR

### 1. Connect Codex

Open [ChatGPT Codex](https://chatgpt.com/codex), connect GitHub, and grant the Codex GitHub App access to the target repository. Confirm that `chatgpt-codex-connector[bot]` can act on the repo.

Without this, LoopPilot can post `@codex review`, but no Codex review will arrive.

### 2. Add secrets

For a first test PR, one Claude credential is enough:

```bash
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
# or:
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>
```

For production, add the two GitHub PATs shown below.

| Secret | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Required, exactly one | Lets `claude-code-action` perform fixes. |
| `CODEX_REVIEW_REQUEST_TOKEN` | Recommended | Posts `@codex review` as a Codex-integrated user. |
| `LOOPPILOT_PUSH_TOKEN` | Recommended for protected branches | Pushes repair commits as a non-`GITHUB_TOKEN` actor so required checks re-run. |
| `GITHUB_TOKEN` | Automatic | GitHub Actions injects it. You do not create or store it. |

Token scopes and security details are in [docs/operations/security.md](docs/operations/security.md).

## First PR checklist

1. Run `gh looppilot doctor` and confirm `error = 0`.
2. Open a PR from a branch in the same repository.
3. Add the `loop-pilot` label, unless you enabled full-auto mode.
4. Watch for the LoopPilot status comment and the first `@codex review`.
5. When the loop finishes, check the final state: `done` or `stopped`.

## Common configuration

Set these as GitHub Actions repository variables in the target repository.

| Variable | Default | Use when |
|---|---|---|
| `CHECK_COMMAND` | `npm run check` | Your validation command is not `npm run check`. |
| `BUILD_COMMAND` | empty | You commit generated files such as `dist/` and need them refreshed before commit. |
| `LOOPPILOT_LABEL` | `loop-pilot` | You want a different gate label. |
| `LOOPPILOT_FULL_AUTO` | `false` | You want LoopPilot on every non-fork PR. |
| `MAX_REVIEW_ITERATIONS` | `20` | You want a lower or higher loop limit. |
| `LOOPPILOT_SEVERITY_THRESHOLD` | `P3` | You want to skip lower-severity Codex findings. |
| `LOOPPILOT_AUTO_MERGE` | `false` | You want LoopPilot to squash-merge when it reaches `done / no_findings`. |
| `LOOPPILOT_BLOCK_PATHS` | empty | You want to block extra paths from auto-fix changes. |

All inputs are documented in [loop/action.yml](loop/action.yml) and [init/action.yml](init/action.yml).

## Manual install

Use this only when the CLI is not available.

<details>
<summary><b>Show the two workflow callers</b></summary>

### `.github/workflows/looppilot-init.yml`

```yaml
name: LoopPilot Init

on:
  pull_request:
    types: [opened, ready_for_review, labeled]

jobs:
  init:
    permissions:
      contents: read
      pull-requests: write
      issues: write
    uses: team-yubune/loop-pilot/.github/workflows/init.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

### `.github/workflows/looppilot-loop.yml`

```yaml
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
      actions: read
    uses: team-yubune/loop-pilot/.github/workflows/loop.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
      LOOPPILOT_PUSH_TOKEN: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    with:
      language: node   # node | python | go | rust | none
```

Create the gate label unless you enable full-auto mode:

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run LoopPilot on this PR"
```

</details>

## More docs

- [Documentation index](docs/README.md)
- [System overview](docs/architecture/system-overview.md)
- [Flow and state](docs/architecture/flow-and-state.md)
- [Security and token permissions](docs/operations/security.md)
- [Stop and recovery](docs/operations/stop-and-recovery.md)
- [Scope policy](docs/operations/scope-policy.md)
- [Release procedure](docs/operations/releasing.md)

## Development

```bash
npm ci
npm run check
npm run bundle
```

CI checks typecheck, tests, and `dist/` drift. After changing `src/`, run `npm run bundle` and commit the regenerated `dist/` files.

## License

[MIT](LICENSE)
