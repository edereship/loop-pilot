# イベント設計

## Workflow 構成

LoopPilot は **2本の workflow** で構成する。設計上の Workflow B（レビュー受信）と C（Claude 修正）は、1つの workflow 内の step として統合する。これにより、workflow 間のデータ受け渡し（PR 番号、findings 等）が不要になる。

将来 Workflow C の分離が必要になった場合は、`workflow_call` で切り出す。

### 配布形態: 再利用可能ワークフロー + 薄い caller

2 本の論理 workflow は **再利用可能ワークフロー（`on: workflow_call`）** として本リポジトリに集約して配布する。

- 実装本体: `.github/workflows/init.yml` / `.github/workflows/loop.yml`（gate `if:`・Codex マーカー判定・fork ガード・toolchain セットアップ・crash fail-safe を集約）
- adopter 側: 発火イベントと secret / 権限だけの薄い caller（`looppilot-init.yml` / `looppilot-loop.yml`）で `uses: Edereship/loop-pilot/.github/workflows/{init,loop}.yml@v1` を参照する

発火イベント（`pull_request` / `issue_comment` / `pull_request_review`）の `on:` は **caller 側に残す**（`workflow_call` は caller のイベントで起動するため）。`vars` / `github` コンテキストは caller リポジトリに解決されるので、operator の Repository variables はそのまま効く。再利用ワークフロー内のサブアクション参照は `./loop` ではなく `Edereship/loop-pilot/{loop,init}@v1`（`./` は caller の checkout に解決され壊れるため）。

以降の節で示す `if:` / step / concurrency は、この再利用ワークフロー（`init.yml` / `loop.yml`）側に実装される。caller は薄い参照のみ。

---

## Workflow A: PR 作成時（再利用 `init.yml` / caller `looppilot-init.yml`）

Workflow A は hidden comment を作成し、`CODEX_REVIEW_REQUEST_TOKEN` 経由で `@codex review` を投稿する。投稿は GitHub Actions bot ではなく接続済みユーザーとして行われ、Codex review が起動する。

トリガー:
- `pull_request.opened`
- `pull_request.ready_for_review`
- `pull_request.labeled`（後付けで起動ラベルを付けたケース用）

```yaml
on:
  pull_request:
    types: [opened, ready_for_review, labeled]
```

前提条件（job の `if`）:
```yaml
if: >
  github.event.pull_request.draft == false &&
  github.event.pull_request.head.repo.full_name == github.repository &&
  (
    (vars.LOOPPILOT_FULL_AUTO == 'true' && github.event.action != 'labeled') ||
    (
      vars.LOOPPILOT_FULL_AUTO != 'true' &&
      contains(github.event.pull_request.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot') &&
      (github.event.action != 'labeled' || github.event.label.name == (vars.LOOPPILOT_LABEL || 'loop-pilot'))
    )
  )
```

- draft PR では自動レビューを起動しない。作成途中のコードに対して Codex レビュー → Claude 修正が走ることを防ぐ
- `ready_for_review` イベントは draft → ready 変換時に発火するため、draft 解除後に初回レビューが起動する
- fork PR では自動レビューを起動しない。外部コードに対して token を持つ auto-fix loop を開始しないため
- **デフォルト挙動はラベル必須（default-strict）**。Repository variable `LOOPPILOT_LABEL` が空 / 未設定なら `loop-pilot` ラベルを要求する（ラベル名は Codex レビュー＋ Claude 自動修正の両方を示すため `loop-pilot`）。`LOOPPILOT_LABEL` を設定すれば任意のラベル名へ変更可能
- ラベル名は小文字固定を推奨する（例: `loop-pilot`）。大文字小文字の揺れを避け、運用上の認識ずれを防ぐ
- 完全自動化（全 PR で起動）にしたい場合のみ `LOOPPILOT_FULL_AUTO=true` を Repository variable で設定する。設定すると label gate が無効化され、すべての非 fork ready PR で Workflow A が起動する
- `LOOPPILOT_FULL_AUTO=true` 時は `labeled` イベントを Workflow A の起動条件から除外する。ラベル編集のたびに余分な init run が起きるのを防ぐ
- `LOOPPILOT_FULL_AUTO=true` の間はラベルの付け外しを制御条件として使えない（ラベル操作では開始/停止しない）
- gate 有効時の `labeled` イベントは、付与されたラベルが要求ラベル（`LOOPPILOT_LABEL || 'loop-pilot'`）と一致する場合だけ起動する。無関係なラベルが追加されただけでは Workflow A は走らない

役割:
- hidden comment で状態を初期化（`status: initialized`, `iteration_count: 0`）
- `gh pr comment` で `@codex review` を投稿
- `CODEX_REVIEW_REQUEST_TOKEN` が設定されている場合、`@codex review` の投稿だけ接続済みユーザー PAT を使用する。未設定時は `GITHUB_TOKEN` に fallback する

冪等化:
- Workflow A は `init` job 単位の PR scoped `concurrency` で直列化する。PR 作成時に起動ラベルを同時付与して `opened` と `labeled` が近接発火しても、後続 job は先行 job の state 更新後に実行される
- `concurrency` は workflow level ではなく job level に置く。無関係な `labeled` event は job `if` で skip され、pending init job を置換しないようにするため
- 既存 state が `waiting_codex` / `fixing` / `done` / `stopped` の場合、Workflow A は state reset も `@codex review` 再投稿も行わず no-op で終了する
- 既存 state が `initialized` の場合は、前回 init が `@codex review` 投稿前に止まった未完了状態として扱い、初回レビュー投稿を継続する
- corrupted state comment は従来通り fresh state で上書きし、初期化を継続する

`runInit` の書き込み順序:

post-fix Phase 4 と同形の「1st write → side-effect → 2nd write」両書きパターンに揃える。`@codex review` 投稿 → state 更新の単純な順序では、投稿成功後の state 書きが失敗すると `status: initialized` のまま `@codex review` だけ投稿された状態で固定され、operator が gate label を付け直して Workflow A を再実行すると `@codex review` を二重投稿してしまう。これを避けるため、以下の順序を採る。

- **1st write**: `status: waiting_codex`, `lastCodexRequestCommentId: null` を hidden comment に永続化する。この書き込みが成功すれば、後続の `@codex review` 投稿が落ちて Workflow A が再実行されても、既存 state は `waiting_codex` に到達済みなので `status !== "initialized"` の早期 return で再実行は no-op になる
- **side-effect**: `@codex review` を投稿する
- **2nd write**: `lastCodexRequestCommentId` を記録する。この書き込みは informational なので失敗しても `core.warning` に降格し、`runInit` 全体は reject しない。次の Codex review trigger で `lastProcessedReviewId` の dedup が一時的に弱まるだけで、Codex 側は同一 PR の重複 review request としてスキップする
- **resume 判定**: 既存 state が `status: initialized` の場合は、`lastCodexRequestCommentId` の値に関わらず、常に 1st write → post → 2nd write の完全シーケンスを実行する。`lastCodexRequestCommentId !== null` であっても、旧パターンで投稿した `@codex review` は `created` イベントとして state が `initialized` のまま Workflow B に到達し、early-return で消費されているため、ループを進めるには新たな投稿が必要になる

---

## Workflow B: Codex レビュー受信 + Claude 修正（再利用 `loop.yml` / caller `looppilot-loop.yml`）

Workflow B は `pull_request_review.submitted` トリガーで起動し、PR head checkout、Claude 修正、`CHECK_COMMAND`、commit/push、再 `@codex review` までを実行する。再レビュー後に Codex が no major issues コメントを投稿した場合は `issue_comment` トリガーで処理し、`done / no_findings` で終了する。

**タイムアウト:** job に `timeout-minutes: 30` を設定する（デバウンス待機 + Claude API 呼び出し + テスト実行の合計時間。プロジェクトのテスト時間に応じて調整する）。

トリガー:
- `pull_request_review` の `submitted` イベント（Codex のレビュー投稿を検知）
- 互換用に `issue_comment` の `created` イベント（Codex の総評コメント）も許可する

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
```

前提条件（job の `if`）:
```yaml
if: >
  (
    vars.LOOPPILOT_FULL_AUTO == 'true' ||
    contains(github.event.issue.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot') ||
    contains(github.event.pull_request.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot')
  ) &&
  (
    (
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      (
        github.event.comment.user.login == 'chatgpt-codex-connector[bot]' ||
        (vars.CODEX_BOT_LOGIN != '' && github.event.comment.user.login == vars.CODEX_BOT_LOGIN)
      ) &&
      (
        contains(github.event.comment.body, 'Codex Review') ||
        (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER))
      )
    ) ||
    (
      github.event_name == 'pull_request_review' &&
      github.event.review.state == 'commented' &&
      (
        github.event.review.user.login == 'chatgpt-codex-connector[bot]' ||
        (vars.CODEX_BOT_LOGIN != '' && github.event.review.user.login == vars.CODEX_BOT_LOGIN)
      ) &&
      (
        contains(github.event.review.body, 'Codex Review') ||
        (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.review.body, vars.CODEX_REVIEW_MARKER))
      )
    )
  )
```

> **注意: 演算子の優先度と空文字列について:**
> - `&&` は `||` より優先度が高いため、bot 名の `||` フォールバックは必ず括弧で囲むこと。括弧がない場合、意図しない条件で workflow が起動する
> - `contains()` の第2引数に `||` を含む式（例: `vars.X || 'default'`）を渡すと、GitHub Actions の expression evaluator での評価結果が不定。**`contains()` を2つに分けて `||` で繋ぐこと**
> - **空文字列の危険:** `contains(any_string, '')` は **常に true** を返す。`vars.CODEX_REVIEW_MARKER` は `vars.CODEX_REVIEW_MARKER != ''` を確認してから `contains()` に渡すこと。bot 名も `vars.CODEX_BOT_LOGIN != ''` を確認してから比較すること
> - Repository variables 未設定時も fallback の `chatgpt-codex-connector[bot]` と `Codex Review` だけで判定する。設定時は fallback と設定値のどちらも許可する

- PR に紐づく `issue_comment` または `pull_request_review` であること
- Codex bot の投稿であること（`CODEX_BOT_LOGIN` Repository variable で制御）
- レビュー本文または総評コメントに `CODEX_REVIEW_MARKER` Repository variable の文言を含むこと
- `LOOPPILOT_FULL_AUTO != 'true'` の場合（デフォルト）はトリガー payload の labels（`issue_comment` は `github.event.issue.labels`、`pull_request_review` は `github.event.pull_request.labels`）に `LOOPPILOT_LABEL || 'loop-pilot'` が含まれていること
- `LOOPPILOT_FULL_AUTO == 'true'` の場合は label 確認をスキップ

> **ランタイム再確認:** YAML の `if` で評価される labels は trigger 時点のスナップショットなので、Codex 投稿後にラベルが外された場合は Workflow B の TS 側で再度 `GET /repos/{owner}/{repo}/issues/{pr}/labels` を呼び、ラベルが残っているかを確認する。残っていない場合は state を変えずに早期 return する（後述「Phase 0 ラベルゲート」）。

推奨 Repository variables:

- `CODEX_BOT_LOGIN=chatgpt-codex-connector[bot]`
- `CODEX_REVIEW_MARKER=Codex Review`
- `LOOPPILOT_LABEL=loop-pilot`（カスタムラベル名を使う場合のみ。未設定なら `loop-pilot` をフォールバック使用）
- `LOOPPILOT_FULL_AUTO=true`（label gate を無効化して全 PR で起動したい場合のみ）

上記推奨値で Codex review を検知できる。

> **注意:** bot 名・検知文言は OpenAI 側のアップデートで変更される可能性がある。Repository variables（`CODEX_BOT_LOGIN`, `CODEX_REVIEW_MARKER`）で外部化しているため、変更時は variables を更新するだけで workflow の修正は不要。未設定または空文字の場合でも fallback 条件だけで評価され、空文字 `contains()` は実行されない。

### Codex review request token

Codex が GitHub 連携済みユーザーのメンションとして `@codex review` を認識できるように、Workflow A/B は action input `codex-review-request-token` を受け取る。

```yaml
- uses: Edereship/loop-pilot/init@v1   # 再利用ワークフロー内のサブアクション参照（caller では不要）
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

```yaml
- uses: Edereship/loop-pilot/loop@v1   # 再利用ワークフロー内のサブアクション参照（caller では不要）
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
```

- `CODEX_REVIEW_REQUEST_TOKEN` は Repository secrets に登録する
- 設定する token は Codex と GitHub を接続済みのユーザーが発行した Fine-grained PAT とする
- この token は `@codex review` 投稿専用であり、hidden comment、checkout/push、Artifact 収集、review comment 取得などは従来通り `GITHUB_TOKEN` を使う
- secret 未設定時は `GITHUB_TOKEN` に fallback し、既存 workflow との互換性を保つ

### LoopPilot push token

Branch protection の required checks がある本番 repo では、repair commit を
`GITHUB_TOKEN` で push しても、その commit 上で GitHub Actions の required
check が作成されない場合がある。Workflow B は action input
`looppilot-push-token` を受け取り、設定されている場合は post-fix の
repair commit push にだけ使用する。

```yaml
- uses: Edereship/loop-pilot/loop@v1   # 再利用ワークフロー内のサブアクション参照（caller では不要）
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
    looppilot-push-token: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
```

- `LOOPPILOT_PUSH_TOKEN` は Repository secrets に登録する
- 推奨は対象 repo に限定した machine user Fine-grained PAT または GitHub App installation token
- 必須権限は repair commit push 用の `Contents: Read and write`
- `CODEX_REVIEW_REQUEST_TOKEN` とは分け、レビュー依頼用 token に push 権限を持たせない
- secret 未設定時は既存挙動との互換性のため `GITHUB_TOKEN` 相当の push 経路を使う

### review / issue_comment トリガー特有の注意点

`pull_request_review` / `issue_comment` でトリガーされた workflow は、PR ブランチを自動 checkout しない。PR ブランチのコードを操作するには、明示的に PR の head ref を指定する必要がある。

```yaml
- name: Get PR head ref
  id: pr
  run: |
    PR_DATA=$(gh api "/repos/${{ github.repository }}/pulls/${PR_NUM}")
    echo "head_ref=$(echo "$PR_DATA" | jq -r '.head.ref')" >> "$GITHUB_OUTPUT"
    echo "head_sha=$(echo "$PR_DATA" | jq -r '.head.sha')" >> "$GITHUB_OUTPUT"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}

- uses: actions/checkout@v4
  with:
    ref: ${{ steps.pr.outputs.head_ref }}
```

> **注意:** `issue_comment` では `github.event.issue.pull_request` にブランチ情報が含まれず、`pull_request_review` でも fork guard 用の head repo 判定を統一したいため、GitHub API で PR 情報を別途取得する。

Workflow B は GitHub API で取得した `.head.repo.full_name` が空または `github.repository` と異なる場合、fork PR または source repo 不明として `Run auto-fix loop` より前に停止する。`pr-head-ref` は action input として渡した後、action 側で ref 名の危険文字を検査してから checkout する。

> **注意: push 権限について:** PR ブランチにブランチ保護ルール（required reviews, status checks 等）が設定されている場合、`GITHUB_TOKEN` による push がブロックされる、または push 後の required checks が修復コミット上で発火しない可能性がある。この場合、以下のいずれかで対処する:
> - ブランチ保護ルールで **"Allow specified actors to bypass required pull requests"** に GitHub Actions bot を追加する
> - `LOOPPILOT_PUSH_TOKEN` に GitHub App token または Fine-grained PAT を設定し、repair commit push だけ専用 token で行う
>
> Repository UI で default workflow permission を write に変更できない環境でも、workflow YAML の `permissions: contents: write` により head branch へ commit/push できる。一方で `GITHUB_TOKEN` による repair push の後に required check が発火しないケースがあるため、専用の `LOOPPILOT_PUSH_TOKEN` を用意している。

### Workflow B の処理フェーズ

役割（1つの workflow 内で step として順次実行）:

**Phase 0: ラベルゲート（default-strict, full-auto opt-out）**
- `LOOPPILOT_FULL_AUTO == true` の場合は本フェーズをスキップ
- それ以外（デフォルト）では `GET /repos/{owner}/{repo}/issues/{pr}/labels` で現在のラベルを取得
- 起動ラベル `LOOPPILOT_LABEL || 'loop-pilot'` が付いていなければ、state を変更せずに即 return（hidden comment や findings は触らない）
- ラベル比較は case-insensitive で workflow YAML の `contains()` と整合させる
- ただし運用では小文字ラベルを固定使用する。case を揺らさないことで、トリガー判定の想定違いを防ぐ

**Phase 1: レビュー受信・集約**
- hidden comment から状態を読み込む
- **ガード条件:** `status` が `fixing` または `stopped` または `done` の場合は即スキップして終了（`fixing`: 先行 workflow と競合するため。`stopped` / `done`: 停止・完了後に Codex の遅延コメントが到着しても再起動しないため）
- `last_processed_review_id`（trigger comment/review の ID）と比較し、同一レビューは処理しない
- `DEBOUNCE_SECONDS` 待機（インラインコメントが全て出揃うのを待つ）
  - trigger summary 自体が「no findings 系」 (例: Codex の「Didn't find any major issues」) を示唆する場合は debounce を skip する。inline コメントが 0 件で確定しているため 90 秒待っても得るものがない。判定は `summaryMayContainFindings` (`src/review-collector.ts`) と共用。誤検知時の safety net は `shouldStabilizeReviewComments` 経路で fetch 後に再 polling される
- GitHub API（`GET /repos/{owner}/{repo}/pulls/{number}/comments`）で PR の review comments を取得
- `chatgpt-codex-connector[bot]` のコメントのみフィルタ
- **取得範囲の絞り込み:** `last_codex_review_received_at` 以降に `created_at` を持つコメントのみを対象とする。過去の iteration のコメントを再処理しないため（詳細は後述「インラインコメントの取得範囲」を参照）
- severity バッジの正規表現で抽出（→ [Severity パーサー仕様](../specs/severity-parser.md)）。Codex finding は P0 / P1 / P2 / P3 を識別する
- `LOOPPILOT_SEVERITY_THRESHOLD`（default `P3`）以上の severity の finding を修正対象に残し、それ未満は skip する。skip 件数は observability ログとして出力する
  - severity が読み取れなかった finding は `core.warning("[review-collector] Skipped N comments due to unparseable severity; check parser regex.")` で件数報告（parser regex 要見直しサイン）
  - threshold 未達 (例: threshold=`P2` で P3) の finding は `core.info("[review-collector] Skipped N findings below threshold (threshold=P2).")` で件数報告
  - 両者を分けることで「Codex の形式変更で全件 silent 脱落」を検知できる

**インラインコメントの取得範囲:**

`GET /repos/{owner}/{repo}/pulls/{number}/comments` は PR の **全インラインコメント** を返す。過去の iteration で修正済みの指摘を再処理しないため、以下の条件でフィルタする。

1. `comment.user.login == 'chatgpt-codex-connector[bot]'`
2. `comment.created_at > last_codex_review_received_at`（前回処理時点より後のコメントのみ）
3. 上記を満たすコメントのみを findings 抽出の対象とする

初回（`last_codex_review_received_at` が null）の場合は、`chatgpt-codex-connector[bot]` の全インラインコメントを対象とする。

> **注意:** GitHub API の `since` パラメータは review comments エンドポイントではサポートされていない場合がある。クライアント側で `created_at` をフィルタすること。

**Phase 2: 判定**
- 閾値以上の finding が 0 件 → `status: done` で終了
- `iteration_count >= MAX_REVIEW_ITERATIONS` → `status: stopped` で終了
- `findings_hash_history`（直近 N 回分）と比較し、同一指摘ループ → `status: stopped` で終了（→ [ループ検知](../specs/loop-detection.md)）
- 上記以外 → Phase 3 へ

**Phase 3: claude-code-action 修正（pre-fix → claude-code-action → post-fix の3-step composite）**

Workflow B の `Run auto-fix loop` ステップは composite action（`loop/action.yml`）として 3 つのサブステップに分割されている。

1. **pre-fix（`loop/pre-fix`、Node JS action）**
   - `status: fixing` に更新（`iteration_count += 1`）
   - `findings` から [`buildClaudeCodeRepairRequest`](../specs/claude-code-repair-request.md) でリペアリクエストを構築し、prompt を生成する
   - GITHUB_OUTPUT に `should_run` / `prompt` / `iteration` / `comment_id` などを書き出す
   - 早期 return（done / max_iterations / loop_detected）の場合は `should_run=false` を出力し、後続 step を skip する
2. **`anthropics/claude-code-action@v1`（[Claude Code Action 実行制御](../operations/security.md#claude-code-action-実行制御)）**
   - `if: steps.pre.outputs.should_run == 'true'`
   - `claude_args` で `--model` / `--max-turns` / `--allowedTools`（`Read,Glob,Grep,Edit,Write,TodoWrite,Bash(<allowlist>)`）/ `--disallowedTools` を指定
   - `Bash` allowlist: `npm ci` / `npm run check` / `npm test` / `npm run build` / `git status` / `git diff` / `git log`。`git commit` / `git push` は **意図的に除外**（commit 権限は post-fix が単独で持つ）
   - 失敗時（`outcome=failure`）と timeout 時（`outcome=cancelled`）は post-fix 側で stop reason に変換する
3. **post-fix（`loop/post-fix`、Node JS action）**
   - `if: always() && steps.pre.outputs.should_run == 'true'`（claude-code-action 失敗時もスコープ検査と state 更新を走らせる）
   - claude-code-action の `outcome` を判定: `success` 以外なら `git reset --hard HEAD` で working tree を巻き戻し、`stopped` (`action_failure` / `action_timeout` / `max_turns_exceeded`) で終了
   - `git diff --numstat HEAD` → [`parseGitNumstat`](../../src/scope-checker.ts) → [`checkScope`](../../src/scope-checker.ts) で **20 files / 1000 lines / default block-list (`.github/`, `dist/`, `package.json`, root dotfiles 等)** を確認。block にマッチしないパスはすべて許可される（allow-list は持たず block-list 方式）。違反時は revert + `stopped(scope_violation)`。block-list の運用は [scope-policy.md](../operations/scope-policy.md) を参照
   - `CHECK_COMMAND` を実行。失敗時は revert + `stopped(test_failure)` + 失敗末尾を `state.previousCheckFailure` に保存（次 iteration の prompt の追加コンテキストになる）
   - 成功時は変更ファイルを `git add ...` → `commit` → `push`（コミットメッセージ: `fix: auto-resolve Codex review findings (iteration {N})`）。`previousCheckFailure` を `null` にリセットして clean run の状態を保持

**Phase 4: 再レビュー依頼**
- post-fix が `@codex review` を投稿する。`CODEX_REVIEW_REQUEST_TOKEN` が設定されている場合は接続済みユーザー PAT を使い、未設定時は `GITHUB_TOKEN` に fallback する
- `status: waiting_codex` に更新

**運用方針:**

| 項目 | 方針 | 理由 |
| -- | -- | -- |
| Trigger | `pull_request_review.submitted` と `issue_comment.created` を **両ルート正式対応** | `/restart-review` (issue_comment 専用) と Codex usage-limit notice (両ルート対応) の依存があり、`pull_request_review` だけに絞ると機能が落ちる。同一 `if:` ガード経由で集約済み |
| Debounce 値 | デフォルト `DEBOUNCE_SECONDS=90` 据え置き。`vars.DEBOUNCE_SECONDS` で 0 への短縮を **variable opt-in** として許容するが、運用時は安定実績のある 90 を推奨 | 20 iteration × 90s ≈ $0.24 / PR で課金影響は限定的。`STABILIZE_INTERVAL_SECONDS=10` × `STABILIZE_COUNT=3` の安全網と二重化することで Codex 挙動変化への耐性を維持 |
| Debounce 方式 | GitHub Actions runner 上の `sleep` を継続採用 | `--max-turns 40` と `timeout-minutes: 30` でコスト天井が明示済み。event-driven / 外部 scheduler は Codex 挙動依存リスクが高く、現時点でコスト削減効果も小さい |
| Concurrency | job-level（再利用ワークフロー `loop.yml` の `auto-fix` job 直下）`concurrency: pr-{N}-auto-fix` + `cancel-in-progress: false` (PR scoped queue) を継続 | `fixing` 窓は composite 1 invocation 内に閉じる現設計 (`flow-and-state.md` §4) と整合。`cancel-in-progress: true` だと `fixing` 状態が hung するリスクがある。GitHub Actions の queue 深さ 1 制約 (3 件目以降の中間 run は置換される) は `findings_hash_history` + `last_processed_review_id` による ETL-style 集約で許容範囲 |

---

## 重複処理防止

### 防ぐべき問題
- 同じ Codex review を複数回処理してしまう
- インラインコメントごとに Claude が多重起動する
- Claude 自身の push / comment で再帰起動する

### 対策

#### 1. review id で冪等化
- `last_processed_review_id` を保存
- 同じ review は再処理しない

#### 2. concurrency 制御
Workflow A/B とも PR ごとに同時実行を防ぐ。

Workflow A:

```yaml
jobs:
  init:
    concurrency:
      group: looppilot-init-${{ github.repository }}-${{ github.event.pull_request.number }}
      cancel-in-progress: false
```

Workflow B（再利用ワークフロー `loop.yml` の `auto-fix` job 直下に置く。job-level なので無関係な `issue_comment` で gate skip された場合は queue を占有しない）:

```yaml
jobs:
  auto-fix:
    concurrency:
      group: pr-${{ github.event.issue.number || github.event.pull_request.number }}-auto-fix
      cancel-in-progress: false
```

> **注意:** GitHub Actions の concurrency キューは **最大1つまで** しか待機できない。3つ目以降の workflow 実行が発生すると、待機中の実行がキャンセルされ最新の実行に置き換わる。短時間に Codex が複数回 review した場合、中間の review が未処理のまま残る可能性がある。ただし、`last_processed_review_id` による冪等化と、次回 iteration で最新の review comments を再取得する設計により、実質的な影響は軽微。この動作が許容できないリポジトリでは、外部キュー（SQS 等）の導入を検討する。

#### 3. actor フィルタ
- **`chatgpt-codex-connector[bot]`** のコメントのみ対象
- Claude bot（GitHub Actions bot）のコメントや push では起動しない
- 判定: `github.event.comment.user.login` または `github.event.review.user.login` が `chatgpt-codex-connector[bot]`、または非空の `vars.CODEX_BOT_LOGIN` と一致
- trigger body に `contains(..., 'Codex Review')` または、非空の `vars.CODEX_REVIEW_MARKER` を含むことを確認

#### 4. workflow の責務分離
- **Workflow A:** PR 初期化 + 初回 `@codex review`
- **Workflow B:** Codex レビュー受信 + Claude 修正 + 再レビュー依頼

の2本に分けることで、再帰や誤起動を防ぐ

#### 5. デバウンス待機
- review 受信後すぐには Claude を起動しない
- 一定時間待ってから review 一式を取得する
- コメントの到着タイミング差を吸収する

---

## 関連ドキュメント

- [システム概要](system-overview.md) — 基本方針・パラメータ
- [推奨フローと状態管理](flow-and-state.md) — ステップ詳細・状態遷移
- [セキュリティ](../operations/security.md) — トークンスコープ・push 権限
- [全ドキュメント索引](../README.md)
