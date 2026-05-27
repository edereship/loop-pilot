# 本番移植時の検討事項チェックリスト

PoC で動作確認した後、本プロジェクトに移植する際に対応すべき事項。

## 現状

PR #7 / TY-11 で、同一リポジトリ PR に対する Workflow A/B の主要 E2E は確認済み。

- Workflow A: hidden comment 作成、接続済みユーザー PAT による `@codex review` 投稿
- Codex: `pull_request_review` 総評 + inline `pull_request_review_comment` 投稿
- Workflow B: `pull_request_review` トリガー、PR head checkout、Claude 修正、`CHECK_COMMAND`、commit/push、修正要約、再 `@codex review`
- 最終終了: Codex の no major issues コメントを受け、`status: done`, `stopReason: no_findings`

この checklist は「PoC で動いたか」ではなく、「本番移植前に設計・運用として決めるべきこと」を残す。

---

## 追加 Issue 化した本番移植前タスク

| Issue | 優先度 | 分類 | 概要 |
|------|--------|------|------|
| TY-137 | High | 実装済み / 設定 | ラベル付き PR のみ LoopPilot を起動する default-strict 運用（`LOOPPILOT_LABEL` でラベル名カスタマイズ、`LOOPPILOT_FULL_AUTO=true` で全自動 opt-out） |
| TY-138 | High | 必須 / テスト | 複数 Codex 指摘を受けた場合の auto-fix loop テスト |
| TY-139 | High | 必須 / 実装 | hidden comment の楽観ロック + TOCTOU 対策 |
| TY-140 | High | 必須 / 運用判断 | Claude API retry / cost limit / spending guard |
| TY-143 | High | 必須 / 認証判断 | 本番用 token / GitHub App / machine user 運用 |
| TY-145 | High | 必須 / E2E 検証 | 外部 fork PR と branch protection 下での本番 E2E |
| TY-141 | Medium | 完了 / トラッキング | repo-level repair 移行トラック（旧 large file / cross-file finding 対応方針）。claude-code-action 採用で解決（TY-234 / TY-235 / TY-140 / TY-236）。徹底レビュー時 E2E は TY-233 で継続 |
| TY-142 | Medium | 完了 / 方針確定 | debounce / concurrency / `issue_comment` 互換 trigger 方針 (2026-05-16 確定: 90s 据え置き / sleep 継続 / PR scoped queue / 両ルート正式対応) |
| TY-144 | Medium | 運用改善 | `/restart-review` と hidden state recovery |

High は本番移植前に完了または明確な保留判断が必要な項目。Medium は初期移植では手動運用や制限付き運用で代替できるが、移植先の規模・運用要件によって High に上げる。

---

## 設計上の修正が必要な項目（本番移植前に必須）

- [x] ラベル付き PR のみ LoopPilot を起動する default-strict を実装する（TY-137 — デフォルトで `loop-pilot` ラベル必須。`LOOPPILOT_LABEL` でラベル名カスタマイズ、`LOOPPILOT_FULL_AUTO=true` で全 PR opt-out）
- [ ] 複数 Codex 指摘を受けた場合の auto-fix loop テストを追加する（TY-138）
- [ ] インラインコメントの取得範囲フィルタの検証（`created_at` ベースのフィルタが期待通り動作するか。TY-138 の複数指摘テストに含める）
- [ ] Claude API エラー時のリトライ戦略の実装・チューニング（TY-140）
- [ ] `CHECK_COMMAND` の各プロジェクトへの適用（`package.json` の `check` スクリプト整備。TY-145 の移植先 E2E で確認）
- [ ] Claude API 呼び出しのバッチ化検討（findings が少ないファイル同士をまとめて1回の API 呼び出しで処理し、コスト効率を改善する。TY-140）
- [ ] hidden comment の競合対策（楽観ロック + TOCTOU 対策の実装。方針は [状態管理](../architecture/flow-and-state.md#hidden-comment-の競合書き込みリスク) に記載済み。PoC では concurrency 制御で代替。TY-139）
- [x] large file / cross-file finding 対応（TY-141）。旧 `claude-fix-engine` の単一ファイル `edit_file` 方式を廃止し、`anthropics/claude-code-action@v1` ベースの repo-level repair に移行（TY-234 / TY-235 / TY-140 / TY-236 / TY-237 PR #33）。Codex finding の path/line は entry point として扱い、Claude Code Action が関連ファイル・呼び出し元・型定義・テストを探索した上で修正する。PoC 由来の `MAX_INPUT_TOKENS_PER_FILE` chunking 前提は廃止。徹底レビュー有効時の E2E は [TY-233](https://linear.app/team-yubune/issue/TY-233) で継続。
- [x] 互換用 `issue_comment` トリガーの本番扱い (TY-142、2026-05-16 確定)。`pull_request_review.submitted` と `issue_comment.created` を両ルート正式対応として継続。`/restart-review` (issue_comment 専用) と Codex usage-limit notice (TY-229、両ルート) の依存があるため、片側に絞ると機能落ちになる。`issue_comment` 経由で commit/push まで進む E2E は通常レビュー時は TY-232 (PR #58) で実走済み、徹底レビュー有効時は [TY-233](https://linear.app/team-yubune/issue/TY-233) に吸収
- [x] `DEBOUNCE_SECONDS=0` 可否判断 (TY-142、2026-05-16 確定)。デフォルト 90 据え置き、`vars.DEBOUNCE_SECONDS=0` は variable opt-in として許容するが運用時は 90 を推奨。理由: 課金影響 ≈ $0.24 / PR と限定的、PR #7 の安定実績あり、stabilize polling と二重化することで Codex 挙動変化への耐性を維持
- [x] `concurrency` キュー方針 (TY-142、2026-05-16 確定)。workflow-level `concurrency: pr-{N}-auto-fix` + `cancel-in-progress: false` (PR scoped queue) を継続。`fixing` 窓は composite 1 invocation 内に閉じる現設計と整合。queue 深さ 1 制約 (3 件目以降の中間 run は置換) は `findings_hash_history` + `last_processed_review_id` による ETL 集約で許容

---

## 運用・セキュリティの項目

- [x] デバウンス方式の見直し（TY-142、2026-05-16 確定）。`sleep` 継続採用。`--max-turns 40` + `timeout-minutes: 30` (TY-140) でコスト天井が明示済み、event-driven / 外部 scheduler への移行は Codex 挙動依存リスクが高く現時点での削減効果も小さい
- [x] Codex のレビュー形式に合わせた severity パーサーの厳密化（PoC で取得した実コメントを基に）
- [x] `Codex Review` 文言の環境変数化（`CODEX_REVIEW_MARKER`）— PoC 段階で対応済み
- [x] Codex bot 名 `chatgpt-codex-connector[bot]` の環境変数化（`CODEX_BOT_LOGIN`）— PoC 段階で対応済み
- [ ] Bot Token のスコープ最小化と Fine-grained PAT の設定（TY-143）
- [ ] `CODEX_REVIEW_REQUEST_TOKEN` の運用方式決定（個人 PAT 継続ではなく、専用 machine user または GitHub App token への置き換えを検討。TY-143）
- [x] Fork PR 起動防止の実装
- [x] 外部 fork PR を使った起動防止 E2E 検証（TY-145）。2026-05-16 に disposable public repo `racoma-dev/auto-review-fix-test` の fork PR #1 で、Workflow A が起動せず、手動レビュー後の Workflow B も fork guard で checkout / auto-fix / push 前に停止することを確認済み。手順と証跡は [Production E2E Validation Notes](../operations/production-e2e-validation.md#external-fork-pr-validation) を参照
- [x] branch protection / required checks 下での commit/push 可否確認（TY-145 / TY-257）。2026-05-16 に disposable public repo PR #2 で `GITHUB_TOKEN` repair push 後に必須CI `check` が再実行されないことを確認し、TY-257 で `LOOPPILOT_PUSH_TOKEN` を追加した。その後 PR #3 で dedicated push token により repair commit 上の `check` が再実行され、`done / no_findings` と `mergeStateStatus=CLEAN` まで到達することを確認済み。詳細は [Production E2E Validation Notes](../operations/production-e2e-validation.md#branch-protection-and-rulesets) を参照
- [ ] `MAX_REVIEW_ITERATIONS` の適正値決定（コスト試算に基づく。20以上も検討。TY-140）
- [ ] `/restart-review` 等のリカバリコマンド実装（TY-144）
- [ ] hidden comment 消失時の自動リカバリ機構（TY-144）
- [ ] GitHub API レート制限の考慮（1 iteration あたり最低4回の API コール × 20 iteration = 80回。複数 PR が並行する場合は 1時間あたり1,000リクエスト制限に注意。TY-140）
- [ ] Slack 通知等の運用連携（PoC 完了条件からは除外。必要になった時点で別 Issue 化）

---

## PoC では完了、本番で再確認する項目

- [x] `CODEX_REVIEW_REQUEST_TOKEN` により、GitHub 連携済みユーザーとして `@codex review` を投稿できる
- [x] `GITHUB_TOKEN` の `contents: write` により、同一リポジトリ PR branch へ commit/push できる
- [x] Codex inline comment artifact を保存できる
- [x] `CHECK_COMMAND` 前に依存関係をセットアップできる
- [x] 閾値以上 (default `P3`) の finding が解消された場合、hidden comment が `done / no_findings` になる

本番リポジトリでは branch protection、required checks、organization policy が異なる可能性があるため、上記は移植先でも最小 PR で再確認する。

TY-145 の 2026-05-16 検証結果は [Production E2E Validation Notes](../operations/production-e2e-validation.md) に記録した。本 repo では同一リポジトリ PR の auto-fix / `CHECK_COMMAND` / commit-push / no-findings 完了を確認済み。disposable public repo では fork guard と branch protection 下での auto-fix push を確認した。一方、repair commit 上の required check 再実行と、Codex クォータ制限後の最終 no-findings 再レビューは未完了。

## PoC 完了条件から外す項目

以下は PoC の完了条件には含めず、本番移植または移植後の運用改善として扱う。

- Slack 通知、ラベル連携以外の外部連携、管理 UI
- 外部 DB / 外部キュー化。TY-142 (2026-05-16) で workflow-level `concurrency` + PR scoped queue 方針を継続採用と確定。queue 深さ 1 制約 (中間 run 置換) は ETL 集約で許容。本番要件で耐えられないと判明した場合に限り、別途新規 issue を起票して再検討する
- ~~完全な cross-file 修正エンジン化。初期移植では TY-141 で手動対応ポリシーまたは限定実装を決める~~ → TY-141 / TY-236 で `claude-code-action` 採用により解決済み。`docs/specs/claude-code-repair-request.md` 参照
- `/restart-review` の完全自動化。初期移植時は手動復旧で代替可能だが、TY-144 で運用改善として追跡する

---

## 関連ドキュメント

- [PoC チェックリスト](poc-checklist.md)
- [セキュリティ](../operations/security.md)
- [システム概要](../architecture/system-overview.md) — コスト概算・パラメータ
- [全ドキュメント索引](../README.md)
