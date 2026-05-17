# Codex レビュー × Claude 修正 自動ループ — 設計ドキュメント

> PR に対して Codex がレビューし、Claude が自動修正する自動ループの設計資料。

## 現状ステータス

PoC の主要 E2E は PR #7 / TY-11 で確認済み。

- Codex review 起動
- Workflow B 起動
- Claude 修正
- `CHECK_COMMAND`
- commit/push
- 再 `@codex review`
- 閾値以上 (default `P2`) の finding が解消された `done` 終了

現在の実装では P0/P1/P2 を自動修正対象とし、停止後・完了後は `/restart-review` または `/restart-review --hard` で再度レビュー・修正ループにかけられる。詳細は [推奨フローと状態管理](architecture/flow-and-state.md) と [停止条件とリカバリ](operations/stop-and-recovery.md) を参照する。

本番移植前の残課題は [本番移植チェックリスト](checklists/production-migration.md) に集約する。次に読むべき資料は、現状確認なら [PoC チェックリスト](checklists/poc-checklist.md)、移植判断なら [本番移植チェックリスト](checklists/production-migration.md)、停止後の復旧手順なら [停止条件とリカバリ](operations/stop-and-recovery.md)。

## ドキュメント構成

### Architecture — 全体設計

| ドキュメント | 内容 |
|-------------|------|
| [システム概要](architecture/system-overview.md) | 目的・PoC の位置づけ・基本方針・役割分担・設定パラメータ・最終まとめ |
| [推奨フローと状態管理](architecture/flow-and-state.md) | ステップ 1-6 の詳細フロー・状態スキーマ・hidden comment・シーケンス図・状態遷移図 |
| [イベント設計](architecture/event-design.md) | Workflow A/B のトリガー・`issue_comment` の注意点・デバウンス・concurrency・重複防止 |

### Specs — コンポーネント仕様

| ドキュメント | 内容 |
|-------------|------|
| [Severity パーサー仕様](specs/severity-parser.md) | Codex のレビュー形式・severity 抽出の正規表現・フォールバック |
| [Claude Code repair request 仕様](specs/claude-code-repair-request.md) | `claude-code-action` 向け repo-level repair payload / prompt の生成仕様（TY-235） |
| [ループ検知](specs/loop-detection.md) | 同一指摘ループの検知アルゴリズム・ハッシュ計算・疑似コード |

### Operations — 運用

| ドキュメント | 内容 |
|-------------|------|
| [セキュリティ](operations/security.md) | Fork PR 防止・Bot Token スコープ・API キー管理 |
| [検証コマンドとロールバック](operations/check-and-rollback.md) | CHECK_COMMAND・失敗時ロールバック・出力サニタイズ |
| [停止条件とリカバリ](operations/stop-and-recovery.md) | 正常/強制/異常停止・停止コメント・`/restart-review` による再実行手順 |
| [Production E2E Validation Notes](operations/production-e2e-validation.md) | TY-145 の本番移植前 E2E 検証結果・本番 repo で必要な人間確認手順 |
| [TY-233 Codex 徹底レビュー E2E](operations/ty-233-thorough-review-e2e.md) | 徹底レビュー有効時の `claude-code-action` repair loop E2E 観測値（PR #79）|

### Testing — テスト

| ドキュメント | 内容 |
|-------------|------|
| [テスト戦略](testing/test-strategy.md) | ユニットテスト（パーサー・ハッシュ・edit 適用・ループ検知）・統合テスト |

### Checklists — チェックリスト

| ドキュメント | 内容 |
|-------------|------|
| [PoC チェックリスト](checklists/poc-checklist.md) | 実装必須項目・検証事項・初期実装スコープ |
| [本番移植チェックリスト](checklists/production-migration.md) | 設計修正項目・運用/セキュリティ項目 |
| [Hygiene 判断ログ](operations/hygiene-decisions.md) | TY-270 ほか、リポジトリ整備 / 見送り判断の記録 |

### Archive — 役目を終えた設計資料

完了済みの実装計画と、後継ドキュメントに置き換わった旧仕様は `_archive/` に移している。歴史的経緯を確認したい時のみ参照する。

| ドキュメント | 内容 |
|-------------|------|
| [`_archive/specs/claude-fix-engine.md`](_archive/specs/claude-fix-engine.md) | 旧 `src/claude-fix-engine.ts` (Anthropic SDK + `edit_file` ツール直接適用) の仕様。TY-236 で `claude-code-action` に置き換え |
| [`_archive/plans/2026-03-22-auto-review-loop.md`](_archive/plans/2026-03-22-auto-review-loop.md) | PoC 初期の実装計画。PR #69 まで取り込み済みで現状の実装と乖離があるため history 用 |

## 読み方ガイド

1. **初めて読む場合:** [システム概要](architecture/system-overview.md) → [推奨フローと状態管理](architecture/flow-and-state.md) の順で全体像を掴む
2. **実装を始める場合:** [PoC チェックリスト](checklists/poc-checklist.md) を起点に、各仕様ドキュメントを参照する
3. **特定コンポーネントを実装する場合:** Specs 配下の該当ドキュメントを直接参照する
4. **停止後・完了後に再実行する場合:** [停止条件とリカバリ](operations/stop-and-recovery.md) の `/restart-review` 手順と `AUTO_REVIEW_RESTART_ROLES` を確認する
