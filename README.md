# LoopPilot

> AI review-fix loop for GitHub pull requests — Codex レビュー × Claude 自動修正のループを GitHub Actions として実行する。

LoopPilot は、PR が開かれると Codex (`chatgpt-codex-connector[bot]`) にコードレビューを依頼し、Codex が返した P0–P3 の findings を [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) が自動修正する GitHub Actions です。修正のたびに `CHECK_COMMAND` (デフォルト `npm run check`) を実行し、scope policy・hard-block・size budget・secret scanner を満たさない修正は revert します。findings がなくなれば `done`、解消できない・iteration 上限に達した場合は `stopped` で停止し、いずれも PR 上のステータスコメントと通知で可視化されます。

設計の詳細は [`docs/README.md`](docs/README.md) を参照してください。

## 仕組み

1. **Workflow A (init)** — PR が開かれ、ゲートを満たすと LoopPilot が初期化され、初回の `@codex review` を投稿する。
2. **Codex** がコードレビューを実施し、総評コメントと inline コメントを返す。
3. **Workflow B (loop)** — Codex のレビューを検知し、`claude-code-action` が findings を修正 → `CHECK_COMMAND` → scope / secret チェック → commit / push → 再度 `@codex review`。
4. findings がなくなるまで 2–3 を繰り返し、`done` で終了（任意で auto-merge）。上限到達・修正不能・スコープ違反などでは `stopped` で停止する。

fork PR は両 workflow のセキュリティガードで無効化されます（自リポジトリ PR のみ対象）。

## 前提条件

- GitHub Actions が有効なリポジトリで、**同一リポジトリ PR への commit / push が許可**されていること。
- 対象リポジトリに **ChatGPT Codex の GitHub 連携 (Codex GitHub App)** が導入され、`@codex review` でレビューが起動すること。
- **Anthropic API キー** または **Claude Code サブスクリプションの OAuth トークン**（いずれか一方）。
- `CHECK_COMMAND` を実行できるツールチェイン。デフォルトは Node.js / npm。pytest・make 等を使う場合は Workflow B のセットアップ手順（`setup-node` / `npm ci`）を各ツールチェインに合わせて差し替えること。
- 必要なトークンと権限は [トークンと必要権限](#トークンと必要権限-fine-grained-pat) を参照。

## クイックスタート

利用側リポジトリで以下を実施します。

1. **ゲートラベルの作成**（または full-auto 設定）— 下記参照。
2. **Secrets / Variables の登録**（[トークンと必要権限](#トークンと必要権限-fine-grained-pat) / [設定 (Repository variables)](#設定-repository-variables)）。
3. 2 つの workflow を `.github/workflows/` に追加。

### 1. ゲートラベルの作成（または full-auto）

デフォルトでは `loop-pilot` ラベルが付いた PR のみが LoopPilot 対象です。利用側リポジトリで **以下のいずれかを先に実施** しないと、workflow を貼っても `if:` 条件が `false` になり Actions タブに run が生成されません。

**選択 A: ラベルを作成する（推奨、PR 単位で制御できる）**

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run LoopPilot on this PR"
```

PR にこのラベルを付けると Workflow A / B が起動します。ラベルが付かない PR では何も起きません（workflow run も生成されません）。

**選択 B: 全 PR で有効化する（full-auto）**

Repository variable `LOOPPILOT_FULL_AUTO=true` を設定すると、すべての非 fork PR で LoopPilot が起動します。

ラベルゲートの詳細仕様は [`docs/architecture/event-design.md`](docs/architecture/event-design.md) を参照。

### 2. Workflow A — PR を開いた時に初期化

```yaml
# .github/workflows/looppilot-init.yml
name: LoopPilot Init

on:
  pull_request:
    types: [opened, ready_for_review, labeled]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  init:
    concurrency:
      group: looppilot-init-${{ github.repository }}-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    # Default-strict label gate with a full-auto opt-out:
    #   - vars.LOOPPILOT_FULL_AUTO == 'true' → gate disabled; every non-fork ready
    #     PR triggers init. `labeled` events are ignored so adding any label does
    #     NOT reset state and re-post `@codex review`.
    #   - otherwise (default) → the PR must carry the gate label
    #     (vars.LOOPPILOT_LABEL || 'loop-pilot'). On `labeled` events the added
    #     label itself must match the gate label.
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
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v5

      - name: Check fork PR (security guard)
        if: github.event.pull_request.head.repo.full_name != github.repository
        run: |
          echo "::error::Fork PR detected. LoopPilot is disabled for fork PRs."
          exit 1

      - name: Run init
        uses: team-yubune/loop-pilot/init@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          # Show the operator-configured cap in the initial status comment.
          # Use the same expression as looppilot-loop.yml so both agree.
          max-review-iterations: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}
          # Trusted state-comment author override; empty falls back to github-actions[bot].
          looppilot-state-comment-authors: ${{ vars.LOOPPILOT_STATE_COMMENT_AUTHORS }}

      # Fail-safe: Workflow A has no in-process crash hook, so any failure here
      # (checkout, fork rejection, or a Node crash in `Run init`) would otherwise
      # leave the PR silent — no state, no `@codex review`, no notification.
      # `cancelled()` is required alongside `failure()` because a job timeout or a
      # manual cancel ends steps as `cancelled`, which a bare `if: failure()`
      # would skip. State is intentionally NOT mutated here: pre-fix reconciles an
      # incomplete init on the next valid trigger.
      - name: Post init failure notification
        if: failure() || cancelled()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          BODY=$'⚠️ **LoopPilot init failed.**\n\nThe init workflow that prepares LoopPilot state and posts the initial `@codex review` failed before completing. LoopPilot may not be active on this PR until init runs successfully. Re-run this workflow from the Actions tab, or re-trigger init by removing and re-adding the gate label (or closing/reopening the PR in full-auto mode).\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post init failure notification via gh api; check GITHUB_TOKEN scope."
```

### 3. Workflow B — Codex のレビューを受けて修正ループ

```yaml
# .github/workflows/looppilot-loop.yml
name: LoopPilot Loop

on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

concurrency:
  group: pr-${{ github.event.issue.number || github.event.pull_request.number }}-auto-fix
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: write
  # actions: read is required only when LOOPPILOT_AUTO_MERGE=true: mergeIfChecksPass
  # reads /repos/.../actions/runs?head_sha=... to verify every other workflow run on
  # HEAD finished green before squash-merging. Without it the API returns 403 and
  # auto-merge always skips. Safe to drop if you never enable auto-merge.
  actions: read

jobs:
  auto-fix:
    # Two entry conditions:
    #  (a) /restart-review by a trusted commenter (OWNER/MEMBER/COLLABORATOR, or the
    #      PR author) — bypasses the label gate so a stopped/completed loop can be
    #      recovered even after the gate label was removed. The fork guard and the
    #      runtime permission check still apply.
    #  (b) A Codex review/comment on a gated PR — full-auto OR the gate label present,
    #      from the Codex bot, carrying the review marker (or a usage-limit notice).
    # issue_comment exposes labels under github.event.issue.labels;
    # pull_request_review under github.event.pull_request.labels.
    if: >
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        (
          github.event.comment.body == '/restart-review' ||
          startsWith(github.event.comment.body, '/restart-review ')
        ) &&
        (
          github.event.comment.author_association == 'OWNER' ||
          github.event.comment.author_association == 'MEMBER' ||
          github.event.comment.author_association == 'COLLABORATOR' ||
          github.event.comment.user.login == github.event.issue.user.login
        )
      ) ||
      (
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
              (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER)) ||
              contains(github.event.comment.body, 'Codex usage limit') ||
              contains(github.event.comment.body, 'Codex quota')
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
              (vars.CODEX_REVIEW_MARKER != '' && contains(github.event.review.body, vars.CODEX_REVIEW_MARKER)) ||
              contains(github.event.review.body, 'Codex usage limit') ||
              contains(github.event.review.body, 'Codex quota')
            )
          )
        )
      )
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Get PR info
        id: pr
        run: |
          PR_DATA=$(gh api "/repos/${REPO}/pulls/${PR_NUM}")

          DELIM="EOF_$(openssl rand -hex 8)"

          echo "head_ref<<$DELIM" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.head.ref' >> "$GITHUB_OUTPUT"
          echo "$DELIM" >> "$GITHUB_OUTPUT"

          echo "head_sha<<$DELIM" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.head.sha' >> "$GITHUB_OUTPUT"
          echo "$DELIM" >> "$GITHUB_OUTPUT"

          echo "title<<$DELIM" >> "$GITHUB_OUTPUT"
          echo "$PR_DATA" | jq -r '.title' >> "$GITHUB_OUTPUT"
          echo "$DELIM" >> "$GITHUB_OUTPUT"

          # .head.repo can be null for deleted fork repos — default to empty
          FORK_NAME=$(echo "$PR_DATA" | jq -r '.head.repo.full_name // empty')
          echo "fork<<$DELIM" >> "$GITHUB_OUTPUT"
          echo "$FORK_NAME" >> "$GITHUB_OUTPUT"
          echo "$DELIM" >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}

      - name: Check fork PR (security guard)
        if: steps.pr.outputs.fork == '' || steps.pr.outputs.fork != github.repository
        run: |
          echo "::error::Fork PR detected or source repo unknown. LoopPilot is disabled for fork PRs."
          exit 1

      - uses: actions/checkout@v5
        with:
          ref: ${{ steps.pr.outputs.head_ref }}
          fetch-depth: 1

      # Node toolchain for the default CHECK_COMMAND. If your CHECK_COMMAND uses a
      # different toolchain (pytest / make / cargo / …), replace this and the
      # dependency-install step below accordingly.
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: ${{ hashFiles('package-lock.json', 'npm-shrinkwrap.json') != '' && 'npm' || '' }}

      - name: Configure git user for commit
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Install dependencies for check command
        if: hashFiles('package-lock.json', 'npm-shrinkwrap.json') != ''
        run: npm ci

      - name: Run auto-fix loop
        id: loop
        uses: team-yubune/loop-pilot/loop@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          looppilot-push-token: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
          # Pass both auth secrets through. Pre-fix fails fast unless exactly one is
          # non-empty, so set ANTHROPIC_API_KEY (API billing) OR
          # CLAUDE_CODE_OAUTH_TOKEN (Pro / Max subscription) — never both.
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          pr-number: ${{ github.event.issue.number || github.event.pull_request.number }}
          pr-head-ref: ${{ steps.pr.outputs.head_ref }}
          pr-title: ${{ steps.pr.outputs.title }}
          trigger-comment-id: ${{ github.event.comment.id || github.event.review.id }}
          trigger-comment-body: ${{ github.event.comment.body || github.event.review.body }}
          trigger-user-login: ${{ github.event.comment.user.login || github.event.review.user.login }}
          # Lets pre-fix disambiguate issue_comment.id vs pull_request_review.id when
          # deduplicating against the last processed review (separate ID namespaces).
          trigger-event-name: ${{ github.event_name }}
          max-review-iterations: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}
          debounce-seconds: ${{ vars.DEBOUNCE_SECONDS || '90' }}
          check-command: ${{ vars.CHECK_COMMAND || 'npm run check' }}
          build-command: ${{ vars.BUILD_COMMAND || '' }}
          codex-bot-login: ${{ vars.CODEX_BOT_LOGIN || 'chatgpt-codex-connector[bot]' }}
          codex-review-marker: ${{ vars.CODEX_REVIEW_MARKER || 'Codex Review' }}
          stabilize-interval-seconds: ${{ vars.STABILIZE_INTERVAL_SECONDS || '10' }}
          stabilize-count: ${{ vars.STABILIZE_COUNT || '3' }}
          looppilot-label: ${{ vars.LOOPPILOT_LABEL || '' }}
          looppilot-full-auto: ${{ vars.LOOPPILOT_FULL_AUTO || 'false' }}
          looppilot-restart-roles: ${{ vars.LOOPPILOT_RESTART_ROLES || 'author,write,maintain,admin' }}
          # Model tiering: set BASE === ESCALATED to operate without tiering.
          claude-code-model-base: ${{ vars.CLAUDE_CODE_MODEL_BASE || 'claude-sonnet-4-6' }}
          claude-code-model-escalated: ${{ vars.CLAUDE_CODE_MODEL_ESCALATED || 'claude-opus-4-7' }}
          claude-code-max-turns: ${{ vars.CLAUDE_CODE_MAX_TURNS || '40' }}
          auto-merge-on-clean: ${{ vars.LOOPPILOT_AUTO_MERGE || 'false' }}
          auto-merge-poll-seconds: ${{ vars.LOOPPILOT_AUTO_MERGE_POLL_SECONDS || '15' }}
          auto-merge-timeout-minutes: ${{ vars.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES || '10' }}
          severity-threshold: ${{ vars.LOOPPILOT_SEVERITY_THRESHOLD || 'P3' }}
          # Trusted state-comment author override; empty falls back to github-actions[bot].
          looppilot-state-comment-authors: ${{ vars.LOOPPILOT_STATE_COMMENT_AUTHORS }}

      # Fail-safe (loop crashed): if the composite ./loop action ends in failure or
      # cancelled, the in-process stop notification may never have posted (token
      # revoked, API outage, Node killed, job timeout). Post a top-level 🛑 comment
      # so the operator knows the loop stopped. Keying on steps.loop.conclusion (not
      # failure()) avoids a misleading "crashed" comment when an EARLIER step failed
      # and the loop was skipped. always() is required to run after a failed step.
      # Dedup: skip if an in-process 🛑 stop notification already posted within 90s.
      - name: Post crash notification on workflow failure
        if: >
          always() &&
          (steps.loop.conclusion == 'failure' ||
           steps.loop.conclusion == 'cancelled')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          LOOP_CONCLUSION: ${{ steps.loop.conclusion }}
        run: |
          set -euo pipefail
          SINCE=$(date -u -d '90 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
          # --paginate walks the full since= window (issue comments are served oldest
          # first); emit one .id per match and count lines so the numeric test below
          # works across pages.
          RECENT_STOP=$(gh api --paginate \
            "repos/${REPO}/issues/${PR_NUM}/comments?since=${SINCE}" \
            --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("🛑 **LoopPilot stopped**"))) | .id' \
            2>/dev/null | grep -c . || true)
          if [ "${RECENT_STOP:-0}" -gt 0 ]; then
            echo "::notice::A top-level stop notification already posted within 90s (${RECENT_STOP} found); skipping fail-safe to avoid a duplicate."
            exit 0
          fi
          BODY=$'🛑 **LoopPilot crashed** — the auto-fix loop step ended with conclusion `'"$LOOP_CONCLUSION"$'` before the in-process stop notification could post.\n\nThe hidden state may still be `fixing`; the next `/restart-review` (or the next pre-fix run on this PR) will demote it to `stopped / workflow_crashed`. Use `/restart-review` to resume — add `--hard` if iteration history needs clearing.\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post crash notification comment via gh api; check GITHUB_TOKEN scope."

      # Fail-safe (early-step failure): complements the crash notification above. If
      # an EARLIER step failed (Get PR info, fork guard, checkout, setup-node, npm
      # ci), the loop step is skipped and produces no notification. This fires on the
      # exact complement (failure/cancelled AND loop skipped). State is not mutated;
      # the next valid Codex review retries the loop.
      - name: Post early-step failure notification
        if: >
          always() &&
          (failure() || cancelled()) &&
          steps.loop.conclusion == 'skipped'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.issue.number || github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          BODY=$'⚠️ **LoopPilot Workflow B failed before the auto-fix loop could start.**\n\nThe failure happened in an early setup step (e.g. `actions/checkout`, `actions/setup-node`, `npm ci`, or the PR info / fork guard step). The looppilot-state was not modified — the next valid Codex review will retry the loop.\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post early-step failure notification via gh api; check GITHUB_TOKEN scope."
```

> 本リポジトリ自身も `.github/workflows/looppilot-{init,loop}.yml` で LoopPilot を dogfooding しています。上記サンプルはそれらと同等で、外部利用向けに `uses:` をローカル参照 (`./init` / `./loop`) からリリースタグ参照 (`team-yubune/loop-pilot/init@v1` / `loop@v1`) に置き換えたものです。`@v1` は安定版のリリースタグを指します。最新を追う場合は `@main` も使えますが、破壊的変更を受ける可能性があります。本番では `@v1` などのタグか commit SHA への固定を推奨します。

## トークンと必要権限 (Fine-grained PAT)

LoopPilot は 3 種類の GitHub トークンと 1 種類の Anthropic 認証情報を使います。GitHub トークンは用途ごとに分離されており、それぞれに **必要な権限だけ** を与えてください。

- すべての PAT は **対象リポジトリ 1 つだけにスコープを限定**する（org 全体への付与は避ける）。
- Fine-grained PAT では `Metadata: Read-only` が自動付与される（必須）ため、以下の表では省略する。
- トークンは必ず GitHub Actions の **Repository secrets** に保存する（ログには自動でマスクされる）。

### 1. `GITHUB_TOKEN`（Actions ビルトイン / PAT ではない）

Actions が自動生成するトークン。PAT ではなく、workflow の `permissions:` ブロックで権限を絞ります。

| Workflow | permissions |
|---|---|
| Workflow A (`looppilot-init.yml`) | `contents: read`, `pull-requests: write`, `issues: write` |
| Workflow B (`looppilot-loop.yml`) | `contents: write`, `pull-requests: write`, `issues: write`, `actions: read` |

- **`issues: write` / `pull-requests: write`** — hidden state comment / status comment / 各種通知の読み書き、PR メタデータ・inline review comment・ラベルの読み取り、auto-merge の実行。
- **`contents: write`**（Workflow B のみ）— `LOOPPILOT_PUSH_TOKEN` 未設定時に repair commit を `GITHUB_TOKEN` で push するためのフォールバック。Workflow A は checkout のみで push しないため `contents: read`。
- **`actions: read`**（Workflow B のみ）— `LOOPPILOT_AUTO_MERGE=true` のときだけ必須。auto-merge 前に HEAD の他 CI run が green かを `/actions/runs` で確認する。未付与だと API が 403 を返し auto-merge が常に skip される。auto-merge を使わないなら省略可。

### 2. `CODEX_REVIEW_REQUEST_TOKEN`（Fine-grained PAT・任意 / 本番推奨）

`@codex review` コメントを **Codex と連携済みのユーザー** として投稿し、Codex のレビューを起動・再起動するためのトークン。未設定時は `GITHUB_TOKEN`（= `github-actions[bot]`）にフォールバックしますが、bot 投稿では Codex が確実に起動しないため、連携ユーザーの PAT を推奨します。

**発行元:** ChatGPT Codex を GitHub に連携済みのユーザー（本番では専用 machine user または GitHub App への置き換えを推奨）。

**Fine-grained PAT — Repository permissions:**

| Permission | Level | 要否 | 用途 |
|---|---|---|---|
| Pull requests | Read and write | **必須** | PR 会話に `@codex review` を投稿（`POST /repos/{owner}/{repo}/issues/{pr}/comments`。PR 番号宛のコメントは fine-grained PAT では Pull requests 権限で認可される） |
| Issues | Read and write | 推奨 | issue/PR 共通のコメント endpoint に対する保険 |

push・checkout・state comment 読み書き・findings 取得には**使いません**（それらは `GITHUB_TOKEN`）。詳細は [`docs/operations/security.md`](docs/operations/security.md#codex-review-request-token)。

### 3. `LOOPPILOT_PUSH_TOKEN`（Fine-grained PAT または GitHub App トークン・任意 / 本番では実質必須）

repair commit の `git push` 専用トークン。**`GITHUB_TOKEN` で push した commit には GitHub が `pull_request: synchronize` を発火させない**仕様のため、未設定だと auto-fix commit に対して required CI checks が再実行されず、`dist/` drift や typecheck 退行が merge 後の main で初めて露呈する経路を残します。以下に該当する場合は設定を強く推奨します。

- branch protection で **required CI checks** を強制している
- `LOOPPILOT_AUTO_MERGE=true` で auto-fix → 自動 merge を回す
- committed build artifacts / generated code / lockfile など **CI でしか検知できない drift** を含む

**発行元:** 対象リポジトリにスコープした machine user の Fine-grained PAT、または GitHub App installation token。`GITHUB_TOKEN` 以外の actor であることが required check 再実行の条件です。

**Fine-grained PAT — Repository permissions:**

| Permission | Level | 要否 | 用途 |
|---|---|---|---|
| Contents | Read and write | **必須** | PR head branch へ repair commit を push |

`.github/` は scope check で hard-block されており repair commit が workflow ファイルに触れないため、**`Workflows` 権限は不要**です。`@codex review` 投稿・コメント・claude-code-action 入力には**使いません**。詳細は [`docs/operations/security.md`](docs/operations/security.md#looppilot-push-token)。

### 4. `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`（いずれか一方）

`claude-code-action` の認証情報。GitHub トークンではありません。**ちょうど一方だけ** を設定してください（両方／どちらも未設定なら pre-fix が起動時に fail fast します）。

| Secret | 用途 | 課金 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 直接呼び出し | Anthropic API 従量課金 |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code サブスク (Pro / Max)。`claude setup-token` で発行 | サブスク使用量を消費 |

両方セット時の fail fast は「サブスクへ切替えたつもりで API キー削除を忘れ課金が続く」事故を防ぐためです。詳細は [`docs/operations/security.md`](docs/operations/security.md)（認証 / サブスク利用時の注意）。

### Secrets サマリ

| Secret | 要否 | 概要 |
|---|---|---|
| `GITHUB_TOKEN` | 自動 | Actions が自動提供。`permissions:` で権限を絞る |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | いずれか一方が必須 | claude-code-action の認証 |
| `CODEX_REVIEW_REQUEST_TOKEN` | 任意（推奨） | `@codex review` を連携ユーザーとして投稿 |
| `LOOPPILOT_PUSH_TOKEN` | 任意（本番実質必須） | repair commit push 用。required checks 再実行に必要 |

## 設定 (Repository variables)

すべて任意で、未設定ならデフォルトで安全に動きます。よく使うものを抜粋します（全 input は [`loop/action.yml`](loop/action.yml) / [`init/action.yml`](init/action.yml) を参照）。

| Variable | デフォルト | 説明 |
|---|---|---|
| `LOOPPILOT_LABEL` | `loop-pilot` | このラベルを持つ PR のみ対象（default-strict）。**ラベルを repo に作成し PR に付ける必要がある**（未作成だと run が生成されない） |
| `LOOPPILOT_FULL_AUTO` | `false` | `true` でラベルゲートを無効化（全非 fork PR で起動） |
| `MAX_REVIEW_ITERATIONS` | `20` | 1 PR あたりの最大修正回数 |
| `CHECK_COMMAND` | `npm run check` | 修正後に走らせる検証コマンド（allowlist で検証。shell メタ文字・未許可バイナリは fail fast） |
| `BUILD_COMMAND` | （空 = skip） | `CHECK_COMMAND` 通過後・staging 前に走る任意ビルド。`dist/` 等の生成物が `src/` と drift しないようにする。複数ステップは npm script / Makefile に集約 |
| `LOOPPILOT_SEVERITY_THRESHOLD` | `P3` | これ未満の severity を無視。`P3` は P0–P3 すべて対象、`P2` で P3 を skip など |
| `LOOPPILOT_AUTO_MERGE` | `false` | `done / no_findings` 到達時に自動 squash merge。**repo Settings → General → "Allow auto-merge" の有効化が前提**。CI 失敗・HEAD 変化・timeout 等の skip 時は PR コメントで理由を通知 |
| `LOOPPILOT_BLOCK_PATHS` | （空） | `.gitignore` 風の block-path spec。`secrets/`（dir）、`Justfile`（file）、`!Makefile`（default 解除）。`!.github/...` は無視（`.github/` は locked） |
| `CLAUDE_CODE_MODEL_BASE` | `claude-sonnet-4-6` | base tier モデル。escalation 条件が立たない iteration で使用 |
| `CLAUDE_CODE_MODEL_ESCALATED` | `claude-opus-4-7` | escalated tier。P0 finding・直前 CHECK 失敗・同一 findings 再発で使用。`BASE` と同値にすると tiering 無効 |
| `CODEX_BOT_LOGIN` | `chatgpt-codex-connector[bot]` | Codex bot のログイン名（連携先が変わった場合の上書き用） |
| `CODEX_REVIEW_MARKER` | `Codex Review` | Codex 総評コメントの判定マーカー |
| `LOOPPILOT_RESTART_ROLES` | `author,write,maintain,admin` | `/restart-review` を許可するロール |
| `LOOPPILOT_STATE_COMMENT_AUTHORS` | （空 = `github-actions[bot]`） | hidden state comment の信頼 author。GitHub App / machine user で書く場合に設定 |

> auto-merge を使う場合は、リポジトリ Settings → General → Pull Requests → **"Allow auto-merge" を有効化**してください。無効のままだと `gh pr merge --auto` が即 fail し、`⏸️ Auto-merge skipped` の PR コメントで理由が通知されます。

## ドキュメント

- [`docs/README.md`](docs/README.md) — 全体目次
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — 設計概要
- [`docs/architecture/flow-and-state.md`](docs/architecture/flow-and-state.md) — フロー / state 管理
- [`docs/operations/security.md`](docs/operations/security.md) — secrets / トークン権限 / scope check / 認証
- [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) — 停止条件と `/restart-review`
- [`docs/operations/scope-policy.md`](docs/operations/scope-policy.md) — 変更スコープ検査と `LOOPPILOT_BLOCK_PATHS`

## 開発

```bash
npm ci
npm run check     # tsc --noEmit + tests/ typecheck + vitest run
npm run bundle    # dist/ を再生成
```

PR を開くと CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) が typecheck / test / dist drift をチェックします。`src/` を変更したら `npm run bundle` で `dist/` を再生成してコミットしてください（公開 action は `dist/` を実行するため）。

## ライセンス

[MIT](LICENSE)
