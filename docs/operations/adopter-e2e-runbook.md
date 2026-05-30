# 外部 adopter sandbox E2E runbook (TY-349)

LoopPilot 管理外の sandbox repository を adopter と見立て、**公開された `@v1` と生成された
caller だけ**で導入が完了し、初回 PR で LoopPilot が観測可能に動くことを受け入れ検証する
ための手順書。プラットフォーム制約（Codex GitHub App 連携・secret 値投入・新規 repo 作成・
公開 release）で自動化できない部分は **human-required** として明示する。

## このドキュメントの位置づけ

- **自動で検証済み（このリポジトリ内で完了）** … 下記「自動 pre-verification」を参照。
- **human-required（運用者が実行）** … 下記「実行手順」を、上から順に実施する。
- 検証中に見つかった product bug は **別チケットに切り出す**（その場しのぎの回避をしない）。

---

## 自動 pre-verification（完了済み）

外部 repo を作らずに検証できる範囲は、本リポジトリの CI / CLI で確認済み。

| 項目 | 結果 | 根拠 |
|---|---|---|
| 再利用可能ワークフローが `workflow_call` として妥当 | ✅ | `tests/reusable-workflows.test.ts`、YAML parse、構造アサーション、PR #3 の adversarial review |
| dogfooding caller → reusable workflow が実イベントで解決 | ✅ | PR #3 CI で `init / init` が caller 経由で起動し gate skip（実 `pull_request` イベント） |
| CLI が薄い caller（`@v1` 参照・secret 列挙・完全 permissions・`language`）を生成 | ✅ | `cli/tests/caller-templates.test.ts`（fixture 一致）、`gh looppilot init --dry-run` |
| toolchain 自動検出（Node/Python/Go/Rust/Make） | ✅ | `cli/tests/toolchain.test.ts` |
| pre-flight が silent-failure を可視化（label/Codex/push token/toolchain/Anthropic） | ✅ | `cli/tests/checks*.test.ts`、`gh looppilot doctor` を実 repo で実行 |
| pre-flight の 403 → `unknown` 降格・`--json`・exit code 0/1/2 | ✅ | `cli/tests/preflight.test.ts` / `gather.test.ts` |

`gh looppilot doctor`（team-yubune/loop-pilot に対して実行）の実測:

```
✗ ERROR  label.gate              gate label 'loop-pilot' is missing
✗ ERROR  secret.anthropicAuth    no Anthropic credential is set
? UNKWN  codex.connection        no recent activity from chatgpt-codex-connector[bot]
✓ OK     secret.loopPilotPushToken
✓ OK     autoMerge.config
! WARN   secret.codexReviewToken CODEX_REVIEW_REQUEST_TOKEN is not set
✓ OK     toolchain.checkCommand  npm run check
Summary: 3 ok, 1 warning, 2 error, 1 unknown — fix the errors above before the first PR   (exit 1)
```

→ pre-flight は正常系・警告・error・unknown を区別して可視化できている。

---

## ⛔ 受け入れ検証の前提（ブロッカー）: `@v1` の張り替え

**現状 `v1` タグは `3b4630c`（packaging 前）を指しており、再利用可能ワークフローを含まない。**
そのため外部 adopter の caller が参照する `team-yubune/loop-pilot/.github/workflows/loop.yml@v1`
は **今は 404 で解決できない**。E2E の実施前に `v1` を packaging 後の `main` へ張り替える必要がある。

検証コマンド（張り替え前の現状確認）:

```bash
git cat-file -e v1:.github/workflows/loop.yml 2>/dev/null && echo present || echo "ABSENT (404 for adopters)"
gh release list --repo team-yubune/loop-pilot      # → まだ無い
```

### v1 を張り替える（human-required / 公開操作 → 承認が必要）

TY-342 の `release.yml` がタグ駆動で自動処理する。`main` を最新化したうえで:

```bash
git fetch origin && git checkout main && git pull --ff-only
git tag v1.0.0            # main HEAD（packaging 一式を含む）に付与
git push origin v1.0.0    # → .github/workflows/release.yml が起動
```

`release.yml` が自動で: `dist/` drift 検査 → サブアクション `@v1` 参照整合検査
（`loop/action.yml` / `init/action.yml` / 再利用ワークフロー）→ moving `v1` を
`v1.0.0` の commit へ force 張り替え → GitHub Release 作成（`--generate-notes`）。

> **影響:** `v1` を consume している既存 adopter がいれば、その参照先が packaging 後へ進む
> （破壊的変更ではないが内部実装が大きく変わる）。初回公開のため運用者の承認のうえ実施する。
> 失敗時の手動フォールバックは [releasing.md](releasing.md) を参照。

張り替え後の確認:

```bash
git ls-remote --tags origin v1 v1.0.0     # 両者が同一 SHA
gh release view v1.0.0 --repo team-yubune/loop-pilot
gh api repos/team-yubune/loop-pilot/contents/.github/workflows/loop.yml?ref=v1 --jq .name   # → loop.yml
```

---

## 実行手順（human-required）

### 0. sandbox repository を用意（新規 repo 作成 → 承認が必要）

```bash
gh repo create team-yubune/loop-pilot-sandbox --public --description "LoopPilot adopter E2E sandbox"
```

- LoopPilot 本体 repo とは**別 repo**。Node の happy-path fixture を最初の対象にする
  （`package.json` に `check`/`test` script、わざと直せる軽微な指摘が出るコード）。
- 可能なら Python / Go / Rust / Make のいずれか 1 つを追加 smoke にする（`language` 切替の確認）。

### 1. 導入（2 経路のどちらかを使い、どちらを使ったか記録する）

**経路 A: README の薄い caller を手で置く（extension 不要・最速）**
sandbox repo に以下 2 ファイルを追加（CLI が生成するものと同一。`language` は toolchain に合わせる）:

`.github/workflows/looppilot-init.yml`:
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

`.github/workflows/looppilot-loop.yml`:
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

**経路 B: CLI で生成（`gh-looppilot` extension 抽出後）**
```bash
gh extension install team-yubune/gh-looppilot   # ADR-0001 の抽出後に有効
cd <sandbox clone>
gh looppilot init        # caller 生成・ラベル作成・CHECK_COMMAND 提案・手動手順・pre-flight
```
> extension 抽出（`team-yubune/gh-looppilot` 作成 + `cli/` 移送）は human-required。
> 抽出前は経路 A を使い、CLI との手順差分（生成物が同一であること）を記録する。

### 2. ゲートラベル / Repository variables / secrets

```bash
# ゲートラベル（経路 B の CLI は冪等作成する。経路 A は手動）
gh label create loop-pilot --color BFD4F2 --description "Run LoopPilot on this PR" --repo team-yubune/loop-pilot-sandbox
# 必要に応じて Repository variables（任意。未設定でも安全な default）
gh variable set CHECK_COMMAND --body "npm run check" --repo team-yubune/loop-pilot-sandbox
```

secrets（**値の投入は human-required**。CLI/コードからは設定できない）:
- `ANTHROPIC_API_KEY` **または** `CLAUDE_CODE_OAUTH_TOKEN`（どちらか一方）
- `CODEX_REVIEW_REQUEST_TOKEN`（推奨。Codex 連携ユーザーの fine-grained PAT）
- `LOOPPILOT_PUSH_TOKEN`（required checks / auto-merge を使うなら）

### 3. Codex GitHub App 連携（human-required / プラットフォーム制約で自動化不可）

ChatGPT Codex の GitHub App を sandbox repo に連携する。pre-flight は連携自体を確定判定できず、
`codex.connection` を活動有無から **推定（unknown/ok）** するに留まる。

### 4. pre-flight を実行（正常系 + 代表的な失敗系を最低 2 つ）

```bash
gh looppilot doctor --json   # 経路 B
# もしくは（extension 抽出前）本体 repo の cli を使う:
#   git clone team-yubune/loop-pilot && cd loop-pilot && npm ci && npm run bundle:cli
#   (cd <sandbox> && <loop-pilot>/cli/gh-looppilot doctor)
```

確認する失敗系（最低 2 つ。例）:
- **ラベル無し** … `label.gate = error` + 作成コマンド提示。
- **`LOOPPILOT_PUSH_TOKEN` 無し + required checks 有り** … `secret.loopPilotPushToken = warning`。
- **Codex 連携未確認** … `codex.connection = unknown`（degrade 表示）。
- **非 Node toolchain mismatch** … `toolchain.checkCommand = warning`。

正常系（ラベル作成・secret 投入・Codex 連携後）で error が 0 になり exit 0 を確認する。

### 5. 初回 PR で end-to-end を観測

sandbox repo で「わざと直せる軽微な指摘が出る」変更の PR を作り、ラベルを付ける。期待する主要経路:

- [ ] init workflow が **state comment** と **`@codex review`** を作る
- [ ] Codex review を契機に **loop workflow** が起動する
- [ ] Claude 修正 → **CHECK_COMMAND** 実行 → **scope/secret check** → **commit/push**
- [ ] **再 `@codex review`** が投稿される
- [ ] 最終的に **`done/no_findings`** に到達する、または意図した停止理由が PR 上に明示される
      （stop notification に次アクションが書かれていること）

### 6. 実測ログを記録（下記テンプレートを runbook 末尾か別 doc に追記）

---

## 実測ログ・テンプレート

```
日時:
sandbox repo:
v1 SHA / release:               (git ls-remote --tags origin v1 / gh release view v1.0.0)
導入経路:                        A(README 手置き) / B(gh looppilot init)
init workflow run URL:
Codex review:                    起動した / しない（理由）
loop workflow run URL:
PR URL:
最終状態:                        done/no_findings / stopped(理由) / 未到達(理由)
pre-flight 出力（正常系 / 失敗系）:
詰まった点:
修正すべき docs / product bug（→ チケット番号）:
```

---

## human-required ゲート一覧（このセッションで自動化できなかった項目）

| # | 操作 | 種別 | 備考 |
|---|---|---|---|
| 1 | `v1.0.0` タグ push（→ `v1` 張り替え + Release 作成） | 公開 / irreversible | E2E の前提。`release.yml` が自動処理 |
| 2 | `team-yubune/gh-looppilot` 作成 + `cli/` 抽出 | 新規 repo 作成 / 公開 | 経路 B（CLI install）の前提。抽出前は経路 A |
| 3 | `team-yubune/loop-pilot-sandbox` 作成 | 新規 repo 作成 | 別 repo の adopter 見立て |
| 4 | Codex GitHub App 連携 | プラットフォーム | 自動化不可。pre-flight は推定のみ |
| 5 | secret 値の投入（Anthropic / Codex / push token） | secret | 値はコードから設定不可 |

---

## 既知の gotcha / docs 改善メモ

- 本体 `README.md` のクイックスタートは現状 **手動の薄い caller 経路**を案内している。`gh-looppilot`
  extension 公開（ゲート #2）後に CLI 経路（`gh extension install` → `gh looppilot init`）へ
  更新する。それまで README に CLI を主導線として書くと「install できない」混乱を生むため書かない。
- dogfooding caller はローカル参照（`./.github/workflows/*.yml`）+ `secrets: inherit` を使い、
  外部 adopter は tagged ref + secret 明示列挙。sandbox は**後者**で検証すること。
- `language: none`（make 等）は runner プリインストール頼みのため、CHECK_COMMAND が
  プリインストール済みコマンドで完結することを確認する。
