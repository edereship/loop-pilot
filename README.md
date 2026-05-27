# LoopPilot

> AI review-fix loop for GitHub pull requests — Codex レビュー × Claude 自動修正のループを GitHub Actions として実行する。

PR が開かれたら Codex (`chatgpt-codex-connector[bot]`) にコードレビューを依頼し、P0/P1/P2 の findings を [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) が自動修正する。修正のたびに `CHECK_COMMAND` (デフォルト `npm run check`) を回し、scope policy・hard-block・size budget を満たさない repair は revert する。findings がなくなれば `done`、解消できない・iteration 上限に達した場合は `stopped` で停止する。

設計の詳細は [`docs/README.md`](docs/README.md) を参照。

## クイックスタート

利用側リポジトリで以下の 2 つの workflow を貼る。トークン / variable は repo の Settings に登録する。

下記サンプルは `.github/workflows/looppilot-{init,loop}.yml` の本体と逐字一致する（PoC 用 artifact upload step のみ省略）。コピペでそのまま動かすことを前提に、fork PR ガード / PR head ref チェックアウト / `actions: read` 権限 / `npm ci` / git user 設定 / 主要 vars 受け渡しをすべて含む (TY-290 #1)。

### 前提: gate label の作成 (または full-auto 設定)

デフォルトでは `loop-pilot` ラベルが付いた PR のみが LoopPilot 対象になる。利用側リポジトリで **以下のいずれかを先に実施** しないと、workflow を貼っても `if:` 条件が `false` になり Actions タブに run が生成されない (TY-293 #2)。

**選択 A: ラベルを作成する (推奨、PR 単位で LoopPilot を制御できる)**

```bash
gh label create loop-pilot \
  --color BFD4F2 \
  --description "Run loop-pilot on this PR"
```

PR にこのラベルを付ければ Workflow A / B が起動する。ラベルが付かない PR は何も起きない (workflow run も生成されない)。

**選択 B: 全 PR で LoopPilot を有効化する (full-auto)**

Repository variable `LOOPPILOT_FULL_AUTO=true` を設定する。すべての非 fork PR で LoopPilot が起動する。

ラベルゲートの詳細仕様は [`docs/architecture/event-design.md`](docs/architecture/event-design.md) を参照。

### Workflow A — PR を開いた時に初期化

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
    # Default-strict label gate with full-auto opt-out:
    #   - vars.LOOPPILOT_FULL_AUTO == 'true' → gate disabled, every non-fork ready PR
    #     triggers init. `labeled` events are ignored so adding any label does NOT reset
    #     state and re-post `@codex review`.
    #   - otherwise (default) → PR must carry the gate label
    #     `vars.LOOPPILOT_LABEL || 'loop-pilot'`. For `labeled` events, the added
    #     label itself must match the gate label (adding an unrelated label is a no-op).
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
        uses: team-yubune/loop-pilot/init@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          # Pass the same cap used by Workflow B so the initial status comment
          # shows the correct "Iterations: 0 / N" bound from the start.
          max-review-iterations: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}
          # TY-272 #A: trusted state-comment author override; empty falls
          # back to `github-actions[bot]`.
          looppilot-state-comment-authors: ${{ vars.LOOPPILOT_STATE_COMMENT_AUTHORS }}

      # TY-283: Workflow A fail-safe (symmetric with the Workflow B fail-safe
      # set in `looppilot-loop.yml`). Workflow A has only three steps —
      # `checkout`, `Check fork PR`, `Run init` — and the Node `Run init` step
      # has no crash-recovery hook (`main-init.ts` calls
      # `runIfNotVitest(run)` without an `onError` argument, unlike pre-fix /
      # post-fix). Any failure here — early-step (checkout failure, fork
      # rejection) OR a `Run init` Node crash — would otherwise leave the PR
      # completely silent: no hidden state, no `@codex review`, no notification.
      # Operators only notice when they wonder "why didn't LoopPilot fire?"
      #
      # Init's state mutations are simpler than the auto-fix loop, so the
      # complement-style partition that looppilot-loop.yml uses
      # (`failure`/`cancelled` vs `skipped`) is unnecessary — a single
      # `failure()` guard covers every failure mode. We deliberately do NOT
      # mutate `looppilot-state` here: a successful `createStateComment`
      # leaves status `initialized`, which pre-fix already detects and
      # surfaces via `postInitIncompleteComment` on the next valid trigger.
      # If the failure was before `createStateComment` even ran, there is no
      # state to touch.
      - name: Post init failure notification
        # `cancelled()` is required in addition to `failure()` because a job
        # timeout (timeout-minutes: 5) or a manual workflow cancel does NOT
        # raise `failure()` — the steps end with conclusion `cancelled` and a
        # bare `if: failure()` would silently skip the fail-safe.
        if: failure() || cancelled()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUM: ${{ github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          BODY=$'⚠️ **LoopPilot init failed.**\n\nThe init workflow that prepares LoopPilot state and posts the initial `@codex review` failed before completing. LoopPilot may not be active on this PR until init runs successfully. Re-run this workflow from the Actions tab, or re-trigger init by removing and re-adding the gate label (or closing/reopening the PR in full-auto mode) (TY-283).\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post init failure notification via gh api; check GITHUB_TOKEN scope."
```

### Workflow B — Codex のレビューを受けて修正ループ

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
  # actions: read is required by the LOOPPILOT_AUTO_MERGE guard (TY-277):
  # `mergeIfChecksPass` reads `/repos/.../actions/runs?head_sha=...` to
  # verify every other workflow run on HEAD finished green before calling
  # `gh pr merge --squash`. Without this scope the API returns 403 and
  # auto-merge would always skip with a warning even on clean CI.
  actions: read

jobs:
  auto-fix:
    # Default-strict label gate with full-auto opt-out (fast skip; runtime re-check
    # is performed inside loop main):
    #   - vars.LOOPPILOT_FULL_AUTO == 'true' → gate disabled, every non-fork PR proceeds
    #   - otherwise (default) → PR must carry the gate label
    #     `vars.LOOPPILOT_LABEL || 'loop-pilot'`.
    #     `issue_comment.created` exposes labels under github.event.issue.labels;
    #     `pull_request_review.submitted` under github.event.pull_request.labels.
    #
    # Recovery commands (`/restart-review`) bypass the label
    # gate so operators can recover a stopped loop or restart a completed loop
    # even after the gate label has been removed. The
    # fork guard inside steps and the runtime permission check in
    # handleRestartCommand still apply.
    #
    # TY-272 #C: gate the restart trigger on `author_association` so a public-PR
    # commenter cannot spin up Workflow B runs (and burn Actions minutes /
    # concurrency slots) before the inner permission check rejects them.
    # `OWNER` / `MEMBER` / `COLLABORATOR` are the GitHub-asserted trusted
    # associations; any drive-by commenter falls outside this set and the
    # workflow simply won't start.
    #
    # PR 作者は `author_association` が `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR`
    # / `NONE` の場合でも、`looppilot-restart-roles` の default に `author`
    # が含まれている限り restart 権限を持つ (`canRestart` で許可される)。
    # その経路を残すため、author == commenter の場合は author_association
    # の枠を緩める。これにより外部コントリビューターの PR 作者が `/restart-review`
    # で復旧する経路が welcoming されたまま、関係ない第三者の連投だけが弾かれる。
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
        uses: team-yubune/loop-pilot/loop@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          codex-review-request-token: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}
          looppilot-push-token: ${{ secrets.LOOPPILOT_PUSH_TOKEN }}
          # TY-260: pass both auth secrets through. Pre-fix fails fast unless
          # exactly one is non-empty, so the deploying repo can pick API key
          # billing or a Pro / Max subscription OAuth token by setting only
          # the corresponding `secrets.*`.
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          pr-number: ${{ github.event.issue.number || github.event.pull_request.number }}
          pr-head-ref: ${{ steps.pr.outputs.head_ref }}
          pr-title: ${{ steps.pr.outputs.title }}
          trigger-comment-id: ${{ github.event.comment.id || github.event.review.id }}
          trigger-comment-body: ${{ github.event.comment.body || github.event.review.body }}
          trigger-user-login: ${{ github.event.comment.user.login || github.event.review.user.login }}
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
          # Model tiering (TY-241, simplified in TY-242).
          # Set BASE === ESCALATED to operate without tiering.
          claude-code-model-base: ${{ vars.CLAUDE_CODE_MODEL_BASE || 'claude-sonnet-4-6' }}
          claude-code-model-escalated: ${{ vars.CLAUDE_CODE_MODEL_ESCALATED || 'claude-opus-4-7' }}
          claude-code-max-turns: ${{ vars.CLAUDE_CODE_MAX_TURNS || '40' }}
          auto-merge-on-clean: ${{ vars.LOOPPILOT_AUTO_MERGE || 'false' }}
          auto-merge-poll-seconds: ${{ vars.LOOPPILOT_AUTO_MERGE_POLL_SECONDS || '15' }}
          auto-merge-timeout-minutes: ${{ vars.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES || '10' }}
          severity-threshold: ${{ vars.LOOPPILOT_SEVERITY_THRESHOLD || 'P3' }}
          # TY-272 #A: trusted state-comment author override. Empty falls
          # back to `github-actions[bot]`. Set the Repository variable when
          # state comments are authored by a GitHub App / machine user.
          looppilot-state-comment-authors: ${{ vars.LOOPPILOT_STATE_COMMENT_AUTHORS }}

      # TY-282 #2B: workflow-level fail-safe. If the composite `./loop` action
      # ends in `failure` or `cancelled` we cannot rely on `postStopComment`
      # firing from inside `demoteFixingOnCrash` (e.g. token revoked, GitHub
      # API outage, Node process killed before the catch handler runs, or a
      # job-level timeout that cancels the step). This step talks to the
      # GitHub API directly with the workflow's bundled `GITHUB_TOKEN` and
      # posts a top-level 🛑 comment so the operator at least *knows* the
      # loop stopped, even when every code-path inside the action has
      # already gone silent. The comment intentionally links the workflow
      # run rather than the (potentially stale) status comment.
      #
      # The guard intentionally inspects `steps.loop.conclusion` rather than
      # `failure()`:
      #   - `failure()` is true when *any* previous step failed, so an
      #     earlier guard (Get PR info, Check fork PR, npm ci) failing
      #     leaves `steps.loop.conclusion == 'skipped'` and would otherwise
      #     post a misleading "LoopPilot crashed" comment for events the
      #     loop never even saw.
      #   - GitHub Actions exposes cancellation via `cancelled()` separately
      #     from `failure()`. Keying on the conclusion captures both real
      #     loop crashes and job-timeout cancellations in a single check.
      # `always()` is required so this step still runs after a failed step;
      # without it, `if:` defaults to an implicit `success()` AND.
      #
      # Dedup with 2A (Codex review on PR #96): when `demoteFixingOnCrash`
      # successfully posts the in-process 🛑 stop notification, this step
      # would otherwise post a *second* 🛑 comment for the same crash. The
      # design intent of 2B is to backstop 2A when 2A *cannot* fire — so
      # before posting we check whether a recent in-process stop comment
      # exists from `github-actions[bot]`. If so, 2A handled it cleanly
      # and 2B has nothing to add. The window is short (90s) so unrelated
      # earlier stops on the same PR cannot accidentally suppress us, and
      # the dedup check falls open (treats the API as if no recent stop
      # exists) on any failure so 2B's safety-net property is preserved.
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
          # Dedup window: look for any `🛑 **LoopPilot stopped**` body
          # authored by github-actions[bot] in the last 90s. That string
          # is the literal prefix `buildTerminalNotificationBody` emits
          # for every `stopped` terminal notification, so a hit means 2A
          # (or `postStopComment` from `failureExit`) already covered
          # this crash. Network / parse errors default to 0 so we still
          # post the fail-safe.
          SINCE=$(date -u -d '90 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
          RECENT_STOP=$(gh api \
            "repos/${REPO}/issues/${PR_NUM}/comments?since=${SINCE}&per_page=100" \
            --jq '[.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("🛑 **LoopPilot stopped**")))] | length' \
            2>/dev/null || echo 0)
          if [ "${RECENT_STOP:-0}" -gt 0 ]; then
            echo "::notice::TY-282 2A already posted a top-level stop notification within 90s (${RECENT_STOP} found); skipping 2B fail-safe to avoid duplicate."
            exit 0
          fi
          BODY=$'🛑 **LoopPilot crashed** — the auto-fix loop step ended with conclusion `'"$LOOP_CONCLUSION"$'` before the in-process stop notification could post (TY-282 #2B).\n\nThe hidden state may still be `fixing`; the next `/restart-review` (or the next pre-fix run on this PR) will demote it to `stopped / workflow_crashed`. Use `/restart-review` to resume — add `--hard` if iteration history needs clearing.\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post crash notification comment via gh api; check GITHUB_TOKEN scope."

      # TY-283: complement to TY-282 #2B. The #2B guard intentionally requires
      # `steps.loop.conclusion == 'failure' || 'cancelled'`, which means an
      # earlier step failing (e.g. `Get PR info`, `Check fork PR`,
      # `actions/checkout`, `actions/setup-node`, `npm ci`) leaves
      # `steps.loop.conclusion == 'skipped'` and produces NO PR notification —
      # the operator cannot tell from the PR alone that LoopPilot tried to
      # run and failed. TY-276 PR #97 observed this when a `node-version-file`
      # misconfiguration killed `setup-node` 10 seconds in; the loop never
      # started and the PR went silent for a full Codex iteration.
      #
      # This step fires on the exact complement: `failure()` is true AND the
      # loop step was skipped (= the failure was in an earlier step). It is
      # mutually exclusive with #2B because the conclusion check partitions
      # the failure space (`skipped` vs `failure`/`cancelled`). No dedup with
      # #2A is needed because the Node process for `./loop` never ran, so
      # `postStopComment` could not have fired.
      #
      # The fail-safe intentionally does NOT touch `looppilot-state`. Early-
      # step failures happen before any state mutation, so the existing
      # `waiting_codex` (or `done`/`stopped`) remains accurate; the next valid
      # Codex review trigger will reconcile naturally. The message keeps the
      # detail vague (the workflow YAML cannot reliably tell which early step
      # died) and just links the workflow run — Actions UI provides per-step
      # logs for root-cause investigation.
      - name: Post early-step failure notification
        # `cancelled()` is required in addition to `failure()`: a job timeout
        # (`timeout-minutes: 30`) or a manual workflow cancel during an early
        # step gives that step conclusion `cancelled`, leaves the loop step
        # `skipped`, and `failure()` returns false — so a bare `failure()`
        # would silently skip this fail-safe. TY-282 #2B already handles
        # cancellation via `loop.conclusion == 'cancelled'` directly.
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
          BODY=$'⚠️ **LoopPilot Workflow B failed before the auto-fix loop could start.**\n\nThe failure happened in an early setup step (e.g. `actions/checkout`, `actions/setup-node`, `npm ci`, or the PR info / fork guard step). The looppilot-state was not modified — the next valid Codex review will retry the loop (TY-283).\n\nWorkflow run: '"$RUN_URL"
          gh api "repos/${REPO}/issues/${PR_NUM}/comments" \
            --method POST \
            --raw-field body="$BODY" \
            >/dev/null || echo "::warning::Failed to post early-step failure notification via gh api; check GITHUB_TOKEN scope."
```

完全な workflow サンプル（PoC 用 artifact upload step 込み）は [`/.github/workflows/looppilot-init.yml`](.github/workflows/looppilot-init.yml) と [`/.github/workflows/looppilot-loop.yml`](.github/workflows/looppilot-loop.yml) を参照。

## 主要 input

| input | デフォルト | 説明 |
|-------|----------|------|
| `github-token` | (必須) | `contents:write` / `pull-requests:write` / `issues:write` を持つ token |
| `anthropic-api-key` | "" | Anthropic API 課金。`claude-code-oauth-token` と排他 (TY-260) |
| `claude-code-oauth-token` | "" | Claude Code サブスク。`claude setup-token` で生成 |
| `codex-review-request-token` | `github-token` | `@codex review` を Codex 連携ユーザーから依頼するための PAT |
| `looppilot-push-token` | "" | repair commit push 用の machine-user PAT / GitHub App token。**required checks や `auto-merge-on-clean` を使う production では実質必須** (`GITHUB_TOKEN` の push は `pull_request: synchronize` を発火させない GitHub 仕様のため、未設定だと auto-fix commit に対して CI が走らず PR #85 のような事故が起きる経路を残す。TY-281 検証済み)。 |
| `build-command` | "" | `CHECK_COMMAND` 通過後・staging 前に走る任意のビルドコマンド (TY-281)。`dist/` 等のビルド成果物を commit する repo で auto-fix commit が `src/` と drift しないようにする。空 default なら skip。複数ステップは `&&` 連結か npm script ラップで合わせる。生成物は **build-mode の緩和版 scope check** に通る — unlocked default blocks (`dist/`, `package.json` 等) とサイズ上限はスキップされる一方、`.github/` (locked) と path traversal は依然として reject される。詳細は [`docs/operations/scope-policy.md`](docs/operations/scope-policy.md)。 |
| `looppilot-label` | `loop-pilot` | このラベルを持つ PR のみが自動修正対象 (default-strict)。**前提として repo にラベルを作成して PR に付ける必要がある** (上の「前提: gate label の作成」参照、TY-293 #2)。未作成だと workflow run 自体が生成されない |
| `looppilot-full-auto` | `false` | true でラベルゲートを無効化 (全 PR で LoopPilot が起動) |
| `max-review-iterations` | `20` | 1 PR あたりの最大修正回数 |
| `severity-threshold` | `P3` | これ未満の severity は無視 (TY-256)。デフォルト `P3` は P0/P1/P2/P3 すべてを修正対象、`P2` で従来挙動 (P3 を skip)、`P1`/`P0` でさらに狭める |
| `scope-allowed-path-prefixes` | `src/,tests/,docs/` | scope check の allow-list (TY-266) |
| `looppilot-hard-block-override` | "" | 特定パスを hard-block 対象から外す (TY-255) |
| `auto-merge-on-clean` | `false` | `done / no_findings` 到達時に自動 squash merge (TY-245 / TY-277)。**前提として repo Settings → General → "Allow auto-merge" を有効化する必要がある** (TY-288)。未有効だと `gh pr merge --auto` が即 fail し、`mergeIfChecksPass` が warning ログ + PR コメント (`⏸️ Auto-merge skipped`) で理由を通知して skip する (TY-295)。同様に CI 失敗 / HEAD 変化 / timeout / 一時的 API エラー の各 skip 経路でも PR 通知が出る — 詳細は [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md#skip-時の-pr-通知-ty-295) |

すべての input は [`loop/action.yml`](loop/action.yml) と [`init/action.yml`](init/action.yml) を参照。

## ドキュメント

- [`docs/README.md`](docs/README.md) — 全体目次
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — 設計概要
- [`docs/architecture/flow-and-state.md`](docs/architecture/flow-and-state.md) — フロー / state 管理
- [`docs/operations/security.md`](docs/operations/security.md) — secrets / scope check / 認証
- [`docs/operations/stop-and-recovery.md`](docs/operations/stop-and-recovery.md) — 停止条件と `/restart-review`

## 開発

```bash
npm ci
npm run check     # tsc --noEmit + tests/ typecheck + vitest run
npm run bundle    # dist/ を再生成
```

PR を開くと CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) が typecheck / test / dist drift をチェックする。

## ライセンス

[MIT](LICENSE)
