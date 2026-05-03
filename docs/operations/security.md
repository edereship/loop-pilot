# セキュリティ考慮事項

## Fork PR からの起動防止

外部 fork からの PR で自動修正が動くと、悪意あるコードに対して bot が commit / push する危険がある。

**対策:**
- Workflow のトリガーに `pull_request_target` ではなく `pull_request` を使う
- Workflow A は fork PR の場合に自動レビューを起動しない（`github.event.pull_request.head.repo.full_name != github.repository` で判定）
- Workflow B は trigger 種別に依存せず GitHub API で PR の `.head.repo.full_name` を取得し、空または `github.repository` と異なる場合は checkout / auto-fix 実行前に停止する
- Workflow B の `pr-head-ref` は action 側で ref 名の危険文字を検査してから checkout する

**PoC 段階:** このリポジトリは検証用のためリスクは低いが、本番移植時に必須の対策。PoC でも入れておくと移植時の漏れを防げる。

---

## Repository variables と trigger guard

Workflow B は Codex 総評レビュー/コメントだけで起動する。Repository variables は外部サービス側の bot 名や総評文言が変わった場合の上書き用途であり、未設定でも安全に動く必要がある。

**推奨設定:**
- `CODEX_BOT_LOGIN=chatgpt-codex-connector[bot]`
- `CODEX_REVIEW_MARKER=Codex Review`

**条件式の注意:**
- `contains(any_string, '')` は true になるため、`vars.CODEX_REVIEW_MARKER` は非空チェック後にだけ `contains()` に渡す
- `vars.CODEX_BOT_LOGIN` も非空チェック後にだけ login と比較する
- fallback の `chatgpt-codex-connector[bot]` と `Codex Review` は明示的に別条件として残す
- 通常ユーザーの PR コメント/レビューや、Codex bot 以外の投稿では Workflow B が起動しない

---

## Bot Token のスコープ

Claude に PR ブランチの checkout と push 権限を与えるため、以下を制限する。

**必要な権限:**
- `contents: write`（commit / push）
- `pull-requests: write`（コメント投稿）
- `issues: write`（hidden comment の読み書き）

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

---

## 関連ドキュメント

- [イベント設計](../architecture/event-design.md) — push 権限の注意点
- [本番移植チェックリスト](../checklists/production-migration.md) — トークンスコープ最小化
- [全ドキュメント索引](../README.md)
