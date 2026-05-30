# LoopPilot

[English](README.md) | **日本語**

> AI review-fix loop for GitHub pull requests — Codex レビュー × Claude 自動修正のループを GitHub Actions として実行する。

PR を開くと、LoopPilot が Codex にレビューを依頼し、Codex が見つけた指摘を [Claude](https://github.com/anthropics/claude-code-action) が自動修正し、修正のたびにあなたの check を再実行します — レビューがクリーンになるまでこれを繰り返します。すべて GitHub Actions として動くので、ホスティングは不要です。

**3 ステップで始める**（最速は [`gh looppilot` CLI](https://github.com/team-yubune/gh-looppilot)）:

```bash
# 1. CLI を導入（一度だけ）。PATH に Node >= 20、かつ gh が認証済みであること
#    — 未認証なら先に `gh auth login`。
gh extension install team-yubune/gh-looppilot

# 2. LoopPilot を入れたいリポジトリのローカルクローン内で:
cd path/to/your-repo

# 3. 2 本の workflow + ゲートラベルを生成し、CHECK_COMMAND を提案し、
#    pre-flight 検査を実行。
gh looppilot init
```

続けて [初回 PR の前にやること](#初回-pr-の前にやること手動が必要な部分)（Codex 連携・secret 投入）を実施してください。手動で貼りたい場合は [手動で導入](#2-手動で導入cli-を使わない場合) を参照。

**目次:** [仕組み](#仕組み) · [前提条件](#前提条件) · [クイックスタート](#クイックスタート) · [初回 PR の前に](#初回-pr-の前にやること手動が必要な部分) · [トークンと権限](#トークンと必要権限-fine-grained-pat) · [設定](#設定-repository-variables) · [ドキュメント](#ドキュメント)

設計の詳細は [`docs/README.md`](docs/README.md) を参照してください。

## 仕組み

1. **Workflow A (init)** — PR が開かれ、ゲートを満たすと LoopPilot が初期化され、初回の `@codex review` を投稿する。
2. **Codex** がコードレビューを実施し、総評コメントと inline コメントを返す。
3. **Workflow B (loop)** — Codex のレビューを検知し、`claude-code-action` が findings を修正 → `CHECK_COMMAND` → scope / secret チェック → commit / push → 再度 `@codex review`。
4. findings がなくなるまで 2–3 を繰り返し、`done` で終了（任意で auto-merge）。上限到達・修正不能・スコープ違反などでは `stopped` で停止する。

Codex は findings に **P0–P3**（P0 が最も重大）のラベルを付け、デフォルトでは全部を対象に修正します。各修正は `CHECK_COMMAND` と安全ガード（scope policy・ロックされた `.github/`・size budget・secret scanner）を通過しなければ revert されるため、無関係・危険な変更が紛れ込むことはありません。`done` / `stopped` はいずれも PR 上のステータスコメントと通知で可視化されます。

fork PR は両 workflow のセキュリティガードで無効化されます（自リポジトリ PR のみ対象）。

## 前提条件

- GitHub Actions が有効なリポジトリで、**同一リポジトリ PR への commit / push が許可**されていること。
- 対象リポジトリに **ChatGPT Codex の GitHub 連携 (Codex GitHub App)** が導入され、`@codex review` でレビューが起動すること。
- **Anthropic API キー** または **Claude Code サブスクリプションの OAuth トークン**（いずれか一方）。
- `CHECK_COMMAND` を実行できるツールチェイン。デフォルトは Node.js / npm。pytest・go test・make 等を使う場合は caller の `language` input（`node` / `python` / `go` / `rust` / `none`）で切り替える。
- 必要なトークンと権限は [トークンと必要権限](#トークンと必要権限-fine-grained-pat) を参照。

## クイックスタート

導入方法は 2 つあります。**`gh looppilot` CLI（推奨・1 コマンド）** か、**手動で薄い caller を貼る**かです。どちらの場合も、Codex GitHub App 連携と secret 投入だけは手作業になり（CLI が案内します）、最後に [初回 PR の前にやること](#初回-pr-の前にやること手動が必要な部分) を実施します。

### 1. [`gh looppilot` CLI](https://github.com/team-yubune/gh-looppilot) で導入（推奨）

```bash
# 1. CLI extension をインストール（一度だけ）。PATH に Node >= 20、かつ gh が
#    認証済みであること（未認証なら先に `gh auth login`）。
gh extension install team-yubune/gh-looppilot

# 2. 対象 GitHub リポジトリのローカルクローン内で実行
#    （リポジトリは GitHub 上に存在し remote が設定済みであること）。
cd path/to/your-repo
gh looppilot init
```

`gh looppilot init` が 1 コマンドで以下を行います。

- toolchain を自動検出（Node / Python / Go / Rust / Make）し、`CHECK_COMMAND` と caller の `language` を提案
- 薄い caller 2 本（`.github/workflows/looppilot-{init,loop}.yml`、`@v1` 参照）を生成
- ゲートラベル `loop-pilot` を冪等に作成
- 自動化できない手動手順（Codex App 連携・secret 投入）を表示
- 最後に **pre-flight 検査** を実行し、初回 PR 前に設定漏れ（ラベル / Codex 連携 / secret / toolchain）を可視化

導入後はいつでも `gh looppilot doctor`（read-only）で設定を再確認できます。`--json` で機械可読出力も出ます。次に [初回 PR の前にやること](#初回-pr-の前にやること手動が必要な部分) を実施してください。

> CLI を使わず手動で貼りたい場合は次の「2. 手動で導入」へ。仕組みは同じ（薄い caller → 再利用可能ワークフロー `@v1`）で、生成物も同一です。

### 2. 手動で導入（CLI を使わない場合）

<details>
<summary><b>手動（CLI 不要）導入を展開</b> — 上記の CLI がこのセクションの内容をすべて生成します。CLI を使えない場合のみ開いてください。</summary>

#### 2-1. ゲートラベルの作成（または full-auto）

デフォルトでは `loop-pilot` ラベルが付いた PR のみが LoopPilot 対象です。利用側リポジトリで **以下のいずれかを先に実施** しないと、workflow を貼っても `if:` 条件が `false` になり Actions タブに run が生成されません。

**選択 A: ラベルを作成する（推奨、PR 単位で制御できる）**

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run LoopPilot on this PR"
```

PR にこのラベルを付けると Workflow A / B が起動します。ラベルが付かない PR では何も起きません（workflow run も生成されません）。

**選択 B: 全 PR で有効化する（full-auto）**

Repository variable `LOOPPILOT_FULL_AUTO=true` を設定すると、すべての非 fork PR で LoopPilot が起動します。

ラベルゲートの詳細仕様は [`docs/architecture/event-design.md`](docs/architecture/event-design.md) を参照。

#### 2-2. caller workflow を追加

LoopPilot 本体は **再利用可能ワークフロー (`workflow_call`)** として配布されます。adopter は発火イベントと secret / 権限だけを書いた薄い caller を 2 本置くだけです（各 ~15–22 行）。`if:` 条件・Codex マーカー判定・fork ガード・toolchain セットアップ・crash fail-safe はすべて再利用可能ワークフロー側に集約されており、マーカー変更などは `@v1` の張り替えで全 adopter に反映されます（分散バージョニング問題の解消）。

> **secret の渡し方**: 同一 org 内なら `secrets: inherit` が使えます。**別 org の adopter は `secrets: inherit` を使えない**（same-org 限定）ため、下記サンプルのように secret を明示列挙してください。`GITHUB_TOKEN` は Actions が自動付与するため列挙不要です。

#### Workflow A — PR を開いた時に初期化

```yaml
# .github/workflows/looppilot-init.yml
name: LoopPilot Init

on:
  pull_request:
    types: [opened, ready_for_review, labeled]

jobs:
  init:
    # caller の job が GITHUB_TOKEN 権限を付与する（再利用ワークフローの token は caller で上限が決まる）
    permissions:
      contents: read
      pull-requests: write
      issues: write
    uses: team-yubune/loop-pilot/.github/workflows/init.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

#### Workflow B — Codex のレビューを受けて修正ループ

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
      actions: read        # auto-merge ガード用。LOOPPILOT_AUTO_MERGE を使わないなら省略可
    uses: team-yubune/loop-pilot/.github/workflows/loop.yml@v1
    secrets:
      CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
      LOOPPILOT_PUSH_TOKEN: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
      # ANTHROPIC_API_KEY と CLAUDE_CODE_OAUTH_TOKEN はちょうど一方だけ設定する
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    with:
      language: node   # node | python | go | rust | none
```

`@v1` は安定版のリリースタグ（moving タグ。最新の `v1.x.y` を自動追従）。固定したい場合は `@v1.2.3` や commit SHA を使ってください。`@main` は破壊的変更を受け得るため本番非推奨です。詳細は [リリース手順](docs/operations/releasing.md)。

すべての Repository variable（`CHECK_COMMAND` / `LOOPPILOT_LABEL` / `MAX_REVIEW_ITERATIONS` など。[設定 (Repository variables)](#設定-repository-variables)）は **adopter 自身のリポジトリ** で解決されます（`vars` / `github` コンテキストは caller に解決される GitHub 仕様）。薄い caller でこれらを再記述する必要はありません。

#### 非 Node ツールチェイン（`language` input）

`CHECK_COMMAND` / `BUILD_COMMAND` を実行する環境を caller の `language` input 一つで切り替えられます。`loop` 本体は runner の Node 上で動くため、`language` は検証環境のみを制御します。

| `language` | セットアップ | 依存インストール |
|---|---|---|
| `node`（default） | `actions/setup-node@v5`（Node 24, npm cache） | `package-lock.json` があれば `npm ci` |
| `python` | `actions/setup-python@v5`（3.x） | `requirements.txt` があれば `pip install -r` |
| `go` | `actions/setup-go@v5`（stable） | — |
| `rust` | `rustup` stable（minimal） | — |
| `none` | なし（runner プリインストールを利用。例: make / gcc） | — |

`CHECK_COMMAND`（`vars.CHECK_COMMAND`）は選んだ toolchain に合わせて設定してください（例: Python なら `pytest`、Go なら `go test ./...`、Make なら `make check`）。

> 本リポジトリ自身も `.github/workflows/looppilot-{init,loop}.yml` で LoopPilot を dogfooding しています。同一 repo の caller のため `secrets: inherit` と再利用可能ワークフローのローカル参照（`./.github/workflows/{init,loop}.yml`）を使い、上記の外部 adopter 向けサンプルは tagged ref + secret 明示列挙に置き換えたものです。再利用可能ワークフローの内部実装は [`.github/workflows/loop.yml`](.github/workflows/loop.yml) / [`init.yml`](.github/workflows/init.yml) を参照。

</details>

## 初回 PR の前にやること（手動が必要な部分）

CLI / 手動どちらで導入しても、以下は **プラットフォーム制約で自動化できない手作業**です。CLI の `gh looppilot init` 実行後、この手順を行ってから初回 PR を開いてください。

1. **Codex GitHub App を対象リポジトリに連携する。** [ChatGPT → Codex](https://chatgpt.com/codex) で GitHub 連携設定を開き、GitHub アカウントを接続し、対象 repo（または org 全体）へのアクセスを許可する。**`chatgpt-codex-connector[bot]`** が対象 repo で動作できることを確認する。これが無いと `@codex review` を投稿してもレビューが返りません（pre-flight では `codex.connection = unknown` と表示されます）。
2. **secret を登録する**（値はコマンドから設定できません。GitHub UI または `gh secret set` で投入）。
   - `ANTHROPIC_API_KEY` **または** `CLAUDE_CODE_OAUTH_TOKEN`（どちらか一方・**必須**）
   - `CODEX_REVIEW_REQUEST_TOKEN`（推奨。Codex 連携ユーザーの fine-grained PAT）
   - `LOOPPILOT_PUSH_TOKEN`（branch protection の required checks や auto-merge を使うなら）
   - 詳細は下記 [トークンと必要権限](#トークンと必要権限-fine-grained-pat)。
3. **pre-flight で確認する。** `gh looppilot doctor` を実行し、`error` が 0 になることを確認する（`warning` / `unknown` は許容）。
4. **初回 PR を開く**（ゲートラベル `loop-pilot` を付ける。full-auto なら不要）。期待される流れ:
   - init が **state コメント** と **`@codex review`** を投稿する
   - Codex のレビューを受けて loop が起動し、Claude 修正 → `CHECK_COMMAND` → commit/push → 再 `@codex review`
   - 閾値以上の指摘が解消されれば **`done / no_findings`** で終了。解消できない場合は停止理由が PR に明示される

```bash
# secret 投入の例
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>          # 値はプロンプトで入力
gh secret set CODEX_REVIEW_REQUEST_TOKEN --repo <owner>/<repo>
gh looppilot doctor                                            # error が 0 か確認
```

## トークンと必要権限 (Fine-grained PAT)

LoopPilot は 3 種類の GitHub トークンと 1 種類の Anthropic 認証情報を使います。GitHub トークンは用途ごとに分離されており、それぞれに **必要な権限だけ** を与えてください。

- すべての PAT は **対象リポジトリ 1 つだけにスコープを限定**する（org 全体への付与は避ける）。
- Fine-grained PAT では `Metadata: Read-only` が自動付与される（必須）ため、以下の表では省略する。
- トークンは必ず GitHub Actions の **Repository secrets** に保存する（ログには自動でマスクされる）。

> **初回 PR に必須の secret は 1 つだけ:** `ANTHROPIC_API_KEY` か `CLAUDE_CODE_OAUTH_TOKEN` のいずれか一方です。`CODEX_REVIEW_REQUEST_TOKEN` と `LOOPPILOT_PUSH_TOKEN` は任意（本番向け）で、必須／任意の一覧は [Secrets サマリ](#secrets-サマリ) を参照。以下の各トークン節は詳細リファレンスです。
>
> **以下の fine-grained PAT の作成場所:** GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**。**Resource owner** を対象リポジトリのオーナーに、**Repository access** を *Only select repositories* → 対象 repo に設定し、各節に記載の権限を有効化します。

### 1. `GITHUB_TOKEN`（Actions ビルトイン / PAT ではない）

Actions が自動生成するトークン。PAT ではなく、workflow の `permissions:` ブロックで権限を絞ります。

| Workflow | permissions |
|---|---|
| Workflow A (`looppilot-init.yml`) | `contents: read`, `pull-requests: write`, `issues: write` |
| Workflow B (`looppilot-loop.yml`) | `contents: write`, `pull-requests: write`, `issues: write`, `actions: read` |

- **`issues: write` / `pull-requests: write`** — hidden state comment / status comment / 各種通知の読み書き、PR メタデータ・inline review comment・ラベルの読み取り、auto-merge の実行。
- **`contents: write`**（Workflow B のみ）— `LOOPPILOT_PUSH_TOKEN` 未設定時に repair commit を `GITHUB_TOKEN` で push するためのフォールバック。Workflow A は checkout のみで push しないため `contents: read`。
- **`actions: read`**（Workflow B のみ）— `LOOPPILOT_AUTO_MERGE=true` のときだけ必須。auto-merge 前に HEAD の他 CI run が green かを `/actions/runs` で確認する。未付与だと API が 403 を返し auto-merge が常に skip される。auto-merge を使わないなら省略可。

### 2. `CODEX_REVIEW_REQUEST_TOKEN`（Fine-grained PAT・任意 / 本番推奨）

`@codex review` コメントを **Codex と連携済みのユーザー** として投稿し、Codex のレビューを起動・再起動するためのトークン。未設定時は `GITHUB_TOKEN`（= `github-actions[bot]`）にフォールバックしますが、bot 投稿では Codex が確実に起動しないため、連携ユーザーの PAT を推奨します。

**発行元:** ChatGPT Codex を GitHub に連携済みのユーザー（本番では専用 machine user または GitHub App への置き換えを推奨）。

**Fine-grained PAT — Repository permissions:**

| Permission | Level | 要否 | 用途 |
|---|---|---|---|
| Pull requests | Read and write | **必須** | PR 会話に `@codex review` を投稿（`POST /repos/{owner}/{repo}/issues/{pr}/comments`。PR 番号宛のコメントは fine-grained PAT では Pull requests 権限で認可される） |
| Issues | Read and write | 推奨 | issue/PR 共通のコメント endpoint に対する保険 |

push・checkout・state comment 読み書き・findings 取得には**使いません**（それらは `GITHUB_TOKEN`）。詳細は [`docs/operations/security.md`](docs/operations/security.md#codex-review-request-token)。

### 3. `LOOPPILOT_PUSH_TOKEN`（Fine-grained PAT または GitHub App トークン・任意 / 本番では実質必須）

repair commit の `git push` 専用トークン。**`GITHUB_TOKEN` で push した commit には GitHub が `pull_request: synchronize` を発火させない**仕様のため、未設定だと auto-fix commit に対して required CI checks が再実行されず、`dist/` drift や typecheck 退行が merge 後の main で初めて露呈する経路を残します。以下に該当する場合は設定を強く推奨します。

- branch protection で **required CI checks** を強制している
- `LOOPPILOT_AUTO_MERGE=true` で auto-fix → 自動 merge を回す
- committed build artifacts / generated code / lockfile など **CI でしか検知できない drift** を含む

**発行元:** 対象リポジトリにスコープした machine user の Fine-grained PAT、または GitHub App installation token。`GITHUB_TOKEN` 以外の actor であることが required check 再実行の条件です。

**Fine-grained PAT — Repository permissions:**

| Permission | Level | 要否 | 用途 |
|---|---|---|---|
| Contents | Read and write | **必須** | PR head branch へ repair commit を push |

`.github/` は scope check で hard-block されており repair commit が workflow ファイルに触れないため、**`Workflows` 権限は不要**です。`@codex review` 投稿・コメント・claude-code-action 入力には**使いません**。詳細は [`docs/operations/security.md`](docs/operations/security.md#looppilot-push-token)。

### 4. `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`（いずれか一方）

`claude-code-action` の認証情報。GitHub トークンではありません。**ちょうど一方だけ** を設定してください（両方／どちらも未設定なら pre-fix が起動時に fail fast します）。

| Secret | 用途 | 課金 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 直接呼び出し | Anthropic API 従量課金 |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code サブスク (Pro / Max)。`claude setup-token` で発行 | サブスク使用量を消費 |

両方セット時の fail fast は「サブスクへ切替えたつもりで API キー削除を忘れ課金が続く」事故を防ぐためです。詳細は [`docs/operations/security.md`](docs/operations/security.md)（認証 / サブスク利用時の注意）。

### Secrets サマリ

| Secret | 要否 | 概要 |
|---|---|---|
| `GITHUB_TOKEN` | 自動 | Actions が自動提供。`permissions:` で権限を絞る |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | いずれか一方が必須 | claude-code-action の認証 |
| `CODEX_REVIEW_REQUEST_TOKEN` | 任意（推奨） | `@codex review` を連携ユーザーとして投稿 |
| `LOOPPILOT_PUSH_TOKEN` | 任意（本番実質必須） | repair commit push 用。required checks 再実行に必要 |

## 設定 (Repository variables)

すべて任意で、未設定ならデフォルトで安全に動きます。よく使うものを抜粋します（全 input は [`loop/action.yml`](loop/action.yml) / [`init/action.yml`](init/action.yml) を参照）。

| Variable | デフォルト | 説明 |
|---|---|---|
| `LOOPPILOT_LABEL` | `loop-pilot` | このラベルを持つ PR のみ対象（default-strict）。**ラベルを repo に作成し PR に付ける必要がある**（未作成だと run が生成されない） |
| `LOOPPILOT_FULL_AUTO` | `false` | `true` でラベルゲートを無効化（全非 fork PR で起動） |
| `MAX_REVIEW_ITERATIONS` | `20` | 1 PR あたりの最大修正回数 |
| `CHECK_COMMAND` | `npm run check` | 修正後に走らせる検証コマンド（allowlist で検証。shell メタ文字・未許可バイナリは fail fast） |
| `BUILD_COMMAND` | （空 = skip） | `CHECK_COMMAND` 通過後・staging 前に走る任意ビルド。`dist/` 等の生成物が `src/` と drift しないようにする。複数ステップは npm script / Makefile に集約 |
| `LOOPPILOT_SEVERITY_THRESHOLD` | `P3` | これ未満の severity を無視。`P3` は P0–P3 すべて対象、`P2` で P3 を skip など |
| `LOOPPILOT_AUTO_MERGE` | `false` | `done / no_findings` 到達時に自動 squash merge。**repo Settings → General → "Allow auto-merge" の有効化が前提**。CI 失敗・HEAD 変化・timeout 等の skip 時は PR コメントで理由を通知 |
| `LOOPPILOT_BLOCK_PATHS` | （空） | `.gitignore` 風の block-path spec。`secrets/`（dir）、`Justfile`（file）、`!Makefile`（default 解除）。`!.github/...` は無視（`.github/` は locked） |
| `CLAUDE_CODE_MODEL_BASE` | `claude-sonnet-4-6` | base tier モデル。escalation 条件が立たない iteration で使用 |
| `CLAUDE_CODE_MODEL_ESCALATED` | `claude-opus-4-7` | escalated tier。P0 finding・直前 CHECK 失敗・同一 findings 再発で使用。`BASE` と同値にすると tiering 無効 |
| `CODEX_BOT_LOGIN` | `chatgpt-codex-connector[bot]` | Codex bot のログイン名（連携先が変わった場合の上書き用） |
| `CODEX_REVIEW_MARKER` | `Codex Review` | Codex 総評コメントの判定マーカー |
| `LOOPPILOT_RESTART_ROLES` | `author,write,maintain,admin` | `/restart-review` を許可するロール |
| `LOOPPILOT_STATE_COMMENT_AUTHORS` | （空 = `github-actions[bot]`） | hidden state comment の信頼 author。GitHub App / machine user で書く場合に設定 |

> auto-merge を使う場合は、リポジトリ Settings → General → Pull Requests → **"Allow auto-merge" を有効化**してください。無効のままだと `gh pr merge --auto` が即 fail し、`⏸️ Auto-merge skipped` の PR コメントで理由が通知されます。

## ドキュメント

- [`docs/README.md`](docs/README.md) — 全体目次
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — 設計概要
- [`docs/architecture/flow-and-state.md`](docs/architecture/flow-and-state.md) — フロー / state 管理
- [`docs/operations/security.md`](docs/operations/security.md) — secrets / トークン権限 / scope check / 認証
- [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) — 停止条件と `/restart-review`
- [`docs/operations/scope-policy.md`](docs/operations/scope-policy.md) — 変更スコープ検査と `LOOPPILOT_BLOCK_PATHS`

## 開発

```bash
npm ci
npm run check     # tsc --noEmit + tests/ typecheck + vitest run
npm run bundle    # dist/ を再生成
```

PR を開くと CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) が typecheck / test / dist drift をチェックします。`src/` を変更したら `npm run bundle` で `dist/` を再生成してコミットしてください（公開 action は `dist/` を実行するため）。

## ライセンス

[MIT](LICENSE)
