# auto-review-loop

> Codex レビュー × Claude 自動修正のループを GitHub Actions として実行する PoC。

PR が開かれたら Codex (`chatgpt-codex-connector[bot]`) にコードレビューを依頼し、P0/P1/P2 の findings を [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) が自動修正する。修正のたびに `CHECK_COMMAND` (デフォルト `npm run check`) を回し、scope policy・hard-block・size budget を満たさない repair は revert する。findings がなくなれば `done`、解消できない・iteration 上限に達した場合は `stopped` で停止する。

設計の詳細は [`docs/README.md`](docs/README.md) を参照。

## クイックスタート

利用側リポジトリで以下の 2 つの workflow を貼る。トークン / variable は repo の Settings に登録する。

### Workflow A — PR を開いた時に初期化

```yaml
# .github/workflows/auto-review-init.yml
name: Auto Review Init
on:
  pull_request:
    types: [opened, ready_for_review, labeled]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  init:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: team-yubune/test-auto-ai-review/init@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}

      # Fail-safe: surface a PR notification when init fails before posting
      # the initial `@codex review`. Without this step the PR goes completely
      # silent on init failure and operators only notice when they wonder
      # why auto-review never fired. See `.github/workflows/auto-review-init.yml`
      # for the full rationale (TY-283).
      - name: Post init failure notification
        # `cancelled()` covers job timeout / manual cancel: `failure()` alone
        # returns false when the step ends with conclusion `cancelled`.
        if: failure() || cancelled()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          BODY=$'⚠️ **Auto-review init failed.**\n\nThe init workflow that prepares auto-review state and posts the initial `@codex review` failed before completing. Re-run from the Actions tab, or re-trigger by removing and re-adding the gate label (or closing/reopening the PR in full-auto mode).\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post init failure notification."
```

### Workflow B — Codex のレビューを受けて修正ループ

```yaml
# .github/workflows/auto-review-loop.yml
name: Auto Review Loop
on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

concurrency:
  group: pr-${{ github.event.issue.number || github.event.pull_request.number }}-auto-fix
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  auto-fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # `issue_comment` events do not carry PR head ref / title in the payload,
      # so resolve them via the GitHub API. pre-fix rejects an empty
      # `pr-head-ref` with `[pre-fix] pr-head-ref is required but not set`, so
      # this step is mandatory regardless of trigger type.
      - id: pr
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          info=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefName,title)
          {
            echo "head_ref=$(jq -r .headRefName <<<"$info")"
            echo "title=$(jq -r .title <<<"$info")"
          } >> "$GITHUB_OUTPUT"

      - id: loop
        uses: team-yubune/test-auto-ai-review/loop@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          auto-review-push-token: ${{ secrets.AUTO_REVIEW_PUSH_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # or for subscription users:
          # claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # Optional: keep committed build artifacts (e.g. `dist/`) in sync
          # with `src/` so auto-fix commits never drift (TY-281). Set the
          # `BUILD_COMMAND` Repository variable to your bundle/build command.
          build-command: ${{ vars.BUILD_COMMAND || '' }}
          pr-number: ${{ github.event.issue.number || github.event.pull_request.number }}
          pr-head-ref: ${{ steps.pr.outputs.head_ref }}
          pr-title: ${{ steps.pr.outputs.title }}
          trigger-comment-id: ${{ github.event.comment.id || github.event.review.id }}
          trigger-comment-body: ${{ github.event.comment.body || github.event.review.body }}
          trigger-user-login: ${{ github.event.comment.user.login || github.event.review.user.login }}

      # Fail-safe set: ensure the PR always gets a notification even when the
      # in-process `postStopComment` cannot run. The two steps below partition
      # the failure space via `steps.loop.conclusion`:
      #   - `failure`/`cancelled` → the loop ran and crashed (TY-282 #2B)
      #   - `skipped`             → the loop never started; an earlier setup
      #                             step (checkout / setup-node / npm ci /
      #                             `Get PR info` / fork guard) failed (TY-283)
      # See `.github/workflows/auto-review-loop.yml` for the full inline
      # rationale (90-second dedup window against TY-282 #2A, why state is
      # not touched here, etc.).
      - name: Post crash notification on workflow failure
        if: >
          always() &&
          (steps.loop.conclusion == 'failure' ||
           steps.loop.conclusion == 'cancelled')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          LOOP_CONCLUSION: ${{ steps.loop.conclusion }}
        run: |
          set -euo pipefail
          SINCE=$(date -u -d '90 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
          RECENT_STOP=$(gh api \
            "repos/${REPO}/issues/${PR_NUM}/comments?since=${SINCE}&per_page=100" \
            --jq '[.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("🛑 **Auto-review stopped**")))] | length' \
            2>/dev/null || echo 0)
          if [ "${RECENT_STOP:-0}" -gt 0 ]; then
            echo "::notice::TY-282 2A already posted a top-level stop notification within 90s; skipping fail-safe to avoid duplicate."
            exit 0
          fi
          BODY=$'🛑 **Auto-review crashed** — the auto-fix loop step ended with conclusion `'"$LOOP_CONCLUSION"$'` before the in-process stop notification could post (TY-282 #2B).\n\nUse `/restart-review` to resume — add `--hard` if iteration history needs clearing.\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post crash notification."

      - name: Post early-step failure notification
        # `cancelled()` covers job timeout / manual cancel during an early
        # step (loop step ends `skipped`, `failure()` is false).
        if: >
          always() &&
          (failure() || cancelled()) &&
          steps.loop.conclusion == 'skipped'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          BODY=$'⚠️ **Auto-review Workflow B failed before the auto-fix loop could start.**\n\nThe failure happened in an early setup step (e.g. `actions/checkout`, `actions/setup-node`, `npm ci`, or the PR info / fork guard step). The auto-review-state was not modified — the next valid Codex review will retry the loop (TY-283).\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post early-step failure notification."
```

完全な workflow サンプルは [`/.github/workflows/auto-review-init.yml`](.github/workflows/auto-review-init.yml) と [`/.github/workflows/auto-review-loop.yml`](.github/workflows/auto-review-loop.yml) を参照。

## 主要 input

| input | デフォルト | 説明 |
|-------|----------|------|
| `github-token` | (必須) | `contents:write` / `pull-requests:write` / `issues:write` を持つ token |
| `anthropic-api-key` | "" | Anthropic API 課金。`claude-code-oauth-token` と排他 (TY-260) |
| `claude-code-oauth-token` | "" | Claude Code サブスク。`claude setup-token` で生成 |
| `codex-review-request-token` | `github-token` | `@codex review` を Codex 連携ユーザーから依頼するための PAT |
| `auto-review-push-token` | "" | repair commit push 用の machine-user PAT / GitHub App token。**required checks や `auto-merge-on-clean` を使う production では実質必須** (`GITHUB_TOKEN` の push は `pull_request: synchronize` を発火させない GitHub 仕様のため、未設定だと auto-fix commit に対して CI が走らず PR #85 のような事故が起きる経路を残す。TY-281 検証済み)。 |
| `build-command` | "" | `CHECK_COMMAND` 通過後・staging 前に走る任意のビルドコマンド (TY-281)。`dist/` 等のビルド成果物を commit する repo で auto-fix commit が `src/` と drift しないようにする。空 default なら skip。複数ステップは `&&` 連結か npm script ラップで合わせる。生成物は **build-mode の緩和版 scope check** に通る — unlocked default blocks (`dist/`, `package.json` 等) とサイズ上限はスキップされる一方、`.github/` (locked) と path traversal は依然として reject される。詳細は [`docs/operations/scope-policy.md`](docs/operations/scope-policy.md)。 |
| `auto-review-label` | `auto-review-fix` | このラベルを持つ PR のみが自動修正対象 (default-strict) |
| `auto-review-full-auto` | `false` | true でラベルゲートを無効化 |
| `max-review-iterations` | `20` | 1 PR あたりの最大修正回数 |
| `severity-threshold` | `P2` | これ未満の severity は無視 (TY-256) |
| `scope-allowed-path-prefixes` | `src/,tests/,docs/` | scope check の allow-list (TY-266) |
| `auto-review-hard-block-override` | "" | 特定パスを hard-block 対象から外す (TY-255) |

すべての input は [`loop/action.yml`](loop/action.yml) と [`init/action.yml`](init/action.yml) を参照。

## ドキュメント

- [`docs/README.md`](docs/README.md) — 全体目次
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — 設計概要
- [`docs/architecture/flow-and-state.md`](docs/architecture/flow-and-state.md) — フロー / state 管理
- [`docs/operations/security.md`](docs/operations/security.md) — secrets / scope check / 認証
- [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) — 停止条件と `/restart-review`

## 開発

```bash
npm ci
npm run check     # tsc --noEmit + tests/ typecheck + vitest run
npm run bundle    # dist/ を再生成
```

PR を開くと CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) が typecheck / test / dist drift をチェックする。

## ライセンス

[MIT](LICENSE)
