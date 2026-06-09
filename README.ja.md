# LoopPilot

[English](README.md) | **日本語**

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-LoopPilot-blue?logo=github)](https://github.com/marketplace/actions/looppilot-pr-review-fix-loop)

> GitHub Pull Request 向けの AI レビュー修正ループ。LoopPilot は Codex に PR レビューを依頼し、指摘を Claude に修正させ、チェックを実行し、PR がクリーンになるまで繰り返します。

LoopPilot は GitHub Actions の再利用可能 workflow として動きます。サーバー運用やホスティングは不要です。推奨の導入方法は [`gh looppilot` CLI](https://github.com/Edereship/gh-looppilot) です。

> **[GitHub Marketplace の掲載](https://github.com/marketplace/actions/looppilot-pr-review-fix-loop)は発見性のための入口であり、LoopPilot の実行方法ではありません。** LoopPilot はイベント駆動で再利用可能 workflow として動くため、ジョブに追加する step ではありません。`uses: Edereship/loop-pilot@v1` をジョブに書かないでください — このルート action は導入手順を表示して終了するだけです。導入は下記の `gh looppilot` CLI、または[手動の再利用可能 workflow caller](#手動導入)（`Edereship/loop-pilot/.github/workflows/{init,loop}.yml@v1`）を使ってください。

## まずここから

```bash
# 1. 一度だけインストール。Node >= 20 と認証済み GitHub CLI が必要です。
gh extension install Edereship/gh-looppilot

# 2. LoopPilot を入れたいリポジトリで実行します。
cd path/to/your-repo
gh looppilot init

# 3. 必要な secret を追加したあと、設定を確認します。
gh looppilot doctor
```

`gh looppilot init` の後に、下記の手動ステップを 2 つ実施してください。Codex GitHub App の連携と、Claude 認証情報の追加です。その後、PR を開いて `loop-pilot` ラベルを付けます。

## LoopPilot がすること

1. `loop-pilot` ラベル付きで PR を開く。
2. LoopPilot が `@codex review` を投稿する。
3. Codex が PR をレビューし、指摘を返す。
4. Claude が `anthropics/claude-code-action` 経由で指摘を修正する。
5. LoopPilot が `CHECK_COMMAND`、scope check、secret scan を実行し、修正 commit を push して、再度 Codex にレビューを依頼する。
6. 指摘がなくなれば `done`、ガード・上限・検証失敗などで人の対応が必要なら `stopped` で終了する。

安全ガードも組み込まれています。fork PR は無視され、`.github/` は変更不可、修正は scope check と secret scan を通過する必要があり、すべての修正で指定した検証コマンドが実行されます。

## 前提条件

| 必要なもの | 理由 |
|---|---|
| GitHub Actions が有効 | LoopPilot は Actions 上で動きます。 |
| 同一リポジトリ内の PR branch | fork PR はセキュリティ上ブロックします。 |
| ChatGPT Codex GitHub 連携 | `@codex review` で対象 repo の Codex レビューを起動するため。 |
| Claude 認証情報 1 つ | `ANTHROPIC_API_KEY` または `CLAUDE_CODE_OAUTH_TOKEN` を設定します。 |
| 検証コマンド | デフォルトは `npm run check`。`CHECK_COMMAND` で変更できます。 |

## CLI で導入

推奨は `gh looppilot init` です。1 コマンドで次を実行します。

- toolchain を検出し、`CHECK_COMMAND` を提案
- `.github/workflows/looppilot-init.yml` を作成
- `.github/workflows/looppilot-loop.yml` を作成
- ゲートラベル `loop-pilot` を作成
- GitHub の制約で自動化できない手順を表示
- pre-flight check を実行

導入後は `gh looppilot doctor` でいつでも設定を再確認できます。機械可読出力が必要な場合は `--json` を付けてください。

## 初回 PR 前の手動ステップ

### 1. Codex を連携する

[ChatGPT Codex](https://chatgpt.com/codex) を開き、GitHub を接続して、対象リポジトリに Codex GitHub App のアクセスを許可してください。`chatgpt-codex-connector[bot]` が対象 repo で動作できることを確認します。

これがない場合、LoopPilot は `@codex review` を投稿できますが、Codex レビューは返ってきません。

### 2. secrets を追加する

初回テスト PR では Claude 認証情報が 1 つあれば十分です。

```bash
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
# または:
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>
```

本番運用では、下記の GitHub PAT も追加してください。

| Secret | 必須か | 用途 |
|---|---|---|
| `ANTHROPIC_API_KEY` または `CLAUDE_CODE_OAUTH_TOKEN` | 必須（いずれか一方のみ） | `claude-code-action` が修正を行うため。 |
| `CODEX_REVIEW_REQUEST_TOKEN` | 必須 | Codex 連携済みユーザーとして `@codex review` を投稿するため。 |
| `LOOPPILOT_PUSH_TOKEN` | 必須 | `GITHUB_TOKEN` 以外の actor として repair commit を push し、required checks を再実行させるため。 |
| `GITHUB_TOKEN` | 自動 | GitHub Actions が注入します。作成・保存は不要です。 |

#### 2 つの Fine-grained PAT を作成する

`CODEX_REVIEW_REQUEST_TOKEN` と `LOOPPILOT_PUSH_TOKEN` は GitHub の **Fine-grained personal access token（PAT）** です。初めて作成する場合は、まず GitHub 公式ガイドを参照してください: [Creating a fine-grained personal access token](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)。

各トークンの作成手順:

1. **Settings → Developer settings → Fine-grained tokens → Generate new token** を開く（上記リンクからでも可）。
2. **Repository access** で **Only select repositories** を選び、対象リポジトリのみを指定する。
3. **Permissions → Repository permissions** で、そのトークンに必要な権限だけを付与する:

   | トークン | Repository permissions |
   |---|---|
   | `CODEX_REVIEW_REQUEST_TOKEN` | `Pull requests: Read and write`、`Issues: Read and write` |
   | `LOOPPILOT_PUSH_TOKEN` | `Contents: Read and write` |

4. トークンを生成してコピーし、repository secret として保存する:

   ```bash
   gh secret set CODEX_REVIEW_REQUEST_TOKEN --repo <owner>/<repo>
   gh secret set LOOPPILOT_PUSH_TOKEN --repo <owner>/<repo>
   ```

注意:

- `CODEX_REVIEW_REQUEST_TOKEN` は GitHub アカウントが Codex と連携済みのユーザーで発行してください。連携していないと `@codex review` がレビューを起動しません。
- `LOOPPILOT_PUSH_TOKEN` は `GITHUB_TOKEN` 以外の actor（専用 machine user または GitHub App token を推奨）で発行してください。その actor による push でないと required checks が再実行されません。
- 2 つのトークンは分けてください。レビュー依頼用トークンには push 権限を付与しないでください。

トークン権限とセキュリティの詳細は [docs/operations/security.md](docs/operations/security.md) を参照してください。

## 初回 PR チェックリスト

1. `gh looppilot doctor` を実行し、`error = 0` を確認する。
2. 同一リポジトリ内の branch から PR を開く。
3. full-auto を有効化していない場合、`loop-pilot` ラベルを付ける。
4. LoopPilot の status comment と最初の `@codex review` を確認する。
5. ループ終了後、最終状態が `done` か `stopped` かを確認する。

## よく使う設定

対象リポジトリの GitHub Actions Repository variables として設定します。

| Variable | デフォルト | 使う場面 |
|---|---|---|
| `CHECK_COMMAND` | `npm run check` | 検証コマンドを変えたい。 |
| `BUILD_COMMAND` | 空 | `dist/` などの生成物を commit 前に更新したい。 |
| `LOOPPILOT_LABEL` | `loop-pilot` | ゲートラベル名を変えたい。 |
| `LOOPPILOT_FULL_AUTO` | `false` | すべての非 fork PR で LoopPilot を動かしたい。 |
| `MAX_REVIEW_ITERATIONS` | `20` | ループ上限を変えたい。 |
| `LOOPPILOT_SEVERITY_THRESHOLD` | `P3` | 低 severity の Codex 指摘を対象外にしたい。 |
| `LOOPPILOT_AUTO_MERGE` | `false` | `done / no_findings` 到達時に squash merge したい。 |
| `LOOPPILOT_BLOCK_PATHS` | 空 | 自動修正で触らせたくない path を追加したい。 |
| `LOOPPILOT_SCOPE_MAX_FILES` | `20` | 正当な修正がデフォルトより多くのファイルを変更する必要がある。 |
| `LOOPPILOT_SCOPE_MAX_LINES` | `1000` | 正当な修正がデフォルトより多くの行を変更する必要がある。 |
| `CODEX_ACK_TIMEOUT_SECONDS` | `90` | Codex の `@codex review` 承認（👀）待ち時間を調整したい。`0` で ACK ウォッチドッグを無効化。 |
| `CODEX_ACK_MAX_REPOSTS` | `2` | Codex が応答しないときに `@codex review` を再依頼する回数を調整したい（超過で `codex_request_failed` 停止）。 |
| `CLAUDE_CODE_MAX_TURNS` | `40` | 1 回の修正あたりの最大エージェントターン数を調整したい（claude-code-action の `--max-turns`）。 |
| `CLAUDE_CODE_MODEL_BASE` | `claude-sonnet-4-6` | ベースティアのモデルを変更したい。エスカレーションなしの通常修正で使われる。`CLAUDE_CODE_MODEL_ESCALATED` と同じ値にするとティアリング無効。 |
| `CLAUDE_CODE_MODEL_ESCALATED` | `claude-opus-4-7` | エスカレーションティアのモデルを変更したい。P0 指摘・CHECK_COMMAND 失敗・findings hash 重複時に使われる。 |
| `LOOPPILOT_RESTART_ROLES` | `author,write,maintain,admin` | `/restart-review` を実行できるロールを制限したい。 |
| `DEBOUNCE_SECONDS` | `90` | Codex サマリコメント後にインラインコメントを収集するまでの待ち時間を調整したい。 |

すべての input は [loop/action.yml](loop/action.yml) と [init/action.yml](init/action.yml) にまとまっています。

## 手動導入

CLI を使えない場合だけ、この手順を使ってください。

<details>
<summary><b>2 つの workflow caller を表示</b></summary>

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
    uses: Edereship/loop-pilot/.github/workflows/init.yml@v1
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
    uses: Edereship/loop-pilot/.github/workflows/loop.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
      LOOPPILOT_PUSH_TOKEN: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    with:
      language: node   # node | python | go | rust | none
```

full-auto を有効化しない場合は、ゲートラベルも作成します。

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run LoopPilot on this PR"
```

</details>

## 関連ドキュメント

- [ドキュメント目次](docs/README.md)
- [システム概要](docs/architecture/system-overview.md)
- [フローと state 管理](docs/architecture/flow-and-state.md)
- [セキュリティとトークン権限](docs/operations/security.md)
- [停止条件とリカバリ](docs/operations/stop-and-recovery.md)
- [Scope policy](docs/operations/scope-policy.md)
- [リリース手順](docs/operations/releasing.md)

## 開発

```bash
npm ci
npm run check
npm run bundle
```

CI は typecheck、test、`dist/` drift を確認します。`src/` を変更した場合は `npm run bundle` を実行し、再生成された `dist/` も commit してください。

## ライセンス

[MIT](LICENSE)
