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
| TY-137 | High | 実装済み / 設定 | ラベル付き PR のみ auto-review を起動する default-strict 運用（`AUTO_REVIEW_LABEL` でラベル名カスタマイズ、`AUTO_REVIEW_FULL_AUTO=true` で全自動 opt-out） |
| TY-138 | High | 必須 / テスト | 複数 Codex 指摘を受けた場合の auto-fix loop テスト |
| TY-139 | High | 必須 / 実装 | hidden comment の楽観ロック + TOCTOU 対策 |
| TY-140 | High | 必須 / 運用判断 | Claude API retry / cost limit / spending guard |
| TY-143 | High | 必須 / 認証判断 | 本番用 token / GitHub App / machine user 運用 |
| TY-145 | High | 必須 / E2E 検証 | 外部 fork PR と branch protection 下での本番 E2E |
| TY-141 | Medium | 条件付き必須 / 仕様判断 | large file と cross-file finding の対応方針 |
| TY-142 | Medium | 仕様判断 | debounce / concurrency / `issue_comment` 互換 trigger 方針 |
| TY-144 | Medium | 運用改善 | `/restart-review` と hidden state recovery |

High は本番移植前に完了または明確な保留判断が必要な項目。Medium は初期移植では手動運用や制限付き運用で代替できるが、移植先の規模・運用要件によって High に上げる。

---

## 設計上の修正が必要な項目（本番移植前に必須）

- [x] ラベル付き PR のみ auto-review を起動する default-strict を実装する（TY-137 — デフォルトで `auto-review-fix` ラベル必須。`AUTO_REVIEW_LABEL` でラベル名カスタマイズ、`AUTO_REVIEW_FULL_AUTO=true` で全 PR opt-out）
- [ ] 複数 Codex 指摘を受けた場合の auto-fix loop テストを追加する（TY-138）
- [ ] インラインコメントの取得範囲フィルタの検証（`created_at` ベースのフィルタが期待通り動作するか。TY-138 の複数指摘テストに含める）
- [ ] Claude API エラー時のリトライ戦略の実装・チューニング（TY-140）
- [ ] `CHECK_COMMAND` の各プロジェクトへの適用（`package.json` の `check` スクリプト整備。TY-145 の移植先 E2E で確認）
- [ ] Claude API 呼び出しのバッチ化検討（findings が少ないファイル同士をまとめて1回の API 呼び出しで処理し、コスト効率を改善する。TY-140）
- [ ] hidden comment の競合対策（楽観ロック + TOCTOU 対策の実装。方針は [状態管理](../architecture/flow-and-state.md#hidden-comment-の競合書き込みリスク) に記載済み。PoC では concurrency 制御で代替。TY-139）
- [ ] large file の扱いを決める。PoC では文字数ベースの `MAX_INPUT_TOKENS_PER_FILE` 超過時にスキップし、chunking は未実装（TY-141）
- [ ] cross-file finding の扱いを決める。PoC はファイル単位で閉じた修正のみ対応（TY-141）
- [ ] 互換用 `issue_comment` トリガー経由で修正 commit/push まで進むケースを検証する、または本番では `pull_request_review` のみを正式対応にする（TY-142）
- [ ] `DEBOUNCE_SECONDS=0` への短縮可否を決める。PR #7 ではデフォルト待機での安定動作のみ確認済み（TY-142）
- [ ] `concurrency` キューの実運用リスクを判断する。GitHub Actions の待機キュー制約により、短時間の複数 review では中間 run が置き換えられる可能性がある（TY-142 / TY-139）

---

## 運用・セキュリティの項目

- [ ] デバウンス方式の見直し（`sleep` → イベント駆動 or 外部スケジューラ。TY-142）
- [x] Codex のレビュー形式に合わせた severity パーサーの厳密化（PoC で取得した実コメントを基に）
- [x] `Codex Review` 文言の環境変数化（`CODEX_REVIEW_MARKER`）— PoC 段階で対応済み
- [x] Codex bot 名 `chatgpt-codex-connector[bot]` の環境変数化（`CODEX_BOT_LOGIN`）— PoC 段階で対応済み
- [ ] Bot Token のスコープ最小化と Fine-grained PAT の設定（TY-143）
- [ ] `CODEX_REVIEW_REQUEST_TOKEN` の運用方式決定（個人 PAT 継続ではなく、専用 machine user または GitHub App token への置き換えを検討。TY-143）
- [x] Fork PR 起動防止の実装
- [x] 外部 fork PR を使った起動防止 E2E 検証（TY-145）。2026-05-16 に disposable public repo `racoma-dev/auto-review-fix-test` の fork PR #1 で、Workflow A が起動せず、手動レビュー後の Workflow B も fork guard で checkout / auto-fix / push 前に停止することを確認済み。手順と証跡は [Production E2E Validation Notes](../operations/production-e2e-validation.md#external-fork-pr-validation) を参照
- [x] branch protection / required checks 下での commit/push 可否確認（TY-145 / TY-257）。2026-05-16 に disposable public repo PR #2 で `GITHUB_TOKEN` repair push 後に必須CI `check` が再実行されないことを確認し、TY-257 で `AUTO_REVIEW_PUSH_TOKEN` を追加した。その後 PR #3 で dedicated push token により repair commit 上の `check` が再実行され、`done / no_findings` と `mergeStateStatus=CLEAN` まで到達することを確認済み。詳細は [Production E2E Validation Notes](../operations/production-e2e-validation.md#branch-protection-and-rulesets) を参照
- [ ] `MAX_REVIEW_ITERATIONS` の適正値決定（コスト試算に基づく。20以上も検討。TY-140）
- [ ] `/restart-review` 等のリカバリコマンド実装（TY-144）
- [ ] hidden comment 消失時の自動リカバリ機構（TY-144）
- [ ] GitHub API レート制限の考慮（1 iteration あたり最低4回の API コール × 20 iteration = 80回。複数 PR が並行する場合は 1時間あたり1,000リクエスト制限に注意。TY-140 / TY-142）
- [ ] Slack 通知等の運用連携（PoC 完了条件からは除外。必要になった時点で別 Issue 化）

---

## PoC では完了、本番で再確認する項目

- [x] `CODEX_REVIEW_REQUEST_TOKEN` により、GitHub 連携済みユーザーとして `@codex review` を投稿できる
- [x] `GITHUB_TOKEN` の `contents: write` により、同一リポジトリ PR branch へ commit/push できる
- [x] Codex inline comment artifact を保存できる
- [x] `CHECK_COMMAND` 前に依存関係をセットアップできる
- [x] P0/P1 が解消された場合、hidden comment が `done / no_findings` になる

本番リポジトリでは branch protection、required checks、organization policy が異なる可能性があるため、上記は移植先でも最小 PR で再確認する。

TY-145 の 2026-05-16 検証結果は [Production E2E Validation Notes](../operations/production-e2e-validation.md) に記録した。本 repo では同一リポジトリ PR の auto-fix / `CHECK_COMMAND` / commit-push / no-findings 完了を確認済み。disposable public repo では fork guard と branch protection 下での auto-fix push を確認した。一方、repair commit 上の required check 再実行と、Codex クォータ制限後の最終 no-findings 再レビューは未完了。

## PoC 完了条件から外す項目

以下は PoC の完了条件には含めず、本番移植または移植後の運用改善として扱う。

- Slack 通知、ラベル連携以外の外部連携、管理 UI
- 外部 DB / 外部キュー化。ただし `concurrency` キュー制約が本番要件に合わない場合は TY-142 で再判断する
- 完全な cross-file 修正エンジン化。初期移植では TY-141 で手動対応ポリシーまたは限定実装を決める
- `/restart-review` の完全自動化。初期移植時は手動復旧で代替可能だが、TY-144 で運用改善として追跡する

---

## 関連ドキュメント

- [PoC チェックリスト](poc-checklist.md)
- [セキュリティ](../operations/security.md)
- [システム概要](../architecture/system-overview.md) — コスト概算・パラメータ
- [全ドキュメント索引](../README.md)
