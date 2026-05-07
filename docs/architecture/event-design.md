# イベント設計

## PoC での Workflow 構成

PoC では **2本の workflow** で構成する。設計上の Workflow B（レビュー受信）と C（Claude 修正）は、1つの workflow 内の step として統合する。これにより、workflow 間のデータ受け渡し（PR 番号、findings 等）が不要になる。

本番移植時に分離が必要な場合は、`workflow_call` で Workflow C を切り出す。

---

## Workflow A: PR 作成時（`auto-review-init.yml`）

**PoC 実測:** PR #7 で hidden comment 作成と `CODEX_REVIEW_REQUEST_TOKEN` 経由の `@codex review` 投稿を確認済み。GitHub Actions bot ではなく接続済みユーザーとして投稿され、Codex review が起動した。

トリガー:
- `pull_request.opened`
- `pull_request.ready_for_review`
- `pull_request.labeled`（後付けで起動ラベルを付けたケース用）

```yaml
on:
  pull_request:
    types: [opened, ready_for_review, labeled]
```

前提条件（job の `if`）:
```yaml
if: >
  github.event.pull_request.draft == false &&
  github.event.pull_request.head.repo.full_name == github.repository &&
  (
    (vars.AUTO_REVIEW_FULL_AUTO == 'true' && github.event.action != 'labeled') ||
    (
      vars.AUTO_REVIEW_FULL_AUTO != 'true' &&
      contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix') &&
      (github.event.action != 'labeled' || github.event.label.name == (vars.AUTO_REVIEW_LABEL || 'auto-review-fix'))
    )
  )
```

- draft PR では自動レビューを起動しない。作成途中のコードに対して Codex レビュー → Claude 修正が走ることを防ぐ
- `ready_for_review` イベントは draft → ready 変換時に発火するため、draft 解除後に初回レビューが起動する
- fork PR では自動レビューを起動しない。外部コードに対して token を持つ auto-fix loop を開始しないため
- **デフォルト挙動はラベル必須（default-strict）**。Repository variable `AUTO_REVIEW_LABEL` が空 / 未設定なら `auto-review-fix` ラベルを要求する（ラベル名は Codex レビュー＋ Claude 自動修正の両方を示すため `auto-review-fix`）。`AUTO_REVIEW_LABEL` を設定すれば任意のラベル名へ変更可能
- 完全自動化（全 PR で起動）にしたい場合のみ `AUTO_REVIEW_FULL_AUTO=true` を Repository variable で設定する。設定すると label gate が無効化され、すべての非 fork ready PR で Workflow A が起動する
- `AUTO_REVIEW_FULL_AUTO=true` 時は `labeled` イベントを Workflow A の起動条件から除外する。`main-init.ts` は state を初期化して `@codex review` を再投稿する設計のため、ラベル編集のたびに重複レビューと余分な auto-fix サイクルが起きるのを防ぐ
- gate 有効時の `labeled` イベントは、付与されたラベルが要求ラベル（`AUTO_REVIEW_LABEL || 'auto-review-fix'`）と一致する場合だけ起動する。無関係なラベルが追加されただけでは Workflow A は走らない

役割:
- hidden comment で状態を初期化（`status: initialized`, `iteration_count: 0`）
- `gh pr comment` で `@codex review` を投稿
- `CODEX_REVIEW_REQUEST_TOKEN` が設定されている場合、`@codex review` の投稿だけ接続済みユーザー PAT を使用する。未設定時は `GITHUB_TOKEN` に fallback する

---

## Workflow B: Codex レビュー受信 + Claude 修正（`auto-review-loop.yml`）

**PoC 実測:** PR #7 で `pull_request_review.submitted` トリガーから Workflow B が起動し、PR head checkout、Claude 修正、`CHECK_COMMAND`、commit/push、再 `@codex review` まで成功した。再レビュー後は Codex の no major issues コメントを `issue_comment` トリガーで処理し、`done / no_findings` で終了した。

**タイムアウト:** job に `timeout-minutes: 30` を設定する（デバウンス待機 + Claude API 呼び出し + テスト実行の合計時間。プロジェクトのテスト時間に応じて調整する）。

トリガー:
- `pull_request_review` の `submitted` イベント（Codex のレビュー投稿を検知）
- 互換用に `issue_comment` の `created` イベント（Codex の総評コメント）も許可する

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
```

前提条件（job の `if`）:
```yaml
if: >
  (
    vars.AUTO_REVIEW_FULL_AUTO == 'true' ||
    contains(github.event.issue.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix') ||
    contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix')
  ) &&
  (
    (
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      (
        github.event.comment.user.login == 'chatgpt-codex-connector[bot]' ||
        (vars.CODEX_BOT_LOGIN != '' && github.event.comment.user.login == vars.CODEX_BOT_LOGIN)
      ) &&
      (
        contains(github.event.comment.body, 'Codex Review') ||
        (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER))
      )
    ) ||
    (
      github.event_name == 'pull_request_review' &&
      github.event.review.state == 'commented' &&
      (
        github.event.review.user.login == 'chatgpt-codex-connector[bot]' ||
        (vars.CODEX_BOT_LOGIN != '' && github.event.review.user.login == vars.CODEX_BOT_LOGIN)
      ) &&
      (
        contains(github.event.review.body, 'Codex Review') ||
        (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.review.body, vars.CODEX_REVIEW_MARKER))
      )
    )
  )
```

> **注意: 演算子の優先度と空文字列について:**
> - `&&` は `||` より優先度が高いため、bot 名の `||` フォールバックは必ず括弧で囲むこと。括弧がない場合、意図しない条件で workflow が起動する
> - `contains()` の第2引数に `||` を含む式（例: `vars.X || 'default'`）を渡すと、GitHub Actions の expression evaluator での評価結果が不定。**`contains()` を2つに分けて `||` で繋ぐこと**
> - **空文字列の危険:** `contains(any_string, '')` は **常に true** を返す。`vars.CODEX_REVIEW_MARKER` は `vars.CODEX_REVIEW_MARKER != ''` を確認してから `contains()` に渡すこと。bot 名も `vars.CODEX_BOT_LOGIN != ''` を確認してから比較すること
> - Repository variables 未設定時も fallback の `chatgpt-codex-connector[bot]` と `Codex Review` だけで判定する。設定時は fallback と設定値のどちらも許可する

- PR に紐づく `issue_comment` または `pull_request_review` であること
- Codex bot の投稿であること（`CODEX_BOT_LOGIN` Repository variable で制御）
- レビュー本文または総評コメントに `CODEX_REVIEW_MARKER` Repository variable の文言を含むこと
- `AUTO_REVIEW_FULL_AUTO != 'true'` の場合（デフォルト）はトリガー payload の labels（`issue_comment` は `github.event.issue.labels`、`pull_request_review` は `github.event.pull_request.labels`）に `AUTO_REVIEW_LABEL || 'auto-review-fix'` が含まれていること
- `AUTO_REVIEW_FULL_AUTO == 'true'` の場合は label 確認をスキップ

> **ランタイム再確認:** YAML の `if` で評価される labels は trigger 時点のスナップショットなので、Codex 投稿後にラベルが外された場合は Workflow B の TS 側で再度 `GET /repos/{owner}/{repo}/issues/{pr}/labels` を呼び、ラベルが残っているかを確認する。残っていない場合は state を変えずに早期 return する（後述「Phase 0 ラベルゲート」）。

推奨 Repository variables:

- `CODEX_BOT_LOGIN=chatgpt-codex-connector[bot]`
- `CODEX_REVIEW_MARKER=Codex Review`
- `AUTO_REVIEW_LABEL=auto-review-fix`（カスタムラベル名を使う場合のみ。未設定なら `auto-review-fix` をフォールバック使用）
- `AUTO_REVIEW_FULL_AUTO=true`（label gate を無効化して全 PR で起動したい場合のみ）

PR #7 の実環境では上記推奨値で Codex review を検知できた。

> **注意:** bot 名・検知文言は OpenAI 側のアップデートで変更される可能性がある。Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）で外部化しているため、変更時は variables を更新するだけで workflow の修正は不要。未設定または空文字の場合でも fallback 条件だけで評価され、空文字 `contains()` は実行されない。

### Codex review request token

Codex が GitHub 連携済みユーザーのメンションとして `@codex review` を認識できるように、Workflow A/B は action input `codex-review-request-token` を受け取る。

```yaml
- uses: ./init
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

```yaml
- uses: ./loop
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

- `CODEX_REVIEW_REQUEST_TOKEN` は Repository secrets に登録する
- 設定する token は Codex と GitHub を接続済みのユーザーが発行した Fine-grained PAT とする
- この token は `@codex review` 投稿専用であり、hidden comment、checkout/push、Artifact 収集、review comment 取得などは従来通り `GITHUB_TOKEN` を使う
- secret 未設定時は `GITHUB_TOKEN` に fallback し、既存 workflow との互換性を保つ

### review / issue_comment トリガー特有の注意点

`pull_request_review` / `issue_comment` でトリガーされた workflow は、PR ブランチを自動 checkout しない。PR ブランチのコードを操作するには、明示的に PR の head ref を指定する必要がある。

```yaml
- name: Get PR head ref
  id: pr
  run: |
    PR_DATA=$(gh api "/repos/${{ github.repository }}/pulls/${PR_NUM}")
    echo "head_ref=$(echo "$PR_DATA" | jq -r '.head.ref')" >> "$GITHUB_OUTPUT"
    echo "head_sha=$(echo "$PR_DATA" | jq -r '.head.sha')" >> "$GITHUB_OUTPUT"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}

- uses: actions/checkout@v4
  with:
    ref: ${{ steps.pr.outputs.head_ref }}
```

> **注意:** `issue_comment` では `github.event.issue.pull_request` にブランチ情報が含まれず、`pull_request_review` でも fork guard 用の head repo 判定を統一したいため、GitHub API で PR 情報を別途取得する。

Workflow B は GitHub API で取得した `.head.repo.full_name` が空または `github.repository` と異なる場合、fork PR または source repo 不明として `Run auto-fix loop` より前に停止する。`pr-head-ref` は action input として渡した後、action 側で ref 名の危険文字を検査してから checkout する。

> **注意: push 権限について:** PR ブランチにブランチ保護ルール（required reviews, status checks 等）が設定されている場合、`GITHUB_TOKEN` による push がブロックされる可能性がある。この場合、以下のいずれかで対処する:
> - ブランチ保護ルールで **"Allow specified actors to bypass required pull requests"** に GitHub Actions bot を追加する
> - `GITHUB_TOKEN` の代わりに GitHub App トークンまたは Fine-grained PAT を使用する（`permissions: contents: write` が必要）
> - PoC 段階ではブランチ保護ルールを緩めるか無効化する
>
> **PoC 実測:** Repository UI では default workflow permission を write に変更できない環境だったが、workflow YAML の `permissions: contents: write` により PR #7 の head branch へ commit/push できた。

### Workflow B の処理フェーズ

役割（1つの workflow 内で step として順次実行）:

**Phase 0: ラベルゲート（default-strict, full-auto opt-out）**
- `AUTO_REVIEW_FULL_AUTO == true` の場合は本フェーズをスキップ
- それ以外（デフォルト）では `GET /repos/{owner}/{repo}/issues/{pr}/labels` で現在のラベルを取得
- 起動ラベル `AUTO_REVIEW_LABEL || 'auto-review-fix'` が付いていなければ、state を変更せずに即 return（hidden comment や findings は触らない）
- ラベル比較は case-insensitive で workflow YAML の `contains()` と整合させる

**Phase 1: レビュー受信・集約**
- hidden comment から状態を読み込む
- **ガード条件:** `status` が `fixing` または `stopped` または `done` の場合は即スキップして終了（`fixing`: 先行 workflow と競合するため。`stopped` / `done`: 停止・完了後に Codex の遅延コメントが到着しても再起動しないため）
- `last_processed_review_id`（trigger comment/review の ID）と比較し、同一レビューは処理しない
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
- `@codex review` を投稿する。`CODEX_REVIEW_REQUEST_TOKEN` が設定されている場合は接続済みユーザー PAT を使い、未設定時は `GITHUB_TOKEN` に fallback する
- `status: waiting_codex` に更新

**PoC で未検証の境界:**
- `issue_comment` トリガーでの done 終了は確認済み。ただし、互換用 `issue_comment` 経由で修正 commit/push まで進むケースは未検証
- `DEBOUNCE_SECONDS=0` は未検証。PR #7 ではデフォルト待機で安定動作を確認した
- `concurrency` の多重 review 競合は設計上の対策のみで、実 PR で意図的な競合は発生させていない
- 複数 Codex 指摘を同時に受けた E2E は未検証。TY-138 で統合テストを追加する
- 本番で `issue_comment` 互換 trigger を正式対応にするか、`pull_request_review` 主体に限定するかは TY-142 で判断する

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
  group: pr-${{ github.event.issue.number || github.event.pull_request.number }}-auto-fix
  cancel-in-progress: false
```

> **注意:** GitHub Actions の concurrency キューは **最大1つまで** しか待機できない。3つ目以降の workflow 実行が発生すると、待機中の実行がキャンセルされ最新の実行に置き換わる。短時間に Codex が複数回 review した場合、中間の review が未処理のまま残る可能性がある。ただし、`last_processed_review_id` による冪等化と、次回 iteration で最新の review comments を再取得する設計により、実質的な影響は軽微。本番移植時にこの動作が許容できない場合は、外部キュー（SQS 等）の導入を検討する。

#### 3. actor フィルタ
- **`chatgpt-codex-connector[bot]`** のコメントのみ対象
- Claude bot（GitHub Actions bot）のコメントや push では起動しない
- 判定: `github.event.comment.user.login` または `github.event.review.user.login` が `chatgpt-codex-connector[bot]`、または非空の `vars.CODEX_BOT_LOGIN` と一致
- trigger body に `contains(..., 'Codex Review')` または、非空の `vars.CODEX_REVIEW_MARKER` を含むことを確認

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
