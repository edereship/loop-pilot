# セキュリティ考慮事項

## Fork PR からの起動防止

外部 fork からの PR で自動修正が動くと、悪意あるコードに対して bot が commit / push する危険がある。

**対策:**
- Workflow のトリガーに `pull_request_target` ではなく `pull_request` を使う
- Fork PR の場合は Workflow を起動しない（`github.event.pull_request.head.repo.full_name != github.repository` で判定）

**PoC 段階:** このリポジトリは検証用のためリスクは低いが、本番移植時に必須の対策。PoC でも入れておくと移植時の漏れを防げる。

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

## 関連ドキュメント

- [イベント設計](../architecture/event-design.md) — push 権限の注意点
- [本番移植チェックリスト](../checklists/production-migration.md) — トークンスコープ最小化
- [全ドキュメント索引](../README.md)
