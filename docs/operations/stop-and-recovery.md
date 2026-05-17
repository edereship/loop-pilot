# 停止条件とリカバリ

## 停止条件

### 正常終了
- 最新 Codex review の閾値以上 finding が 0 件（`AUTO_REVIEW_SEVERITY_THRESHOLD` で制御、default `P2`。TY-256）

PR #7 で実測済み。Codex の `Codex Review: Didn't find any major issues.` コメントを受け、Workflow B が `done / no_findings` に更新し、完了コメントを投稿した。

**オプション: `done / no_findings` 到達時の自動マージ (TY-245, TY-277 で hardened):**

Repository variable `AUTO_REVIEW_AUTO_MERGE=true` を設定すると、`done / no_findings` への遷移直後に `mergeIfChecksPass`（`src/pr-merger.ts`）を呼び出し、HEAD commit の workflow run を自前で確認してから `gh pr merge --squash` でマージする。`gh pr merge --auto` は使わない（branch protection の有無に依存せず、CI 失敗時のバイパスを防ぐため）。

動作:

1. PR の HEAD sha を取得
2. その sha に紐づく workflow runs を `GET /repos/.../actions/runs?head_sha=...` で列挙
3. 自分自身（`GITHUB_RUN_ID` が一致する auto-review-loop run）は除外
4. 1 つでも `failure` / `cancelled` / `timed_out` / `action_required` / `startup_failure` / `stale` conclusion があれば **マージしない** + warning
5. すべて `completed` でかつ failure 無しなら `gh pr merge --squash --match-head-commit <verified-sha>` を即発行（GitHub 側でも sha 一致を強制してチェック後の race を防ぐ）
6. まだ `in_progress` / `queued` の run があれば `AUTO_REVIEW_AUTO_MERGE_POLL_SECONDS` (default 15) 間隔で polling
7. polling 中に PR HEAD sha が変化したら（人が新 commit を push したら）**マージしない** + warning
8. `AUTO_REVIEW_AUTO_MERGE_TIMEOUT_MINUTES` (default 10) を超過したら **マージしない** + warning
9. `/repos/.../actions/runs` は `--paginate` で全ページ取得するので、100 件超の workflow run があっても page 2+ の failure を見落とさない

`AUTO_REVIEW_AUTO_MERGE=true` を使う場合、workflow に `actions: read` 権限が必要（API 読みのため）。未付与だと auto-merge が常に skip される（[security.md](security.md) 参照）。

仕様の前提:

- デフォルト `false`（従来挙動・人手マージ維持）
- 発火するのは `done / no_findings` のみ。`max_iterations` / `loop_detected` / `claude_api_error` 等の停止では絶対にマージしない
- マージ方式は **squash 固定**
- `gh pr merge --squash` 自体や API 呼び出しが失敗した場合（権限不足、`mergeable=false`、auto-merge 設定が repo で無効など）はワークフローは success のまま warning ログのみ。人手マージ運用は維持される
- `done` 後に人間が新たに commit を push した場合は polling 中に HEAD 変化を検知して skip する。新 commit を再評価したい場合は `/restart-review` を使う

関連 Repository variable / action input:

| variable | input | default | 役割 |
|----------|-------|---------|------|
| `AUTO_REVIEW_AUTO_MERGE` | `auto-merge-on-clean` | `false` | 機能の opt-in トグル |
| `AUTO_REVIEW_AUTO_MERGE_POLL_SECONDS` | `auto-merge-poll-seconds` | `15` | polling 間隔 |
| `AUTO_REVIEW_AUTO_MERGE_TIMEOUT_MINUTES` | `auto-merge-timeout-minutes` | `10` | CI 待ちの上限 |

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

### Codex 再依頼失敗 (`codex_request_failed`, TY-273 #B5)

post-fix が repair commit を push した後に `@codex review` を投稿する API 呼び出しが失敗した場合 (rate limit / 認証エラー / network 障害)、従来は status を `waiting_codex` のまま保留し人手で `@codex review` を投稿しないと復旧しなかった。これは Codex から新しい review が来ないため次の trigger が永久に発火せず、auto-review が silent に deadlock する経路だった。

TY-273 以降は同じ失敗で `stopped/codex_request_failed` へ降格し、`postTerminalNotification` 経由で top-level コメントとして「Codex 再依頼に失敗したため停止」通知が PR に投稿される。repair commit 自体は branch に残るので、Codex の認証・接続を直してから `/restart-review` (soft) で再開すれば良い。`iterationCount` / `findingsHashHistory` は次 iteration が同じ findings を再評価できるよう保持される。

検知ロジック: `src/main-post-fix.ts` の Phase 4 と no-op 経路にある `postCodexReviewRequest` catch ブロック。

---

### 外部サービスの quota 停止 (`codex_usage_limit`, TY-229)

Codex が `@codex review` 要求に対して通常のレビュー結果ではなく「`You have reached your Codex usage limits for code reviews.`」のような usage-limit / quota 超過コメントを返した場合、pre-fix は trigger body と投稿者 (`CODEX_BOT_LOGIN`) を見て検知し、`stopped / codex_usage_limit` として停止する。

検知ロジック: `src/codex-status.ts:isCodexUsageLimitMessage`。fixture: `tests/fixtures/codex-usage-limit.txt`。

これは LLM の修正品質ではなく外部サービス制約のため、quota がリセットされた後に `/restart-review` (soft) で再開すれば良い (`iterationCount` / `findingsHashHistory` を保持)。

---

## 停止時コメント例

auto-review の終了系イベント (`done` / `stopped` / `init_incomplete`) では **2 つの場所** に情報が出る:

1. **集約 status コメント** (`src/status-comment.ts` / TY-228): PR ごとに 1 件、History セクションに stopped/done エントリを append
2. **新規 top-level コメント** (`postTerminalNotification` / TY-259): GitHub 通知を発火させるために、terminal 遷移時のみ別途投稿される

### 1. 集約 status コメントの History エントリ例

```text
### Automation stopped — reached max iterations (MAX_REVIEW_ITERATIONS)
*2026-05-16T12:34:56Z*

Reason: reached max iterations (MAX_REVIEW_ITERATIONS)
Last processed Codex review: #987654321
Open in-scope findings remaining: 1
Detail: ...
```

### 2. 新規 top-level コメント (通知用) 例

```markdown
🛑 **Auto-review stopped** — reached max iterations (MAX_REVIEW_ITERATIONS).

Open in-scope findings remaining: 1. Manual intervention required.
See the [status comment](https://github.com/<owner>/<repo>/pull/<N>#issuecomment-<id>) for the full history.
```

```markdown
✅ **Auto-review completed** — no findings remaining (3 iterations).

See the [status comment](https://github.com/<owner>/<repo>/pull/<N>#issuecomment-<id>) for the full history.
```

通知用コメントの post は best-effort (`core.warning` で失敗を出すのみ、status コメントの戻り値は維持される)。iteration 進捗 (`auto_fix_applied`) は通知を発火しない (TY-228 維持)。

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
- `max_turns_exceeded`（soft 推奨。次 iteration が自動で escalated tier になる、TY-258）
- `codex_usage_limit`（quota リセット後に soft、TY-229）
- `codex_request_failed`（Codex 認証 / 接続を直してから soft、TY-273 #B5）
- `no_findings`（`done` 状態）
- `waiting_codex`

保持する状態:

- `iterationCount`
- `findingsHashHistory`
- `lastClaudeCommitSha`
- `lastFindingsHash`
- `stopReason` (TY-258 で変更。次 iteration のモデル選定 [`previous_max_turns_exceeded`](security.md#escalation-条件-いずれかが真で-escalated-tier) で参照する。post-fix の clean commit で `null` にリセット)

書き換える状態:

- `status`: `stopped` または `done` → `waiting_codex`
- `lastProcessedReviewId`: `null`
- `lastCodexReviewReceivedAt`: 保持する（過去の Codex inline comment を再処理しないため）
- `lastCodexRequestCommentId`: 新しく投稿した `@codex review` comment ID

```text
/restart-review --hard
```

hard restart。soft restart の操作に加えて、`iterationCount` を `0`、`findingsHashHistory` を `[]`、`lastFindingsHash` を `null` に戻す。`stopReason` の扱いは soft restart と同じく保持する。

`max_iterations` は上限判定を抜けるために hard restart が適している。`loop_detected` は履歴を消すため、人間が修正済みであることを確認してから使う。

### 権限

`/restart-review` を実行できるユーザーは `AUTO_REVIEW_RESTART_ROLES` で制御する。

- デフォルト: `author,write,maintain,admin`
- `author`: PR 作成者
- `write` / `maintain` / `admin`: GitHub collaborator permission

権限不足の場合、状態は変更せず、PR に拒否コメントを残す。

**Workflow 起動レイヤーの追加ゲート (TY-272 #C):**
- `auto-review-loop.yml` の job `if` で、`/restart-review` 経路では `github.event.comment.author_association` が `OWNER` / `MEMBER` / `COLLABORATOR` のいずれか、**または** commenter が PR 作者本人 (`github.event.comment.user.login == github.event.issue.user.login`) でない場合は workflow run 自体が起動しない
- これは TS 側の `handleRestartCommand` 内の permission check (上記 `AUTO_REVIEW_RESTART_ROLES`) を補完する defense-in-depth。public PR で関係ない第三者が `/restart-review` を連投しても、workflow run / Actions minutes / 並行 job スロットを消費しない
- 外部コントリビューター (`CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`) の PR 作者は `AUTO_REVIEW_RESTART_ROLES` のデフォルト `author` に含まれるため、自分の PR 上で `/restart-review` を発火できる (Codex P1 on PR #85 の指摘を受けて緩和)。それ以外の外部ユーザーが restart したい正当な要件は基本的に発生しないため、本 gate を緩める運用は非推奨。例外運用が必要な場合は workflow YAML の `if` 条件を明示的に編集する

**実行内部の順序 (TY-272 #E):**
- `handleRestartCommand` は parse 直後に `canRestart` で権限を確認し、不足時は 1 件の拒否コメントだけ投稿して return する
- state read / `state_corrupted` 通知 / `unsupported_option` 通知などの side effect は全て権限チェックの後に走る。これにより、権限のない `/restart-review` が誤って state や追加コメントを生成する経路を塞ぐ

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
- `fixing` のまま停止している場合: 実行中の Workflow B がないことを確認してから `/restart-review --hard`
- `codex_usage_limit` で停止した場合: Codex 側の quota がリセットされたタイミングで `/restart-review` (soft)。`iterationCount` は保持される
- `max_turns_exceeded` で停止した場合: `/restart-review` (soft) で再開する。次 iteration は自動で escalated tier (default Opus) に上がる (`previous_max_turns_exceeded`、TY-258)。1 回 clean commit に到達すると `stopReason` がクリアされ通常 tiering に戻る (one-shot)

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
