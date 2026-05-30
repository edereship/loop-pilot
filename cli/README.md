# `gh looppilot` — LoopPilot setup CLI

A [GitHub CLI extension](https://docs.github.com/en/github-cli/github-cli/creating-github-cli-extensions)
that turns the "copy ~461 lines of YAML" adoption into one command. It generates
the thin caller workflows (referencing the reusable workflows `@v1`), creates the
gate label, suggests a `CHECK_COMMAND`, lists the manual setup steps, and runs a
read-only pre-flight against your authenticated `gh` session.

> **Status: staged.** Per [ADR-0001](../docs/architecture/adr-0001-cli-distribution.md),
> the canonical home is a dedicated `team-yubune/gh-looppilot` repo (a gh
> extension requires a `gh-<name>` repo). This directory is the staged content of
> that repo, developed inside `loop-pilot` and covered by its CI until extracted.

## Install (after extraction)

```bash
gh extension install team-yubune/gh-looppilot
gh looppilot init      # scaffold callers + label + CHECK_COMMAND + manual steps + pre-flight
gh looppilot doctor    # read-only pre-flight only
```

Requires Node ≥ 20 on PATH (the extension is an interpreted Node CLI; the shim
`gh-looppilot` execs `node cli.cjs`).

## Commands

| Command | What it does |
|---|---|
| `gh looppilot init` | Detect the toolchain, write `.github/workflows/looppilot-{init,loop}.yml` (thin callers pinned to `@v1`), create the gate label, suggest `CHECK_COMMAND`, print the manual (non-automatable) steps, then run pre-flight. |
| `gh looppilot doctor` | Run the read-only pre-flight only (= `init --preflight-only`). |

Key flags: `--full-auto` (no gate label), `--same-repo` (`secrets: inherit`),
`--label <name>`, `--check-command <c>`, `--ref <ref>`, `--repo <owner/repo>`,
`--dry-run`, `--force`, `--no-preflight`, `--json` (doctor). See `gh looppilot --help`.

Pre-flight exit codes: `0` = no errors (warnings/unknown allowed), `1` = an error
to fix before the first PR, `2` = the check run itself could not proceed (auth /
repo resolution).

## Local development (inside loop-pilot)

```bash
npm run cli -- doctor --json     # run from source via tsx
npm run bundle:cli               # build cli/cli.cjs (esbuild)
npm run typecheck:cli            # tsc --noEmit -p cli/tsconfig.json
npm run check                    # full repo check incl. cli/tests
gh extension install ./cli       # install the local extension (after bundle:cli)
```

Layout: `gh-looppilot` (shim) · `cli.cjs` (built bundle, gitignored here / committed
in the extension repo) · `src/` (TS) · `tests/` (vitest, run by the repo's
`npm run check`).

## Extraction checklist (human-approval step)

1. Create `team-yubune/gh-looppilot` (public).
2. Move `cli/` → repo root (e.g. `git subtree split -P cli` or copy).
3. Commit the built `cli.cjs` (the extension runs the bundle directly — no `npm install`).
4. Add a release workflow (tag → `gh release`; or `cli/gh-extension-precompile` for
   a binary build) and tag `v0.1.0`.
5. `gh extension install team-yubune/gh-looppilot` and verify `gh looppilot doctor`.
6. Remove `cli/` from `loop-pilot` (or keep as a mirror — decide at extraction).
