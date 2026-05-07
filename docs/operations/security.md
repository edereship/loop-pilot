# セキュリティ考慮事項

## Fork PR からの起動防止

外部 fork からの PR で自動修正が動くと、悪意あるコードに対して bot が commit / push する危険がある。

**対策:**
- Workflow のトリガーに `pull_request_target` ではなく `pull_request` を使う
- Workflow A は fork PR の場合に自動レビューを起動しない（`github.event.pull_request.head.repo.full_name != github.repository` で判定）
- Workflow B は trigger 種別に依存せず GitHub API で PR の `.head.repo.full_name` を取得し、空または `github.repository` と異なる場合は checkout / auto-fix 実行前に停止する
- Workflow B の `pr-head-ref` は action 側で ref 名の危険文字を検査してから checkout する

**PoC 段階:** このリポジトリは検証用のためリスクは低いが、本番移植時に必須の対策。PoC でも入れておくと移植時の漏れを防げる。

**PoC 実測:** fork guard は Workflow A/B に実装済み。PR #7 は同一リポジトリ PR のため、外部 fork PR を使った E2E 検証は未実施。本番移植前に外部 fork PR で secrets / checkout / auto-fix が動かないことを確認する。

---

## Repository variables と trigger guard

Workflow B は Codex 総評レビュー/コメントだけで起動する。Repository variables は外部サービス側の bot 名や総評文言が変わった場合の上書き用途であり、未設定でも安全に動く必要がある。

**推奨設定:**
- `CODEX_BOT_LOGIN=chatgpt-codex-connector[bot]`
- `CODEX_REVIEW_MARKER=Codex Review`

PR #7 の実環境では上記値で Codex review を検知できた。未設定時も fallback 条件で安全に判定するテストは追加済み。

**条件式の注意:**
- `contains(any_string, '')` は true になるため、`vars.CODEX_REVIEW_MARKER` は非空チェック後にだけ `contains()` に渡す
- `vars.CODEX_BOT_LOGIN` も非空チェック後にだけ login と比較する
- fallback の `chatgpt-codex-connector[bot]` と `Codex Review` は明示的に別条件として残す
- 通常ユーザーの PR コメント/レビューや、Codex bot 以外の投稿では Workflow B が起動しない

## ラベル付き PR のみ起動する運用（default-strict + full-auto opt-out）

本番リポジトリで意図しない PR に Codex review / Claude auto-fix loop が走らないよう、デフォルトで「`auto-review-fix` ラベルが付いた PR でのみ起動」する仕様（TY-137）。完全自動化したい場合のみ opt-out できる。

**仕様:**
- **デフォルト挙動はラベル必須**。Repository variable `AUTO_REVIEW_LABEL` が空 / 未設定なら `auto-review-fix` ラベルを要求する。ラベル名はレビューだけでなく Claude による自動修正までを示すため `auto-review-fix` を採用する
- カスタムラベル名を使いたい場合は Repository variable `AUTO_REVIEW_LABEL` にラベル名を設定する。ラベル名の変更は variable の値を書き換えるだけで完結し、workflow YAML の修正は不要
- 完全自動化（label gate を無効化して全 PR で起動）したい場合のみ Repository variable `AUTO_REVIEW_FULL_AUTO=true` を設定する
- ラベル名は **小文字固定** を推奨する（例: `auto-review-fix`）。Workflow 側の評価と運用手順の認識ずれを避けるため
- TS 側のラベル比較は case-insensitive だが、運用上の混乱防止のため表示名の揺れ（`Auto-Review-Fix` など）は使わない

**Workflow A（PR 作成 / ready / labeled トリガー）の挙動:**
- デフォルト（label gate 有効）: ラベル未設定の PR が作成・ready になっても hidden comment 作成や `@codex review` 投稿は行わない
- 後から起動ラベルを付けた瞬間（`pull_request.labeled`）に初回 `@codex review` が起動する
- 無関係なラベルが追加されただけでは起動しない（追加されたラベルが要求ラベルと一致する場合のみ）
- `AUTO_REVIEW_FULL_AUTO=true`（label gate 無効）時は `labeled` イベントを `if` で除外する。`main-init.ts` は state を初期化して `@codex review` を再投稿する設計のため、ラベル編集のたびに重複レビューが走らないようにするため
- `AUTO_REVIEW_FULL_AUTO=true` の間は、ラベルの付け外しによる開始/停止はできない（ラベル操作は制御条件として無視される）

**Workflow B（Codex レビュー受信トリガー）の挙動:**
- workflow `if` で trigger payload の labels を確認し、ラベルがなければ即スキップ（fast skip）。`AUTO_REVIEW_FULL_AUTO=true` の場合はこの確認をスキップ
- TS 側でも実行時に `GET /repos/{owner}/{repo}/issues/{pr}/labels` を呼び直し、ラベルが現在も付いているかを再確認する。Codex 投稿後にラベルが外された場合に修正フェーズへ進まないようにするため
- ラベルが外れている場合は state を更新せずに早期 return する。状態は `waiting_codex` のまま温存され、ラベルを付け直した後に新たな `@codex review` が来れば再開する
- `AUTO_REVIEW_FULL_AUTO=true` の場合はこの再確認をスキップするため、ラベル外しでの停止はできない

**運用時の注意（Runbook）:**
- 「ラベルを外したのに止まらない」場合は、`AUTO_REVIEW_FULL_AUTO` が `true` になっていないかを最初に確認する
- full-auto から停止したい場合は、`AUTO_REVIEW_FULL_AUTO=false` に戻す（または workflow を無効化する）。ラベル操作だけでは停止しない

この制御は fork guard や token 最小権限の代替ではなく、誤起動とコスト発生を抑える追加の安全策として扱う。

---

## Bot Token のスコープ

Claude に PR ブランチの checkout と push 権限を与えるため、以下を制限する。

**必要な権限:**
- `contents: write`（commit / push）
- `pull-requests: write`（コメント投稿）
- `issues: write`（hidden comment の読み書き）

PR #7 では、Repository UI で default workflow permission を write に変更できない環境でも、workflow YAML の明示的 `permissions: contents: write` により同一リポジトリ PR branch への commit/push が成功した。

**制限すべき事項:**
- Token は対象リポジトリに限定する（org 全体への権限付与は避ける）
- `GITHUB_TOKEN`（Actions 自動生成）を使用する場合、権限は workflow の `permissions` で最小限に絞る
- Personal Access Token を使う場合は、Fine-grained PAT でリポジトリスコープを限定する

---

## API キーのシークレット管理

Claude API を呼び出すための `ANTHROPIC_API_KEY` は、GitHub Actions の **Repository secrets** に保存する。

**設定手順:**
1. リポジトリの Settings → Secrets and variables → Actions → Repository secrets
2. `ANTHROPIC_API_KEY` として Anthropic API キーを登録

**Workflow 内での参照:**
```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**注意事項:**
- シークレットは workflow のログに出力されない（GitHub が自動マスク）
- Fork PR の workflow ではシークレットにアクセスできない（GitHub のデフォルト挙動で保護される）
- API キーのローテーション手順を本番移植時に定める

> **Fork PR からの起動防止** については上記セクションを参照。

---

## Codex review request token

Codex が `@codex review` を GitHub 連携済みユーザーからの依頼として扱えるように、Repository secret `CODEX_REVIEW_REQUEST_TOKEN` を任意で設定する。

**用途:**
- Workflow A の初回 `@codex review` 投稿
- Workflow B の再レビュー依頼 `@codex review` 投稿

**使わない用途:**
- hidden comment の読み書き
- PR ブランチの checkout / commit / push
- review comment や issue comment の取得
- Artifact 収集

上記の既存 GitHub 操作は `GITHUB_TOKEN` を使い続ける。`CODEX_REVIEW_REQUEST_TOKEN` が未設定の場合、`@codex review` 投稿も `GITHUB_TOKEN` に fallback する。

**推奨 token:**
- Codex と GitHub を接続済みのユーザーが発行した Fine-grained PAT
- 対象リポジトリのみに限定する
- 権限は `Pull requests: Read and write` と `Issues: Read and write` を付与する
- 必要に応じて `Contents: Read-only` を付与する

**注意事項:**
- ログ出力前に GitHub Actions secret としてマスクされるよう、必ず Repository secrets に保存する
- Personal PAT は個人に紐づくため、本番移植時は専用 machine user または GitHub App token への置き換えを検討する
- token は `@codex review` 投稿専用に閉じ、push 権限を持たせない

**PoC 実測:** `CODEX_REVIEW_REQUEST_TOKEN` により、GitHub Actions bot ではなく接続済みユーザーとして `@codex review` を投稿でき、Codex review が起動した。未設定時の `GITHUB_TOKEN` fallback は互換用であり、Codex review 起動を保証するものではない。

本番では個人 PAT 継続ではなく、専用 machine user または GitHub App token へ置き換えるかを TY-143 で判断する。あわせて branch protection / required checks 下での push 可否は TY-145 で確認する。

---

## 関連ドキュメント

- [イベント設計](../architecture/event-design.md) — push 権限の注意点
- [本番移植チェックリスト](../checklists/production-migration.md) — トークンスコープ最小化
- [全ドキュメント索引](../README.md)
