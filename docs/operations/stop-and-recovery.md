# 停止条件とリカバリ

## 停止条件

### 正常終了
- 最新 Codex review の P0 / P1 が 0 件

PR #7 で実測済み。Codex の `Codex Review: Didn't find any major issues.` コメントを受け、Workflow B が `done / no_findings` に更新し、完了コメントを投稿した。

### 強制停止
- iteration_count >= `MAX_REVIEW_ITERATIONS`

PoC では `MAX_REVIEW_ITERATIONS=1` でコストを制限して E2E を実施した。上限到達停止そのものは設計・テスト対象だが、PR #7 の最終結果は上限停止ではなく正常終了。

### 異常停止
以下のような場合は停止候補とする。

- Claude が安全に修正できない
- test / lint / typecheck が通らない（→ [検証コマンドとロールバック](check-and-rollback.md)）
- 同一指摘が繰り返される（→ [ループ検知](../specs/loop-detection.md)）
- 同一箇所の修正が収束しない

PR #7 の途中検証では `state_corrupted`、`CHECK_COMMAND failed`、Claude no-edit による停止相当の課題を観測し、それぞれ後続修正で解消した。最終 E2E では停止せず正常終了した。

---

## 停止時コメント例

```text
Automation stopped.

Reason: reached max iterations (MAX_REVIEW_ITERATIONS)
Last processed Codex review: #987654321
Open P0/P1 findings remaining: 1
Recommendation: manual intervention required.
```

---

## 停止後のリカバリ手順

自動修正が停止した後、人間が修正を加えて再開する手順を定義する。

### 再開方法
1. 人間が修正を commit / push する
2. PR に `@codex review` を手動投稿する
3. Workflow B が通常通り起動し、ループが再開される

### 状態のリセットが必要なケース
- `iteration_count >= MAX_REVIEW_ITERATIONS` で停止した場合: hidden comment の `iteration_count` を手動で 0 にリセットするか、コメントを削除して再初期化する
- ループ検知で停止した場合: 人間の修正により指摘内容が変わるため、リセット不要。ただし `status` を `waiting_codex` に戻す
- `claude_api_error` で停止した場合: 修正不能な指摘（バンドル再生成など TS ファイル編集では解消できないもの）が原因。人間がそのコミットを行った後、`status` を `waiting_codex` に戻し、`stopReason` を `null` にし、`lastProcessedReviewId` と `lastCodexReviewReceivedAt` を最新の Codex review に揃えてから `@codex review` を再投稿する
- `test_failure` で停止した場合: 人間がテストを修正してから `status` を `waiting_codex` に戻して `@codex review` を再投稿する

### hidden comment の手動編集（暫定手順）

TY-144 が実装されるまでの暫定手順。**`maintainer` または PR 作成者のみ** 実施する。

1. PR の hidden comment（`<!-- auto-review-state ... -->` を含むコメント）を特定する
2. `gh api` で当該コメントの body を取得し JSON 部分を抽出する
3. 必要なフィールドを変更（典型的には `status` を `waiting_codex` に、`stopReason` を `null` に）
4. `gh api -X PATCH /repos/:owner/:repo/issues/comments/:id -f body=<新しい body>` で更新
5. リセットの理由・操作者・対象 review ID を含む audit コメントを PR に投稿する
6. PR に `@codex review` を投稿して検証を再開する

> **Important:** TY-144 で `/reset-review` PR コマンドを実装した後はこの手動手順を廃止する。手動編集は state が壊れる事故が起きやすいため、運用に組み込まないこと。

**PoC 段階:** 手動リカバリで十分。本番移植時に `/reset-review` のような PR コマンドを検討する。

PR #7 では人間が再度 `@codex review` を投稿して検証を再開する手順を複数回実施した。PR #14 では `claude_api_error` 停止後に hidden comment を手動でリセットして検証を継続した。本番ではこの手順を `/reset-review` などの明示コマンドへ寄せるかを TY-13 で判断する。

**後続 Issue:** `/reset-review` と hidden state recovery は TY-144 で追跡する。初期移植では手動復旧で代替可能だが、`MAX_REVIEW_ITERATIONS` 到達、state corruption、`claude_api_error`、hidden comment 消失時に人間が hidden JSON を直接編集しなくて済む状態を目標にする。PR #14 で `claude_api_error` 停止が実測されたため、TY-144 は High に昇格済み。

---

## 関連ドキュメント

- [推奨フローと状態管理](../architecture/flow-and-state.md) — 状態遷移の全体像
- [ループ検知](../specs/loop-detection.md) — 同一指摘ループの検知アルゴリズム
- [検証コマンドとロールバック](check-and-rollback.md) — テスト失敗時の挙動
- [全ドキュメント索引](../README.md)
