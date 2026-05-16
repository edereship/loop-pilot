# Production E2E Validation Notes

This document records the TY-145 production-migration validation performed
against `team-yubune/test-auto-ai-review` and the disposable public repository
`racoma-dev/auto-review-fix-test`.

Validation date: 2026-05-16

## Repository Settings Observed

Repository:

- `full_name`: `team-yubune/test-auto-ai-review`
- `private`: `true`
- `default_branch`: `main`
- Current operator permissions: `admin`, `maintain`, `push`, `triage`, `pull`
- `allow_auto_merge`: `false`
- `delete_branch_on_merge`: `true`

GitHub Actions workflow permission:

```json
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false
}
```

Repository variables:

| Variable | Value |
|---|---|
| `AUTO_REVIEW_AUTO_MERGE` | `true` |
| `AUTO_REVIEW_FULL_AUTO` | `true` |
| `CHECK_COMMAND` | `npm run check` |

The repository default workflow permission is read-only, but the workflow files
request the job-level permissions needed by the loop:

- `contents: write`
- `pull-requests: write`
- `issues: write`

The current repository accepts those explicit workflow permissions. This does
not prove that a production organization policy will allow the same elevation;
production must verify this on the target repository.

## Same-Repository PR Validation

The same-repository E2E path was validated with PR #58:

- PR: <https://github.com/team-yubune/test-auto-ai-review/pull/58>
- Auto-fix run: <https://github.com/team-yubune/test-auto-ai-review/actions/runs/25952862118>
- Seed commit: `da7ebb58ef0726e5e5bb0c6b8491abfbad02eab7`
- Auto-fix commit: `e1b1d28ea5af4a071d739b50ea329d4615a36c00`
- Merge commit: `de8c25009f8750f3a2927333d2ad21d402f6192e`

Observed result:

- Codex produced a finding for the seeded regression.
- Workflow B checked out the same-repository PR branch.
- `anthropics/claude-code-action@v1` produced a repair.
- post-fix ran `CHECK_COMMAND`.
- post-fix committed and pushed the repair commit.
- the loop re-requested Codex review.
- Codex returned no major issues.
- the state reached `done / no_findings`.

The final run used:

- `actions/checkout@v5`
- `actions/upload-artifact@v6`

No Node.js 20 action deprecation warning was observed in that run.

## External Fork PR Validation

The private source repository cannot currently run the external-fork PR E2E
because forking is disabled:

```text
failed to fork: HTTP 403: The repository exists, but forking is disabled.
```

The workflow guard still exists in code:

- Workflow A requires
  `github.event.pull_request.head.repo.full_name == github.repository` in the
  job `if`.
- Workflow B fetches PR data with GitHub API and stops before checkout when
  `.head.repo.full_name` is empty or different from `github.repository`.

What remains for production:

1. Enable or use a repository where external forks are allowed.
2. Create a fork-owned branch with a harmless docs-only change.
3. Open a PR from the fork into the production repository.
4. Add the normal auto-review trigger label or enable the production trigger
   mode being validated.
5. Confirm Workflow A does not create hidden state or post `@codex review`.
6. If a Codex review/comment is manually posted, confirm Workflow B stops before
   `actions/checkout`, `claude-code-action`, and any push-capable step.
7. Close the disposable fork PR without merging.

Acceptance criteria for production:

- no secrets are exposed to the fork run,
- no checkout of fork code occurs in the auto-fix job,
- no Claude repair step runs,
- no commit or push is attempted.

The fork guard was then validated in the disposable public repository:

- Base repository: <https://github.com/racoma-dev/auto-review-fix-test>
- Fork repository: <https://github.com/team-yubune/auto-review-fix-test>
- Fork PR: <https://github.com/racoma-dev/auto-review-fix-test/pull/1>
- Guard run: <https://github.com/racoma-dev/auto-review-fix-test/actions/runs/25953479826>

Observed result:

- Workflow A was skipped for the fork PR.
- A manual `@codex review` caused Workflow B to start.
- Workflow B failed at `Check fork PR (security guard)`.
- `actions/checkout`, the auto-fix loop, and commit/push steps were skipped.

## Branch Protection And Rulesets

This private repository cannot expose branch protection or ruleset data through
the GitHub API in the current plan:

```text
HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.
```

That means this repository cannot prove branch-protection behavior. Production
must verify the target repository directly.

Production validation steps:

1. Open the target repository settings.
2. Identify branch protection rules or repository rulesets that apply to the
   default branch and PR branches.
3. Confirm whether Actions `GITHUB_TOKEN` is allowed to push to the PR branch.
4. Confirm whether required checks include the same command configured as
   `CHECK_COMMAND`.
5. Run a same-repository PR through the loop.
6. Confirm one of the following outcomes:
   - the auto-fix push succeeds and the required checks run on the repair commit,
   - or branch protection blocks the push, in which case production needs a
     documented alternative token or a human-only repair mode.

The required-check path was partially validated in the disposable public
repository:

- PR: <https://github.com/racoma-dev/auto-review-fix-test/pull/2>
- Initial failing commit: `2fe2f16e5d29682d21bd025c7eb23c41e6a1a94d`
- Auto-fix run: <https://github.com/racoma-dev/auto-review-fix-test/actions/runs/25953872990>
- Auto-fix commit: `9870dc680b48aee7af81f821366ed3b53755c436`

Observed result:

- branch protection on `main` required the `check` status check;
- the initial PR `check` failed for the seeded regression;
- the auto-fix loop repaired the regression and pushed the repair commit;
- local verification on the repair commit passed `npm run check`;
- no GitHub Actions `check` check-run was created for the repair commit, so the
  PR remained blocked by the required check.

This indicates that using `GITHUB_TOKEN` for the auto-fix push is not sufficient
when production requires CI to run on the repair commit. TY-257 adds
`AUTO_REVIEW_PUSH_TOKEN` so production can use a dedicated machine-user PAT or
GitHub App token for the repair commit push while keeping
`CODEX_REVIEW_REQUEST_TOKEN` limited to `@codex review` requests.

The final Codex re-review on the repair commit was also blocked by Codex usage
limits, so the public-repo run did not reach a fresh `done / no_findings` state
after branch protection was enabled.

TY-257 then validated the dedicated push-token path in the same disposable
public repository:

- PR: <https://github.com/racoma-dev/auto-review-fix-test/pull/3>
- Initial failing commit: `8d281ae762578f08acc6c4abefb6802d5b8690e2`
- Auto-fix run: <https://github.com/racoma-dev/auto-review-fix-test/actions/runs/25958760165>
- Auto-fix commit: `40d409057bad00438da80e0b4aa41acbdeb92a15`
- Required check run on repair commit: <https://github.com/racoma-dev/auto-review-fix-test/actions/runs/25958804353>
- Final no-findings run: <https://github.com/racoma-dev/auto-review-fix-test/actions/runs/25958829233>

Observed result:

- `AUTO_REVIEW_PUSH_TOKEN` was configured as a Repository secret.
- the initial PR `check` failed for the seeded regression;
- the auto-fix loop repaired the regression and pushed the repair commit;
- GitHub Actions created a new `check` run on the repair commit;
- the repair commit `check` passed;
- Codex returned no major issues on the repair commit;
- the state reached `done / no_findings`;
- the PR became `mergeStateStatus=CLEAN`.

## Required Checks And `CHECK_COMMAND`

`CHECK_COMMAND` is currently:

```text
npm run check
```

Local verification on 2026-05-16:

```text
26 test files passed
336 tests passed
```

Production guidance:

- Keep repository required checks aligned with `CHECK_COMMAND`.
- If the production repo requires additional CI checks, keep auto-merge disabled
  until those checks report on the repair commit.
- If `CHECK_COMMAND` differs from the required checks, document which signal is
  authoritative for auto-review completion.
- If required checks must run on repair commits, configure
  `AUTO_REVIEW_PUSH_TOKEN` with a non-`GITHUB_TOKEN` actor that can push the PR
  branch and trigger workflows.

## Human-Required Items

The following cannot be completed from this repository as currently configured:

- external fork PR E2E in the private source repository, because forking is
  disabled;
- branch protection/ruleset validation in the private source repository, because
  it does not expose those APIs on the current GitHub plan;
- production organization policy validation, because org-level token caps are
  specific to the target organization/repository.

The disposable public repository covered the fork guard and demonstrated that
same-repository auto-fix can push under branch protection. It also exposed the
remaining required-check gap after a `GITHUB_TOKEN` push.

Use the steps above on the production target before treating TY-145 as fully
closed.
