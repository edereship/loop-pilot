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

### `/restart-review` による再実行

`stopped` または `done(no_findings)` になった auto-review は、PR の issue comment に restart command を投稿して再実行する。hidden comment JSON を直接編集しない。

```text
/restart-review
```

soft restart。state を `waiting_codex` に戻し、同じ run で `@codex review` を投稿する。以下の状態から再実行できる。

- `claude_api_error`
- `test_failure`
- `manual_stop`
- `max_iterations`（`--hard` 推奨）
- `loop_detected`（`--hard` 推奨）
- `no_findings`（`done` 状態）
- `waiting_codex`

保持する状態:

- `iterationCount`
- `findingsHashHistory`
- `lastClaudeCommitSha`
- `lastFindingsHash`

書き換える状態:

- `status`: `stopped` または `done` → `waiting_codex`
- `stopReason`: 対象停止理由 → `null`
- `lastProcessedReviewId`: `null`
- `lastCodexReviewReceivedAt`: 保持する（過去の Codex inline comment を再処理しないため）
- `lastCodexRequestCommentId`: 新しく投稿した `@codex review` comment ID

```text
/restart-review --hard
```

hard restart。soft restart の操作に加えて、`iterationCount` を `0`、`findingsHashHistory` を `[]`、`lastFindingsHash` を `null` に戻す。

`max_iterations` は上限判定を抜けるために hard restart が適している。`loop_detected` は履歴を消すため、人間が修正済みであることを確認してから使う。

### 権限

`/restart-review` を実行できるユーザーは `AUTO_REVIEW_RESTART_ROLES` で制御する。

- デフォルト: `author,write,maintain,admin`
- `author`: PR 作成者
- `write` / `maintain` / `admin`: GitHub collaborator permission

権限不足の場合、状態は変更せず、PR に拒否コメントを残す。

### 再開フロー

1. 人間が修正を commit / push する
2. 通常は `/restart-review`、回数・履歴も消したい場合は `/restart-review --hard` をPRコメントに投稿する
3. Workflow B が hidden state を `waiting_codex` に戻す
4. Workflow B が `@codex review` を投稿し、Codex の再レビューを起動する

### 状態のリセットが必要なケース
- `iteration_count >= MAX_REVIEW_ITERATIONS` で停止した場合: `/restart-review --hard`
- ループ検知で停止した場合: 人間の修正で指摘内容が変わったことを確認してから `/restart-review --hard`
- `claude_api_error` で停止した場合: 人間が必要な修正を commit / push してから `/restart-review`
- `test_failure` で停止した場合: 人間がテストを修正してから `/restart-review`
- `done(no_findings)` 後に同じ PR を再度レビュー・修正ループにかけたい場合: `/restart-review`

### `state_corrupted` の手動復旧

state JSON が壊れている場合、`/restart-review` は状態を安全に読めないため拒否される。この場合のみ、maintainer が hidden comment を削除して再初期化する。

1. PR の hidden comment（`<!-- auto-review-state ... -->` を含むコメント）を特定する
2. `gh api -X DELETE /repos/:owner/:repo/issues/comments/:id` で削除する
3. Workflow A を手動 dispatch、またはPR操作で再実行して hidden comment を再作成する
4. PR に復旧理由・操作者を含む audit コメントを投稿する

PR #7 では人間が再度 `@codex review` を投稿して検証を再開する手順を複数回実施した。PR #14 では `claude_api_error` 停止後に hidden comment を手動でリセットして検証を継続した。TY-162 以降は、通常の再実行では `/restart-review` を使い、hidden JSON の直接編集は運用に組み込まない。

---

## 関連ドキュメント

- [推奨フローと状態管理](../architecture/flow-and-state.md) — 状態遷移の全体像
- [ループ検知](../specs/loop-detection.md) — 同一指摘ループの検知アルゴリズム
- [検証コマンドとロールバック](check-and-rollback.md) — テスト失敗時の挙動
- [全ドキュメント索引](../README.md)
