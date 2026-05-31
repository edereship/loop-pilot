# Changelog

All notable changes to LoopPilot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The moving `v1` tag always points at the latest `v1.x.y` release; pin to `@v1`
for automatic patch/minor updates or to a full `@v1.x.y` (or a commit SHA) to
freeze. See [docs/operations/releasing.md](docs/operations/releasing.md).

## [Unreleased]

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

## [1.0.0] - 2026-05-30

### Added
- First stable release. Distributes the `init` and `loop` composite actions as
  `team-yubune/loop-pilot/{init,loop}@v1`, plus the tag-driven release pipeline
  that keeps the moving `v1` tag and GitHub Releases in sync (TY-342).
