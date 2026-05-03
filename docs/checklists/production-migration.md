# 本番移植時の検討事項チェックリスト

PoC で動作確認した後、本プロジェクトに移植する際に対応すべき事項。

---

## 設計上の修正が必要な項目（本番移植前に必須）

- [ ] インラインコメントの取得範囲フィルタの検証（`created_at` ベースのフィルタが期待通り動作するか）
- [ ] Claude API エラー時のリトライ戦略の実装・チューニング
- [ ] `CHECK_COMMAND` の各プロジェクトへの適用（`package.json` の `check` スクリプト整備）
- [ ] Claude API 呼び出しのバッチ化検討（findings が少ないファイル同士をまとめて1回の API 呼び出しで処理し、コスト効率を改善する。閾値例: 1ファイルあたり findings 1件以下のファイルはバッチ化対象）
- [ ] hidden comment の競合対策（楽観ロック + TOCTOU 対策の実装。方針は [状態管理](../architecture/flow-and-state.md#hidden-comment-の競合書き込みリスク) に記載済み。PoC では concurrency 制御で代替）

---

## 運用・セキュリティの項目

- [ ] デバウンス方式の見直し（`sleep` → イベント駆動 or 外部スケジューラ）
- [ ] Codex のレビュー形式に合わせた severity パーサーの厳密化（PoC で取得した実コメントを基に）
- [x] `Codex Review` 文言の環境変数化（`CODEX_REVIEW_MARKER`）— PoC 段階で対応済み
- [x] Codex bot 名 `chatgpt-codex-connector[bot]` の環境変数化（`CODEX_BOT_LOGIN`）— PoC 段階で対応済み
- [ ] Bot Token のスコープ最小化と Fine-grained PAT の設定
- [ ] `CODEX_REVIEW_REQUEST_TOKEN` の運用方式決定（個人 PAT 継続ではなく、専用 machine user または GitHub App token への置き換えを検討）
- [ ] Fork PR 起動防止の確認
- [ ] `MAX_REVIEW_ITERATIONS` の適正値決定（コスト試算に基づく。20以上も検討）
- [ ] `/reset-review` 等のリカバリコマンド実装
- [ ] hidden comment 消失時の自動リカバリ機構
- [ ] GitHub API レート制限の考慮（1 iteration あたり最低4回の API コール × 20 iteration = 80回。複数 PR が並行する場合は 1時間あたり1,000リクエスト制限に注意）
- [ ] Slack 通知等の運用連携

---

## 関連ドキュメント

- [PoC チェックリスト](poc-checklist.md)
- [セキュリティ](../operations/security.md)
- [システム概要](../architecture/system-overview.md) — コスト概算・パラメータ
- [全ドキュメント索引](../README.md)
