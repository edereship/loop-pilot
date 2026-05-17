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

      - uses: team-yubune/test-auto-ai-review/loop@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          auto-review-push-token: ${{ secrets.AUTO_REVIEW_PUSH_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # or for subscription users:
          # claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          pr-number: ${{ github.event.issue.number || github.event.pull_request.number }}
          pr-head-ref: ${{ steps.pr.outputs.head_ref }}
          pr-title: ${{ steps.pr.outputs.title }}
          trigger-comment-id: ${{ github.event.comment.id || github.event.review.id }}
          trigger-comment-body: ${{ github.event.comment.body || github.event.review.body }}
          trigger-user-login: ${{ github.event.comment.user.login || github.event.review.user.login }}
```

完全な workflow サンプルは [`/.github/workflows/auto-review-init.yml`](.github/workflows/auto-review-init.yml) と [`/.github/workflows/auto-review-loop.yml`](.github/workflows/auto-review-loop.yml) を参照。

## 主要 input

| input | デフォルト | 説明 |
|-------|----------|------|
| `github-token` | (必須) | `contents:write` / `pull-requests:write` / `issues:write` を持つ token |
| `anthropic-api-key` | "" | Anthropic API 課金。`claude-code-oauth-token` と排他 (TY-260) |
| `claude-code-oauth-token` | "" | Claude Code サブスク。`claude setup-token` で生成 |
| `codex-review-request-token` | `github-token` | `@codex review` を Codex 連携ユーザーから依頼するための PAT |
| `auto-review-push-token` | "" | repair commit push 用の machine-user PAT / GitHub App token (required checks 発火用) |
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
