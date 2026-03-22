# PoC チェックリスト

## PoC 実装チェックリスト

> **PoC で実装・検証すべき項目の一覧。** 詳細は各リンク先ドキュメントを参照。

### 実装必須

- [ ] Workflow A: PR 作成時に hidden comment 作成 + `@codex review` 投稿 → [Workflow A](../architecture/event-design.md#workflow-a-pr-作成時auto-review-inityml)
- [ ] Workflow B: Codex レビュー受信 + デバウンス待機 + Claude 修正 + 再レビュー依頼 → [Workflow B](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正auto-review-loopyml)
- [ ] Severity パーサー（P0/P1 抽出の正規表現） → [Severity の抽出ルール](../specs/severity-parser.md#severity-の抽出ルール)
- [ ] Claude API 呼び出し（`edit_file` tool use） → [Claude 修正エンジン](../specs/claude-fix-engine.md)
- [ ] `edit_file` 適用ロジック（逆順適用・空白正規化・複数マッチ・再試行） → [edit 適用ロジック](../specs/claude-fix-engine.md#edit-適用ロジック)
- [ ] `CHECK_COMMAND` 実行 + 失敗時ロールバック → [検証コマンドとロールバック](../operations/check-and-rollback.md)
- [ ] hidden comment による状態管理 → [状態管理](../architecture/flow-and-state.md#状態管理)
- [ ] `MAX_REVIEW_ITERATIONS` による停止制御 → [停止条件](../operations/stop-and-recovery.md#停止条件)
- [ ] 同一指摘ループ検知 → [ループ検知](../specs/loop-detection.md)
- [ ] Fork PR からの起動防止 → [セキュリティ](../operations/security.md#fork-pr-からの起動防止)

---

## PoC 検証事項

- [ ] `@codex review` メンション形式で Codex が起動するか確認
- [ ] 総評コメント / インラインコメントの投稿順序を確認
- [ ] Codex インラインコメントの原文を Artifact として保存し、パーサーのテストケースにする
- [ ] `issue_comment` トリガーでの `GITHUB_TOKEN` 権限を確認
- [ ] デバウンス時間の最適値を検証

---

## PoC 検証事項チェックリスト

> PoC 段階で必ず確認・記録すべき事項を集約したリスト。

**Codex のイベント発行パターン（[Severity パーサー仕様](../specs/severity-parser.md) 参照）:**
- [ ] `chatgpt-codex-connector[bot]` の実際のイベント発行パターンを確認する（総評コメント・インラインコメントの API 種別とイベント型）
- [ ] 総評コメント（`issue_comment`）とインラインコメント（`pull_request_review_comment`）の投稿順序を確認する
- [ ] 総評コメントが来た時点で全インラインコメントが既に投稿済みかを確認する
- [ ] 上記が安定していれば `DEBOUNCE_SECONDS=0` への短縮を検討する

**Severity パーサー（[Severity の抽出ルール](../specs/severity-parser.md#severity-の抽出ルール) 参照）:**
- [ ] 実際の Codex インラインコメント原文を取得し、正規表現でパースできることを確認する
- [ ] GitHub API レスポンス（`body` フィールド）をそのまま保存し、パーサーのテストケースとする
- [ ] Codex インラインコメント原文を GitHub Actions Artifact として保存するステップを追加する

**Workflow 動作:**
- [ ] `issue_comment` トリガーで PR ブランチの checkout・push が正常に動作することを確認する
- [ ] `concurrency` 制御が期待通りに動作することを確認する
- [ ] Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）のデフォルト値が設定されていることを確認する

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
