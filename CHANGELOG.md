# Changelog

All notable changes to LoopPilot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The moving `v1` tag always points at the latest `v1.x.y` release; pin to `@v1`
for automatic patch/minor updates or to a full `@v1.x.y` (or a commit SHA) to
freeze. See [docs/operations/releasing.md](docs/operations/releasing.md).

## [Unreleased]

### Added
- In-job `@codex review` acknowledgement watchdog (TY-334, ported from the
  upstream PoC). After posting `@codex review`, init / post-fix / `/restart-review`
  now poll for Codex's 👀 reaction (or any new Codex activity) for up to
  `CODEX_ACK_TIMEOUT_SECONDS` (default 90, `0` disables) and re-request the
  review up to `CODEX_ACK_MAX_REPOSTS` times (default 2) before stopping with
  `codex_request_failed`. Previously, if Codex silently dropped the request (no
  reaction, no review), the loop wedged at `waiting_codex` indefinitely until an
  operator ran `/restart-review`. Reposts are authored by the request token (not
  the Codex bot) so they cannot self-trigger the loop; bounds keep
  `timeout × (reposts + 1)` under the job budget (the init job timeout is raised
  5 → 10 min). New tunables: `CODEX_ACK_TIMEOUT_SECONDS`,
  `CODEX_ACK_POLL_INTERVAL_SECONDS`, `CODEX_ACK_MAX_REPOSTS`.

## [1.1.0] - 2026-05-31

### Fixed
- The reusable `loop.yml` workflow now forwards the `LOOPPILOT_BLOCK_PATHS`,
  `LOOPPILOT_SCOPE_MAX_FILES`, and `LOOPPILOT_SCOPE_MAX_LINES` repository
  variables to the composite `loop` action. Previously these documented
  scope-policy variables were silently ignored — GitHub `vars.*` are not
  auto-exported to an action's process env, and the workflow never passed them
  as inputs — so custom block paths and size budgets had no effect and the
  `scope_violation` / `too_many_files` / `too_many_lines` stop-comment recovery
  hints pointed at variables that did nothing. The values are also forwarded to
  pre-fix so the repair prompt's `## Scope Policy` section reflects the
  operator's configuration. Built-in default block paths (`.github/` locked,
  `dist/`, `package.json`, …) and the default budgets were always enforced
  regardless, so this was a configuration/UX gap, not a protection bypass
  (TY-350).

### Removed
- The deprecated scope variables `LOOPPILOT_HARD_BLOCK_OVERRIDE`,
  `LOOPPILOT_SCOPE_ALLOWED_PATH_PREFIXES`, and
  `LOOPPILOT_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES` (and their
  `looppilot-hard-block-override` / `scope-allowed-path-prefixes` /
  `scope-additional-hard-block-prefixes` action inputs) are removed, as
  announced in TY-271. They were never forwarded from `loop.yml` to the
  composite action, so they had no effect through `@v1` regardless. Migrate to
  `LOOPPILOT_BLOCK_PATHS` (use the `!path` syntax to un-block defaults); see
  [docs/operations/scope-policy.md](docs/operations/scope-policy.md).

## [1.0.0] - 2026-05-30

### Added
- First stable release. Distributes the `init` and `loop` composite actions as
  `team-yubune/loop-pilot/{init,loop}@v1`, plus the tag-driven release pipeline
  that keeps the moving `v1` tag and GitHub Releases in sync (TY-342).
