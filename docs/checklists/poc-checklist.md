# PoC チェックリスト

## PoC 実装チェックリスト

> **PoC で実装・検証すべき項目の一覧。** 詳細は各リンク先ドキュメントを参照。

### 実装必須

- [x] Workflow A: PR 作成時に hidden comment 作成 + `@codex review` 投稿 → [Workflow A](../architecture/event-design.md#workflow-a-pr-作成時auto-review-inityml)
- [x] Workflow B: Codex レビュー受信 + デバウンス待機 + Claude 修正 + 再レビュー依頼 → [Workflow B](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正auto-review-loopyml)
- [x] Severity パーサー（P0/P1 抽出の正規表現） → [Severity の抽出ルール](../specs/severity-parser.md#severity-の抽出ルール)
- [x] `@codex review` 投稿専用の接続済みユーザー PAT（`CODEX_REVIEW_REQUEST_TOKEN`）を Workflow A/B で使用し、未設定時は `GITHUB_TOKEN` に fallback → [Codex review request token](../architecture/event-design.md#codex-review-request-token)
- [x] Claude API 呼び出し（`edit_file` tool use） → [Claude 修正エンジン](../specs/claude-fix-engine.md)
- [ ] `edit_file` 適用ロジック（逆順適用・空白正規化・複数マッチ・再試行） → [edit 適用ロジック](../specs/claude-fix-engine.md#edit-適用ロジック)
- [x] `CHECK_COMMAND` 実行 + 失敗時ロールバック → [検証コマンドとロールバック](../operations/check-and-rollback.md)
- [x] hidden comment による状態管理 → [状態管理](../architecture/flow-and-state.md#状態管理)
- [x] `MAX_REVIEW_ITERATIONS` による停止制御 → [停止条件](../operations/stop-and-recovery.md#停止条件)
- [ ] 同一指摘ループ検知 → [ループ検知](../specs/loop-detection.md)
- [x] Fork PR からの起動防止 → [セキュリティ](../operations/security.md#fork-pr-からの起動防止)
- [x] Repository variables 未設定時も空文字 `contains()` で Workflow B が誤起動しない trigger guard → [イベント設計](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正auto-review-loopyml)

---

## PoC 検証事項

- [x] `@codex review` メンション形式で Codex が起動するか確認
- [x] `CODEX_REVIEW_REQUEST_TOKEN` 経由で投稿された `@codex review` で Codex がレビューを開始することを実 PR で確認
- [x] 総評コメント / インラインコメントの投稿順序を確認
- [x] Codex インラインコメントの原文を Artifact として保存する step を追加し、匿名化 fixture でパーサーのテストケースにする
- [x] `pull_request_review` / `issue_comment` トリガーでの `GITHUB_TOKEN` 権限を確認
- [ ] デバウンス時間の最適値を検証

---

## 実 PR 検証メモ

- PR #7 で `CODEX_REVIEW_REQUEST_TOKEN` 経由の `@codex review` 投稿により Codex review が開始されることを確認した。
- PR #7 で Codex は `pull_request_review` の総評と inline `pull_request_review_comment` を投稿した。
- PR #7 の初回 Workflow B は起動したが、hidden comment 自体ではなく `gh --jq` 出力のデコード処理により `hidden comment state corrupted` と誤判定したため、`readState()` の state comment record parser を修正した。
- PR #7 の 2 回目 Workflow B は state comment 更新まで進んだが、inline comment 取得でも同じ `gh --jq` 出力のデコード前提により P1 を 0 件扱いしたため、review comment record parser を修正した。
- PR #7 の 3 回目 Workflow B は P1 を 1 件抽出できたが、`MAX_REVIEW_ITERATIONS=1` の初回修正 prompt が残り 0 回と表示され Claude が edit を返さなかったため、現在の修正試行を残り回数に含めるよう修正した。
- PR #7 の 3 回目 Workflow B で Claude が edit を返さなかった場合に iteration/hash が state に残り、手動再試行で loop 検知され得ることを確認したため、no-edit 停止時は failed attempt を消費しないよう修正した。
- PR #7 の `eval` 検証ターゲットは Claude が no-edit に倒れたため、checkout/push までの E2E 継続確認用に secret logging 形のターゲットへ変更した。
- Repository UI で default workflow permission を write に変更できない環境のため、checkout/push 権限は workflow YAML の明示的 `permissions: contents: write` で継続検証する。
- 2026-05-06 の PR #7 再検証で、`CODEX_REVIEW_REQUEST_TOKEN` 経由の `@codex review` 投稿により Codex review が起動した。Codex は総評 review `#4235869502` を先に投稿し、続けて inline comment `#3195264322` を投稿した。
- Workflow B run `25434230427` で `pull_request_review` トリガーから PR head branch `linear/RCM-TY-11` を checkout し、依存関係セットアップ、Claude 修正、`CHECK_COMMAND`、commit/push、artifact upload がすべて成功した。PR head は `f7c4f16043` から `e81908f6a72ddc41185cee01f7a3d68849d17cc1` に更新された。
- Workflow B run `25434230427` の artifact `codex-comments-7-50`（artifact id `6829810937`, digest `sha256:80146528a7b5e10c45db95b7205b84d059adc89a9d25094d37dccfeee5a76828`）で Codex コメントが保存された。
- Workflow B は修正要約コメントと再 `@codex review` を投稿し、Codex は `Codex Review: Didn't find any major issues.` を返した。
- 最終 Workflow B run `25434616354` は `issue_comment` トリガーで成功し、hidden comment state は `status: "done"`, `stopReason: "no_findings"` に更新された。PR コメントにも `Auto-review completed. Iterations: 1. All P0/P1 findings have been resolved.` が投稿された。

---

## PoC 検証事項チェックリスト

> PoC 段階で必ず確認・記録すべき事項を集約したリスト。

**Codex のイベント発行パターン（[Severity パーサー仕様](../specs/severity-parser.md) 参照）:**
- [x] `chatgpt-codex-connector[bot]` の実際のイベント発行パターンを確認する（PR #4 では `pull_request_review` + inline `pull_request_review_comment`）
- [x] 実測イベント形式に合わせ、Workflow B が `pull_request_review.submitted` を受け付けることを確認する
- [x] `pull_request_review` が来た時点で全インラインコメントが既に投稿済みかを確認する
- [ ] 上記が安定していれば `DEBOUNCE_SECONDS=0` への短縮を検討する

**Severity パーサー（[Severity の抽出ルール](../specs/severity-parser.md#severity-の抽出ルール) 参照）:**
- [x] 実際の Codex インラインコメント原文を取得し、正規表現でパースできることを確認する
- [x] GitHub API レスポンス（`body` フィールド）由来の匿名化 fixture を保存し、パーサーのテストケースとする
- [x] Codex インラインコメント原文を GitHub Actions Artifact として保存するステップを追加する

**Workflow 動作:**
- [x] `pull_request_review` トリガーで PR ブランチの checkout・push が正常に動作することを確認する
- [ ] 互換用の `issue_comment` トリガーで PR ブランチの checkout・push が正常に動作することを確認する
- [ ] `concurrency` 制御が期待通りに動作することを確認する
- [x] Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）未設定時も fallback 条件だけで安全に判定されることを確認する
- [x] Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）の推奨値が設定されていることを実環境で確認する

---

## 推奨する初期実装スコープ

まずは以下だけを入れる。

- PR 作成時に `@codex review`
- 最新 Codex review 一式を取得
- P0 / P1 抽出
- デバウンス待機
- Claude 修正
- test / lint / typecheck
- commit / push
- 再度 `@codex review`
- `MAX_REVIEW_ITERATIONS` による停止制御
- hidden comment による状態管理

後から追加してよいもの:
- Slack 通知
- 対象ファイル絞り込み
- ラベル連携
- 手動停止コマンド
- `/reset-review` 等の PR コマンドによるリカバリ

> 注: 同一指摘ループ検知は初期スコープに含める（ループが PoC 検証自体を妨げるため）

---

## 関連ドキュメント

- [本番移植チェックリスト](production-migration.md)
- [全ドキュメント索引](../README.md)
