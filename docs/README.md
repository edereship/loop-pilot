# Codex レビュー × Claude 修正 自動ループ — 設計ドキュメント

> PR に対して Codex がレビューし、Claude が自動修正する自動ループの設計資料。

## 概要

LoopPilot は本番稼働中の Codex レビュー × Claude 自動修正ループである。PR が開かれると 1 サイクルは次の流れで進む。

- Codex review 起動 (`@codex review`)
- Workflow B 起動
- Claude (`claude-code-action`) による修正
- `CHECK_COMMAND` 実行
- commit / push
- 再 `@codex review`
- 閾値以上 (default `P3`) の finding が解消された `done` 終了

P0/P1/P2/P3 をすべて自動修正対象とし（default `P3`、`LOOPPILOT_SEVERITY_THRESHOLD` で変更可能）、停止後・完了後は `/restart-review` または `/restart-review --hard` で再度レビュー・修正ループにかけられる。フローと状態管理の詳細は [推奨フローと状態管理](architecture/flow-and-state.md)、停止と復旧は [停止条件とリカバリ](operations/stop-and-recovery.md) を参照する。

導入手順・必要なトークン権限・設定変数はリポジトリ直下の [README](../README.md) にまとまっている。本ディレクトリは設計・運用の詳細資料を提供する。

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
| [Scope Policy](operations/scope-policy.md) | post-fix の変更スコープ検査仕様・`LOOPPILOT_BLOCK_PATHS` syntax・旧変数 deprecation マイグレーション (TY-271) |
| [検証コマンドとロールバック](operations/check-and-rollback.md) | CHECK_COMMAND・失敗時ロールバック・出力サニタイズ |
| [停止条件とリカバリ](operations/stop-and-recovery.md) | 正常/強制/異常停止・停止コメント・`/restart-review` による再実行手順 |
| [Production E2E Validation Notes](operations/production-e2e-validation.md) | TY-145 の本番移植前 E2E 検証結果・本番 repo で必要な人間確認手順 |
| [TY-233 Codex 徹底レビュー E2E](operations/ty-233-thorough-review-e2e.md) | 徹底レビュー有効時の `claude-code-action` repair loop E2E 観測値（PR #79）|

### Testing — テスト

| ドキュメント | 内容 |
|-------------|------|
| [テスト戦略](testing/test-strategy.md) | ユニットテスト（パーサー・ハッシュ・edit 適用・ループ検知）・統合テスト |

### Checklists — チェックリスト（履歴）

PoC からの立ち上げ・本番移植時に使ったチェックリスト。現在は履歴資料として残している。

| ドキュメント | 内容 |
|-------------|------|
| [PoC チェックリスト](checklists/poc-checklist.md) | 立ち上げ期の実装必須項目・検証事項（履歴） |
| [本番移植チェックリスト](checklists/production-migration.md) | 本番移植時に確認した設計修正・運用/セキュリティ項目（履歴） |
| [Hygiene 判断ログ](operations/hygiene-decisions.md) | リポジトリ整備 / 見送り判断の記録 |

### Archive — 役目を終えた設計資料

完了済みの実装計画と、後継ドキュメントに置き換わった旧仕様は `_archive/` に移している。歴史的経緯を確認したい時のみ参照する。

| ドキュメント | 内容 |
|-------------|------|
| [`_archive/specs/claude-fix-engine.md`](_archive/specs/claude-fix-engine.md) | 旧 `src/claude-fix-engine.ts` (Anthropic SDK + `edit_file` ツール直接適用) の仕様。TY-236 で `claude-code-action` に置き換え |
| [`_archive/plans/2026-03-22-loop-pilot.md`](_archive/plans/2026-03-22-loop-pilot.md) | PoC 初期の実装計画。PR #69 まで取り込み済みで現状の実装と乖離があるため history 用 |

## 読み方ガイド

1. **導入する場合:** リポジトリ直下の [README](../README.md) のクイックスタートとトークン権限を参照する
2. **設計を理解する場合:** [システム概要](architecture/system-overview.md) → [推奨フローと状態管理](architecture/flow-and-state.md) の順で全体像を掴む
3. **特定コンポーネントを追う場合:** Specs 配下の該当ドキュメントを直接参照する
4. **停止後・完了後に再実行する場合:** [停止条件とリカバリ](operations/stop-and-recovery.md) の `/restart-review` 手順と `LOOPPILOT_RESTART_ROLES` を確認する
