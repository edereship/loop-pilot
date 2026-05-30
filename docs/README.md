# LoopPilot — 設計・運用ドキュメント

> PR に対して Codex がレビューし、Claude (`claude-code-action`) が自動修正する自動ループの設計・運用資料。

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

**導入手順・必要なトークン権限・設定変数はリポジトリ直下の [README](../README.md) にまとまっている。** 本ディレクトリは設計・運用の詳細リファレンスを提供する。

## ドキュメント構成

### Architecture — 全体設計

| ドキュメント | 内容 |
|-------------|------|
| [システム概要](architecture/system-overview.md) | 目的・基本方針・役割分担・設定パラメータ |
| [推奨フローと状態管理](architecture/flow-and-state.md) | 詳細フロー・状態スキーマ・hidden comment・シーケンス図・状態遷移図 |
| [イベント設計](architecture/event-design.md) | Workflow A/B のトリガー・`issue_comment` の注意点・デバウンス・concurrency・重複防止 |

### Specs — コンポーネント仕様

| ドキュメント | 内容 |
|-------------|------|
| [Severity パーサー仕様](specs/severity-parser.md) | Codex のレビュー形式・severity 抽出の正規表現・フォールバック |
| [Claude Code repair request 仕様](specs/claude-code-repair-request.md) | `claude-code-action` 向け repo-level repair payload / prompt の生成仕様 |
| [ループ検知](specs/loop-detection.md) | 同一指摘ループの検知アルゴリズム・ハッシュ計算・疑似コード |

### Operations — 運用

| ドキュメント | 内容 |
|-------------|------|
| [セキュリティ](operations/security.md) | Fork PR 防止・トークンスコープ・認証・scope check・IPI 脅威モデル |
| [Scope Policy](operations/scope-policy.md) | post-fix の変更スコープ検査仕様・`LOOPPILOT_BLOCK_PATHS` syntax |
| [検証コマンドとロールバック](operations/check-and-rollback.md) | `CHECK_COMMAND`・失敗時ロールバック・出力サニタイズ |
| [停止条件とリカバリ](operations/stop-and-recovery.md) | 正常/強制/異常停止・停止コメント・`/restart-review` による再実行手順 |
| [リリース手順](operations/releasing.md) | `vX.Y.Z` タグ運用・moving `v1` 張り替え・リリース前ガード・配布手順 |

## 読み方ガイド

1. **導入する場合:** リポジトリ直下の [README](../README.md) のクイックスタートとトークン権限を参照する
2. **設計を理解する場合:** [システム概要](architecture/system-overview.md) → [推奨フローと状態管理](architecture/flow-and-state.md) の順で全体像を掴む
3. **特定コンポーネントを追う場合:** Specs 配下の該当ドキュメントを直接参照する
4. **停止後・完了後に再実行する場合:** [停止条件とリカバリ](operations/stop-and-recovery.md) の `/restart-review` 手順と `LOOPPILOT_RESTART_ROLES` を確認する
