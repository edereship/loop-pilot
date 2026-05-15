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
- `AUTO_REVIEW_FULL_AUTO=true`（label gate 無効）時は `labeled` イベントを `if` で除外する。ラベル編集のたびに余分な init run が起きないようにするため
- `AUTO_REVIEW_FULL_AUTO=true` の間は、ラベルの付け外しによる開始/停止はできない（ラベル操作は制御条件として無視される）
- Workflow A は `init` job 単位の PR scoped `concurrency` で直列化される。PR 作成時に起動ラベルを同時付与して `opened` と `labeled` が近接発火しても、既に `waiting_codex` 以降へ進んだ state は reset せず `@codex review` も再投稿しない
- `concurrency` は workflow level ではなく job level に置く。無関係な `labeled` event は job `if` で skip され、pending init job を置換しないようにするため
- 既存 state が `done` / `stopped` の場合も Workflow A は no-op になる。再実行は `/restart-review` を使う

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

## Claude Code Action 実行制御

`anthropics/claude-code-action@v1` を repo-level repair executor として使う際の、実行上限・cost guard・権限制御の方針（TY-140 で確定）。`claude-fix-engine.ts` の Claude API 直叩き方式が置き換わる前提（TY-234 / TY-236）。TY-236 の workflow 統合はこの節を唯一の参照元として実装する。

### モデル選定

- repository variable: **`CLAUDE_CODE_MODEL`**
- default: **`claude-opus-4-7`**
- workflow からの渡し方: `claude_args: --model ${{ vars.CLAUDE_CODE_MODEL || 'claude-opus-4-7' }}`
- 選定理由:
  - クロスファイル探索／関連サイト整合性／長 turn 文脈保持で Opus が優位
  - v0.2 PoC は月数件 PR 想定で絶対コストは小（最悪 \$60/PR × `MAX_REVIEW_ITERATIONS`）
  - 運用観察後にコストが課題になれば variable で sonnet / haiku に下げる
- model 値は source に直接埋め込まない（TY-164 吸収済み）

### Turn / timeout / iteration 上限

| 項目 | 値 | 設定箇所 |
|------|----|---------|
| `--max-turns` | `40` | `claude_args` |
| Workflow B timeout | `30 min` | workflow job `timeout-minutes` |
| 1 PR あたり repair invocation 上限 | `MAX_REVIEW_ITERATIONS=20` | 既存 env / repository variable |

`--max-turns` は Opus + クロスファイル探索 + check 再実行 + テスト失敗の修復まで含めた余裕値。Workflow B timeout は `npm ci` + repair + 最終 check の合算上限。

### 許可ツール（`--allowedTools`）

初期セットは以下に限定する。

```
Read, Glob, Grep, Edit, Write, Bash(<allowlist>), TodoWrite
```

- `Read` / `Glob` / `Grep`: 関連ファイル探索に必須
- `Edit` / `Write`: 修正。`Write` はテスト fixture や新規 helper を作る必要があるケースで使う
- `TodoWrite`: 副作用なし。多段 repair の計画追跡に有用
- 禁止: `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`
- 禁止（commit / push bypass 対策）: `mcp__github_file_ops__commit_files`, `mcp__github_file_ops__delete_files`, `mcp__github__create_or_update_file`, `mcp__github__push_files`, `mcp__github__delete_file`, `mcp__github__create_branch`, `mcp__github__create_pull_request`, `mcp__github__update_pull_request`, `mcp__github__merge_pull_request`, `mcp__github__fork_repository`

> **bypass 対策の意図:** claude-code-action は `--allowedTools` を **base tools への追加** として扱うため、上記のような GitHub state を直接変更する MCP tool が暗黙に許可されると post-fix の scope check / CHECK_COMMAND を bypass して commit / push できてしまう。実機の claude-code-action はデフォルトで `github_file_ops` server を `use_commit_signing: true` 設定時のみ、full `github` MCP server を allowedTools に `mcp__github__*` が含まれる時のみロードするため、本リポジトリの設定ではいずれも未ロード。ただし上流のデフォルト変更に対する defense-in-depth として明示的に `--disallowedTools` へ列挙しておく。base tools として残る `github_comment` / `github_inline_comment` はコメント投稿用で commit 不可なので許容する。

### 許可 Bash コマンド（allowlist）

**ベースライン**（常に許可）:

```
npm ci
npm run check
npm test
npm run build
git status
git diff
git log
```

**CHECK_COMMAND の動的追加**（TY-238）:

`vars.CHECK_COMMAND` がベースライン未収載のコマンドを指す場合（例: `pnpm run check` / `pytest -xvs tests/` / `make check`）、pre-fix が安全性チェックを通過した場合のみ `Bash(<CHECK_COMMAND>)` をベースラインに **追加** する。これにより、claude-code-action は repair プロンプトで指示された最終 verification を実行できる。

安全性チェック（`src/check-command-allowlist.ts` で実装）:

1. **第一トークン whitelist**: `npm`, `pnpm`, `yarn`, `bun`, `npx`, `pnpx`, `pytest`, `python`, `python3`, `make`, `cargo`, `go`, `mise`, `task`, `just`
2. **文字 whitelist**: `[A-Za-z0-9 ._/=:@+\-]` のみ許可。シェルメタ文字（`;`, `&`, `|`, `>`, `<`, `` ` ``, `$`, `(`, `)`, クォート, カンマ, 改行, バックスラッシュ, glob）は **全て拒否**

拒否された CHECK_COMMAND は **追加されずベースラインに fallback** し、pre-fix が warning ログを出す。claude-code-action は CHECK_COMMAND を実行できず `--max-turns` 到達で停止する可能性が高いので、warning が出た場合は CHECK_COMMAND を whitelist に収まる形に修正する。

明示的に禁止する操作:

- `rm`, `mv`, `cp` — ファイル操作は `Edit` / `Write` 経由のみ
- `curl`, `wget`, `nc` 等のネットワーク系
- `chmod`, `chown` 等の権限変更
- pipe / redirect 含む合成コマンド（監査困難なため）
- `bash`, `sh`, `eval` — 任意シェル実行が可能なため、CHECK_COMMAND の第一トークンとしても不可

`Read` / `Glob` / `Grep` が読み取りを担うので、`ls` / `cat` / `head` / `tail` は allowlist から外す。

### 変更スコープ検査（post-fix）

claude-code-action 実行後、workflow 側で diff を検査し、以下のいずれかを満たさない場合は **revert + `stop_reason: scope_violation`**。

| 項目 | 上限 / 規則 |
|------|------------|
| changed files | `≤ 20` |
| changed lines（追加+削除） | `≤ 1000` |
| allowed paths | `src/`, `tests/`, `docs/` のみ |
| **hard block paths**（変更があれば即 violation） | `.github/`, `node_modules/`, `dist/`, `package.json`, `package-lock.json`, `tsconfig.json`, dotfiles 一式 |

`.github/` を hard block するのは privilege escalation（workflow 経由で secrets 漏洩や任意コード実行が可能になる）の入口を塞ぐため。`package.json` / `package-lock.json` を hard block するのは依存追加による供給チェーン汚染防止。これらの変更が必要な repair は **手動対応** として PR コメントで報告する。

### Secrets / token / workflow permissions

- claude-code-action の `env:` に渡すのは **`ANTHROPIC_API_KEY` のみ**
- `GITHUB_TOKEN` / `CODEX_REVIEW_REQUEST_TOKEN` は wrapping workflow の他 step でのみ使用し、agent の手に渡さない
- workflow permissions は既存最小値を維持:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

- 追加で `actions:`, `id-token:`, `packages:`, `deployments:` 等を **付けない**

### `allowed_bots`

- Workflow B は Codex bot (`chatgpt-codex-connector[bot]`) の `pull_request_review.submitted` をトリガーとするため、claude-code-action 内部の「non-human actor guard」は **Codex bot のみを明示的に allow** する必要がある
- `allowed_bots` には `${{ inputs.codex-bot-login }}` を渡す。デフォルト値は `chatgpt-codex-connector[bot]`、Repository variable `CODEX_BOT_LOGIN` で上書き可能
- `'*'` は依然として **禁止**（任意 bot trigger に拡げない）
- 元方針の「`allowed_bots: []` で固定」は、claude-code-action を human-triggered workflow からのみ呼ぶ前提だった。実装では Codex review 受信から自動起動する設計のため、Codex bot のみ通す形で緩和した（TY-237 dogfood で判明）

### Fork PR / 外部 contributor

- 既存の fork guard（Workflow A / B）を維持
- `auto-review-fix` ラベルは maintainer 限定で運用（GitHub のラベル付与権限により実質的に gate される）
- claude-code-action ステップ自体に `if` で fork チェックを **再度** 入れ、二重ガードする
- E2E 検証は TY-145 で実施

### 失敗時の停止理由（StopReason 拡張）

`src/types.ts` の `StopReason` 型に以下を追加（このチケットで実装済み）。`comment-poster.ts` の `STOP_REASON_LABELS` も同期させる。

| 値 | 発生条件 |
|----|---------|
| `action_timeout` | Workflow B job が `timeout-minutes` を超えた |
| `action_failure` | claude-code-action が非ゼロで終了した（max-turns 以外） |
| `scope_violation` | 上記スコープ検査でいずれかの規則に違反した |
| `max_turns_exceeded` | `--max-turns` を使い切って repair が完了しなかった |

`rate_limit` / `overloaded` 等の Anthropic API レベルの一時失敗は既存 `claude_api_error` を流用する（claude-code-action 内部でリトライ済みのため、ここに到達した時点で API 障害扱い）。

### コスト見積もり（参考）

| ケース | 1 iteration | 20 iteration（PR 上限） |
|--------|-------------|------------------------|
| 標準（Opus、10 turn） | ~\$1.5 | ~\$30 |
| 最悪（Opus、40 turn） | ~\$3 | ~\$60 |

`auto-review-fix` label 付き PR が月 5 件と想定すると **\$50〜300/月**。これを超える運用規模に到達した時点で `CLAUDE_CODE_MODEL=claude-sonnet-4-6` に下げる、または `MAX_REVIEW_ITERATIONS` を `10` に絞る等で調整可能。

### 関連チケット

- [TY-234](https://linear.app/team-yubune/issue/TY-234): repo-level repair executor 方針決定（claude-code-action 採用）
- [TY-140](https://linear.app/team-yubune/issue/TY-140): 本節の規定
- [TY-164](https://linear.app/team-yubune/issue/TY-164): モデル variable 化（TY-140 に吸収）
- [TY-235](https://linear.app/team-yubune/issue/TY-235): repair request / prompt payload 生成
- [TY-236](https://linear.app/team-yubune/issue/TY-236): 本節の規定を workflow 統合に反映
- [TY-238](https://linear.app/team-yubune/issue/TY-238): CHECK_COMMAND 追従の Bash allowlist 化
- [TY-145](https://linear.app/team-yubune/issue/TY-145): fork PR / branch protection 下での E2E 検証

---

## 関連ドキュメント

- [イベント設計](../architecture/event-design.md) — push 権限の注意点
- [本番移植チェックリスト](../checklists/production-migration.md) — トークンスコープ最小化
- [全ドキュメント索引](../README.md)
