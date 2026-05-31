# Security Policy

LoopPilot runs as GitHub Actions workflows that handle credentials — a Claude
API key or OAuth token, and (in production) two fine-grained GitHub PATs. We
take reports about the action's handling of these tokens, its repair-loop
guards, and its trust boundaries seriously.

## Supported versions

LoopPilot is distributed as a repository plus Git tags; adopters pin to the
moving major tag `@v1`, which always points at the latest `v1.x.y` release.
Security fixes land on the latest minor and are picked up automatically by
`@v1`. Only the latest `v1.x.y` release is supported — if you pin to an older
`@v1.x.y` or a commit SHA, upgrade to the latest `v1` before reporting.

| Version | Supported |
|---|---|
| Latest `v1.x.y` (tracked by `@v1`) | ✅ |
| Older `v1.x.y` / pinned SHA | ⚠️ Upgrade first |
| `@main` | ❌ Pre-release, not for production |

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a
suspected vulnerability.** Public disclosure before a fix is available puts
every adopter at risk.

Instead, report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** to open a private security advisory.
3. Include the affected version (`@v1` SHA or `v1.x.y` tag), a description of
   the issue, reproduction steps, and the potential impact.

If private reporting is unavailable, contact the maintainers directly rather
than disclosing publicly.

### What to expect

- **Acknowledgement** within a few business days.
- An initial assessment and severity triage after we reproduce the report.
- Coordinated disclosure: we will agree on a timeline with you and credit you
  in the advisory and `CHANGELOG.md` unless you prefer to stay anonymous.

## Scope

In scope:

- Token exfiltration or logging of `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_REVIEW_REQUEST_TOKEN`, or
  `LOOPPILOT_PUSH_TOKEN`.
- Bypasses of the fork-PR guard, scope/path block-list, secret scanner, or the
  hidden-state trust-author check.
- Indirect prompt-injection paths that let untrusted PR content escalate the
  repair agent's permissions.
- Privilege escalation through the composite actions or reusable workflows.

Out of scope:

- Vulnerabilities in upstream dependencies (report those to the respective
  project — e.g. `anthropics/claude-code-action`, GitHub Actions runners).
- Misconfigurations in an adopter's own repository (over-scoped PATs, disabled
  branch protection, leaked secrets in their repo).

## Security model

The action's threat model and the rationale behind each guard — fork-PR
blocking, token scopes, the secret scanner, scope policy, and the indirect
prompt-injection defenses — are documented in
[docs/operations/security.md](docs/operations/security.md).
