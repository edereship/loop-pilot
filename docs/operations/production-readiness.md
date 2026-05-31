# Production readiness checklist

A pre-announcement checklist for shipping LoopPilot to external adopters. "Public
on GitHub" and "ready to announce for production adoption" are different bars;
this file separates what is **done** from what is **operator/owner-gated**.

Last verified: 2026-06-01, against `@v1` = `v1.4.0` (`e9f75b2`).

## 1. Core artifact (`team-yubune/loop-pilot`)

- [x] Repository is **public** (`visibility=PUBLIC`).
- [x] `LICENSE` present (MIT). Note: the GitHub API license picker may show
      "none" because the file is a bare MIT text without an SPDX header — cosmetic;
      the file is valid MIT.
- [x] Latest release is **not** a draft/prerelease and is marked Latest.
- [x] Moving `@v1` tag points at the latest `vX.Y.Z` release commit
      (`git ls-remote origin refs/tags/v1` == release SHA).
- [x] `vX.Y.Z` tag and `@v1` resolve to the same commit.
- [x] CI on `main` is green (typecheck + full vitest suite).
- [x] `dist/` is reproducible from `src/` (no drift): `npm run bundle && git status --porcelain dist/` is empty. Enforced by `release.yml`.
- [x] Sub-action `@vMAJOR` refs are consistent: `npm run check:action-refs -- vX.Y.Z`.
- [x] No open PRs / issues left dangling before announce.
- [x] Config-wiring matrix guard in CI (`tests/config-wiring.test.ts`) so the
      TY-335/337/350 regression class fails CI.

## 2. CLI installer (`team-yubune/gh-looppilot`)

The README leads adopters with `gh looppilot init`, so the CLI is on the
critical path.

- [x] Repository public; `gh extension install team-yubune/gh-looppilot` works.
- [x] It is an **interpreted** gh extension (no `manifest.yml`; committed
      `cli.cjs` + `gh-looppilot` shim) → installs track the **default branch
      (`main`)**, not a release tag. The `v0.1.0` tag is a marker only.
      Implication: shipping a CLI change = merge to `main` (no tag/release needed),
      and the version table rule (only bump on `@v1`-consumed surface changes)
      does not apply to the CLI.
- [x] Scaffolded callers pin `@v1` by default (`cli.cjs`: `ref: opts.ref ?? "v1"`;
      templates emit `…/.github/workflows/{init,loop}.yml@${ref}`), so a fresh
      `gh looppilot init` consumes the just-released `@v1`.
- [x] `main` is only docs-ahead of the last tag (no functional drift).
- [ ] **Owner check:** decide whether to cut a `gh-looppilot` release tag for
      changelog hygiene (optional — installs don't need it).

## 3. Docs & onboarding

- [x] README (EN + JA) lead with the CLI path + a manual `@v1` caller fallback.
- [x] Required secrets documented: exactly one of `ANTHROPIC_API_KEY` /
      `CLAUDE_CODE_OAUTH_TOKEN`, plus the Codex token + push token PATs.
- [x] Repository-variable table is EN/JA in sync (guarded by
      `config-wiring.test.ts`).
- [x] Codex GitHub App connection + `loop-pilot` label steps documented.
- [x] `gh looppilot doctor` pre-flight available for adopter self-check.

## 4. Live end-to-end (external adopter shape)

Validated from `racoma-dev/loop-pilot-e2e` (a true external adopter consuming
`@v1`), per [[looppilot-e2e-progress]].

- [x] T0–T12 acceptance suite passed historically (incl. live IPI), 0 product bugs.
- [ ] **Per-release smoke against the new `@v1`** — see §6. Re-run the happy path
      on each `@v1` advance, because adopters auto-consume the moving tag.

## 5. Owner / org-deploy-time gates (cannot be done from this repo alone)

These are **decisions or external-environment checks**, not code state. Tracked
in Linear **TY-341**.

- [ ] **#38 fork-PR rejection (live):** needs a *second* GitHub account (you
      cannot fork your own repo). The fork guard is covered by unit tests + the
      workflow-level `if:`; the live cross-account rejection is unverified.
- [ ] **#40 org policy / token caps:** needs the production org (team-yubune) with
      org-admin to set: allowed-actions policy, default `GITHUB_TOKEN`
      permissions, PAT/SSO/IP policies, and token caps. Verify the reusable
      workflow runs under the real org's restrictions.
- [ ] **Cost & abuse posture:** BYO-key (Anthropic + Codex). Decide the spend
      ceiling / who pays, and the stance on public-PR triggers before a broad
      announcement. (The fork guard already blocks fork PRs; full-auto mode
      widens the trigger surface — keep it off for public repos unless intended.)
- [ ] **Announcement decision:** the repo is already public; "announce for
      production adoption" is a go/no-go you own once §5 is acceptable.

## 6. Per-release smoke (run on every `@v1` advance)

1. Confirm `@v1` == the new release SHA.
2. On `loop-pilot-e2e`, open a feature PR carrying a realistic bug; add the
   `loop-pilot` label.
3. Verify the chain on the new runtime:
   - **Init** posts the state + status comment and `@codex review`.
   - **Codex** posts findings.
   - **pre-fix → claude-code-action → post-fix** applies a fix, `npm run check`
     passes, commit pushed.
   - Loop reaches **`done / no_findings`** (and auto-merges if enabled).
4. Confirm no spurious crash / duplicate-stop notifications.
5. Clean up the throwaway PR/branch.

> Cost note: step 2–3 spend real Codex + Claude budget (~1 small iteration).
> Lower-cost partial checks (init only, or the `$0` inject harnesses) exist but
> do not exercise the full runtime — see [[looppilot-e2e-progress]].
