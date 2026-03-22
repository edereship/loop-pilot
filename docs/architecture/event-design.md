# イベント設計

## PoC での Workflow 構成

PoC では **2本の workflow** で構成する。設計上の Workflow B（レビュー受信）と C（Claude 修正）は、1つの workflow 内の step として統合する。これにより、workflow 間のデータ受け渡し（PR 番号、findings 等）が不要になる。

本番移植時に分離が必要な場合は、`workflow_call` で Workflow C を切り出す。

---

## Workflow A: PR 作成時（`auto-review-init.yml`）

トリガー:
- `pull_request.opened`
- `pull_request.ready_for_review`

```yaml
on:
  pull_request:
    types: [opened, ready_for_review]
```

前提条件（job の `if`）:
```yaml
if: github.event.pull_request.draft == false
```

- draft PR では自動レビューを起動しない。作成途中のコードに対して Codex レビュー → Claude 修正が走ることを防ぐ
- `ready_for_review` イベントは draft → ready 変換時に発火するため、draft 解除後に初回レビューが起動する

役割:
- hidden comment で状態を初期化（`status: initialized`, `iteration_count: 0`）
- `gh pr comment` で `@codex review` を投稿

---

## Workflow B: Codex レビュー受信 + Claude 修正（`auto-review-loop.yml`）

**タイムアウト:** job に `timeout-minutes: 30` を設定する（デバウンス待機 + Claude API 呼び出し + テスト実行の合計時間。プロジェクトのテスト時間に応じて調整する）。

トリガー:
- `issue_comment` の `created` イベント（Codex の総評コメントを検知）

```yaml
on:
  issue_comment:
    types: [created]
```

前提条件（job の `if`）:
```yaml
if: >
  github.event.issue.pull_request &&
  (github.event.comment.user.login == vars.CODEX_BOT_LOGIN || github.event.comment.user.login == 'chatgpt-codex-connector[bot]') &&
  (contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER) || contains(github.event.comment.body, 'Codex Review'))
```

> **注意: 演算子の優先度と空文字列について:**
> - `&&` は `||` より優先度が高いため、bot 名の `||` フォールバックは必ず括弧で囲むこと。括弧がない場合、意図しない条件で workflow が起動する
> - `contains()` の第2引数に `||` を含む式（例: `vars.X || 'default'`）を渡すと、GitHub Actions の expression evaluator での評価結果が不定。**`contains()` を2つに分けて `||` で繋ぐこと**
> - **空文字列の危険:** `vars.CODEX_BOT_LOGIN` / `vars.CODEX_REVIEW_MARKER` が未設定の場合、空文字列との比較・`contains()` になる。`contains(any_string, '')` は **常に true** を返すため、全コメントで workflow が起動する。**Repository variables にデフォルト値を必ず設定すること**（`CODEX_BOT_LOGIN`: `chatgpt-codex-connector[bot]`, `CODEX_REVIEW_MARKER`: `Codex Review`）

- PR に紐づく issue comment であること
- Codex bot のコメントであること（`CODEX_BOT_LOGIN` Repository variable で制御）
- 総評コメント（`CODEX_REVIEW_MARKER` Repository variable の文言を含む）であること

> **注意:** bot 名・検知文言は OpenAI 側のアップデートで変更される可能性がある。Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）で外部化しているため、変更時は variables を更新するだけで workflow の修正は不要。

### `issue_comment` トリガー特有の注意点

`issue_comment` でトリガーされた workflow は **デフォルトブランチ（main/master）のコード** を checkout する。PR ブランチのコードを操作するには、明示的に PR の head ref を指定する必要がある。

```yaml
- name: Get PR head ref
  id: pr
  run: |
    PR_DATA=$(gh api "/repos/${{ github.repository }}/pulls/${{ github.event.issue.number }}")
    echo "head_ref=$(echo "$PR_DATA" | jq -r '.head.ref')" >> "$GITHUB_OUTPUT"
    echo "head_sha=$(echo "$PR_DATA" | jq -r '.head.sha')" >> "$GITHUB_OUTPUT"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- uses: actions/checkout@v4
  with:
    ref: ${{ steps.pr.outputs.head_ref }}
```

> **注意:** `github.event.issue.pull_request` にはブランチ情報が含まれないため、GitHub API で PR 情報を別途取得する必要がある。

> **注意: push 権限について:** `issue_comment` トリガーで発行される `GITHUB_TOKEN` は、デフォルトブランチのコンテキストで生成される。PR ブランチにブランチ保護ルール（required reviews, status checks 等）が設定されている場合、`GITHUB_TOKEN` による push がブロックされる可能性がある。この場合、以下のいずれかで対処する:
> - ブランチ保護ルールで **"Allow specified actors to bypass required pull requests"** に GitHub Actions bot を追加する
> - `GITHUB_TOKEN` の代わりに GitHub App トークンまたは Fine-grained PAT を使用する（`permissions: contents: write` が必要）
> - PoC 段階ではブランチ保護ルールを緩めるか無効化する

### Workflow B の処理フェーズ

役割（1つの workflow 内で step として順次実行）:

**Phase 1: レビュー受信・集約**
- hidden comment から状態を読み込む
- **ガード条件:** `status` が `fixing` または `stopped` または `done` の場合は即スキップして終了（`fixing`: 先行 workflow と競合するため。`stopped` / `done`: 停止・完了後に Codex の遅延コメントが到着しても再起動しないため）
- `last_processed_review_id`（総評コメントの ID）と比較し、同一レビューは処理しない
- `DEBOUNCE_SECONDS` 待機（インラインコメントが全て出揃うのを待つ）
- GitHub API（`GET /repos/{owner}/{repo}/pulls/{number}/comments`）で PR の review comments を取得
- `chatgpt-codex-connector[bot]` のコメントのみフィルタ
- **取得範囲の絞り込み:** `last_codex_review_received_at` 以降に `created_at` を持つコメントのみを対象とする。過去の iteration のコメントを再処理しないため（詳細は後述「インラインコメントの取得範囲」を参照）
- P0 / P1 を severity バッジの正規表現で抽出（→ [Severity パーサー仕様](../specs/severity-parser.md)）

**インラインコメントの取得範囲:**

`GET /repos/{owner}/{repo}/pulls/{number}/comments` は PR の **全インラインコメント** を返す。過去の iteration で修正済みの指摘を再処理しないため、以下の条件でフィルタする。

1. `comment.user.login == 'chatgpt-codex-connector[bot]'`
2. `comment.created_at > last_codex_review_received_at`（前回処理時点より後のコメントのみ）
3. 上記を満たすコメントのみを findings 抽出の対象とする

初回（`last_codex_review_received_at` が null）の場合は、`chatgpt-codex-connector[bot]` の全インラインコメントを対象とする。

> **注意:** GitHub API の `since` パラメータは review comments エンドポイントではサポートされていない場合がある。クライアント側で `created_at` をフィルタすること。

**Phase 2: 判定**
- P0 / P1 が 0 件 → `status: done` で終了
- `iteration_count >= MAX_REVIEW_ITERATIONS` → `status: stopped` で終了
- `findings_hash_history`（直近 N 回分）と比較し、同一指摘ループ → `status: stopped` で終了（→ [ループ検知](../specs/loop-detection.md)）
- 上記以外 → Phase 3 へ

**Phase 3: Claude 修正**
- `status: fixing` に更新
- PR ブランチを checkout
- Claude API に findings を送信し、修正コードを取得（→ [Claude 修正エンジン仕様](../specs/claude-fix-engine.md)）
- ファイルに適用
- test / lint / typecheck 実行（→ [検証コマンドとロールバック](../operations/check-and-rollback.md)）
- 成功 → commit / push、`iteration_count += 1`
- 失敗 → `status: stopped` で終了

**Phase 4: 再レビュー依頼**
- `gh pr comment` で `@codex review` を投稿
- `status: waiting_codex` に更新

---

## 重複処理防止

### 防ぐべき問題
- 同じ Codex review を複数回処理してしまう
- インラインコメントごとに Claude が多重起動する
- Claude 自身の push / comment で再帰起動する

### 対策

#### 1. review id で冪等化
- `last_processed_review_id` を保存
- 同じ review は再処理しない

#### 2. concurrency 制御
PR ごとに同時実行を防ぐ。

```yaml
concurrency:
  # Workflow B のトリガーは issue_comment のため、pull_request オブジェクトは存在しない
  group: pr-${{ github.event.issue.number }}-auto-fix
  cancel-in-progress: false
```

> **注意:** GitHub Actions の concurrency キューは **最大1つまで** しか待機できない。3つ目以降の workflow 実行が発生すると、待機中の実行がキャンセルされ最新の実行に置き換わる。短時間に Codex が複数回 review した場合、中間の review が未処理のまま残る可能性がある。ただし、`last_processed_review_id` による冪等化と、次回 iteration で最新の review comments を再取得する設計により、実質的な影響は軽微。本番移植時にこの動作が許容できない場合は、外部キュー（SQS 等）の導入を検討する。

#### 3. actor フィルタ
- **`chatgpt-codex-connector[bot]`** のコメントのみ対象
- Claude bot（GitHub Actions bot）のコメントや push では起動しない
- 判定: `github.event.comment.user.login == 'chatgpt-codex-connector[bot]'`
- 総評コメントであることを `contains(github.event.comment.body, 'Codex Review')` で確認

#### 4. workflow の責務分離
- **Workflow A:** PR 初期化 + 初回 `@codex review`
- **Workflow B:** Codex レビュー受信 + Claude 修正 + 再レビュー依頼

の2本に分けることで、再帰や誤起動を防ぐ

#### 5. デバウンス待機
- review 受信後すぐには Claude を起動しない
- 一定時間待ってから review 一式を取得する
- コメントの到着タイミング差を吸収する

---

## 関連ドキュメント

- [システム概要](system-overview.md) — 基本方針・パラメータ
- [推奨フローと状態管理](flow-and-state.md) — ステップ詳細・状態遷移
- [セキュリティ](../operations/security.md) — トークンスコープ・push 権限
- [全ドキュメント索引](../README.md)
