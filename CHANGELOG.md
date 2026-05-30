# Changelog

All notable changes to LoopPilot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The moving `v1` tag always points at the latest `v1.x.y` release; pin to `@v1`
for automatic patch/minor updates or to a full `@v1.x.y` (or a commit SHA) to
freeze. See [docs/operations/releasing.md](docs/operations/releasing.md).

## [Unreleased]

## [1.0.0] - 2026-05-30

### Added
- First stable release. Distributes the `init` and `loop` composite actions as
  `team-yubune/loop-pilot/{init,loop}@v1`, plus the tag-driven release pipeline
  that keeps the moving `v1` tag and GitHub Releases in sync (TY-342).
