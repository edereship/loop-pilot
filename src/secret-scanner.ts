/**
 * Detect secret-shaped strings introduced by claude-code-action's edits
 * (TY-274 #1).
 *
 * `scope-checker.ts` enforces *path* policy after a claude-code-action run, but
 * once a path is allow-listed (e.g. `src/`) the agent is free to embed
 * arbitrary content into it. `Read`-able files under `$HOME` (e.g. `.env`,
 * `~/.aws/credentials`) can therefore be exfiltrated by writing their contents
 * into an `src/` file and letting the post-fix loop commit and push the
 * result. This module is the content-side complement: post-fix scans the
 * **added lines** of the working-tree diff before the auto-fix commit lands
 * and rolls back when a known high-confidence secret pattern matches.
 *
 * # Why diff-based, not whole-content
 *
 * The scanner's own implementation file (`src/secret-scanner.ts`) contains
 * regex literals that encode the patterns to detect — by definition, the
 * file matches every pattern it defines. Test fixtures in
 * `tests/secret-scanner.test.ts` likewise contain example secret-shaped
 * strings. Scanning whole working-tree content would treat those legitimate
 * source files as leak vectors and stop the loop on the scanner's own code.
 *
 * Diff-based scanning fixes this structurally: pre-existing regex literals
 * and fixtures are in HEAD already, so `git diff HEAD` does not list them
 * as additions. Only lines that the current iteration *added* are scanned.
 *
 * # Two-tier policy
 *
 * Hard-fail patterns are limited to well-known token *prefixes* and the
 * `-----BEGIN ... PRIVATE KEY-----` block markers. Those have effectively
 * zero false positives in normal source code, so detecting one is
 * overwhelmingly likely to be a real leak — stopping the loop with
 * `secret_leak_suspected` is worth the disruption.
 *
 * Warning patterns are noisier signals (high-entropy strings, generic
 * `password = "..."` style assignments) that are useful for operations
 * telemetry but too prone to false positives (hashes in lockfiles, minified
 * JS, base64 fixtures) to be promotable to a hard fail directly. They are
 * surfaced via `core.info` so operators can review them and request
 * promotion to a hard-fail pattern once a pattern accumulates a clean
 * track record.
 *
 * The scanner never reports the matched substring — only the pattern name
 * and the file path — so the action log itself does not become a secret leak
 * vector.
 */

export type SecretSeverity = "hard" | "warn";

export interface SecretPattern {
  /** Stable identifier surfaced in logs and the stop comment. */
  readonly name: string;
  /** Hard-fail (`secret_leak_suspected`) vs warning (info log only). */
  readonly severity: SecretSeverity;
  /** Regex tested against each scan target's added content. */
  readonly re: RegExp;
}

export interface SecretScanFinding {
  /** `SecretPattern.name` of the rule that matched. */
  pattern: string;
  severity: SecretSeverity;
  /** Repo-relative path of the file the rule matched in. */
  path: string;
}

export interface SecretScanResult {
  /** Findings that should stop the loop with `secret_leak_suspected`. */
  hardFailures: SecretScanFinding[];
  /** Findings that should be logged but not stop the loop. */
  warnings: SecretScanFinding[];
}

export interface SecretScanTarget {
  /** Repo-relative path. Used only for diagnostics; the regex is matched against `content`. */
  path: string;
  /**
   * Added-only content to scan. For tracked files this is the concatenation of
   * `+`-prefixed lines from a unified diff; for untracked files it is the
   * entire file body (since the whole file is new). Empty-string targets are
   * silently skipped.
   */
  content: string;
}

/**
 * Hard-fail patterns. Each entry must have effectively zero false-positive
 * rate in typical source code; matches stop the LoopPilot loop with
 * `secret_leak_suspected`. New entries should be added only after a warning
 * pattern has accumulated real-world hits without false positives.
 */
export const HARD_FAIL_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "github-pat-classic",
    severity: "hard",
    // Classic PATs (`ghp_` + 36 base62 chars in practice; floor 20 to cover
    // older shorter formats and avoid false negatives on shape drift).
    re: /ghp_[A-Za-z0-9]{20,}/,
  },
  {
    name: "github-oauth-token",
    severity: "hard",
    re: /gho_[A-Za-z0-9]{20,}/,
  },
  {
    name: "github-user-server-token",
    severity: "hard",
    // ghu_ (user-to-server) and ghs_ (server-to-server) share the same shape.
    re: /gh[us]_[A-Za-z0-9]{20,}/,
  },
  {
    name: "github-refresh-token",
    severity: "hard",
    // ghr_ refresh tokens (paired with ghu_/ghs_ short-lived credentials).
    re: /ghr_[A-Za-z0-9]{20,}/,
  },
  {
    name: "github-fine-grained-pat",
    severity: "hard",
    // Fine-grained PATs use the `github_pat_` prefix followed by a longer
    // body (typically `<11>_<59>` base62 chars). Length floor 30 covers the
    // shortest documented shape with margin.
    re: /github_pat_[A-Za-z0-9_]{30,}/,
  },
  {
    name: "anthropic-or-openai-api-key",
    severity: "hard",
    // sk-ant-… for Anthropic, sk-… for OpenAI. The unified regex picks up
    // both with at least 20 trailing key chars.
    re: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "slack-token",
    severity: "hard",
    re: /xox[bp]-[A-Za-z0-9-]{20,}/,
  },
  {
    name: "aws-access-key-id",
    severity: "hard",
    // AWS access keys are AKIA-prefixed 20-character all-caps blocks.
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "aws-secret-key-assignment",
    severity: "hard",
    // Generic AWS secret key shape: `aws_secret_access_key = "..."` or
    // `aws_secret = "..."`. Length floor avoids matching empty placeholders.
    re: /aws_secret[a-zA-Z_]*\s*[:=]\s*['"]?[A-Za-z0-9/+=]{30,}/i,
  },
  {
    name: "private-key-block",
    severity: "hard",
    // PEM private-key envelopes only. Explicitly excludes `PUBLIC KEY` — the
    // canonical PEM grammar uses `PRIVATE KEY` or `ENCRYPTED PRIVATE KEY` for
    // anything sensitive, and "BEGIN PUBLIC KEY" is a legitimate construct
    // that should not trigger a hard fail. Algorithm tags (RSA / DSA / EC /
    // OPENSSH / etc.) come *before* "PRIVATE KEY", so they are absorbed by
    // the `[A-Z0-9 -]*` slot.
    re: /-----BEGIN (?:[A-Z0-9 -]*)?(?:ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: "git-checkout-basic-auth",
    severity: "hard",
    // base64 of the literal `x-access-token:` prefix that `actions/checkout`
    // persists into `.git/config` as
    // `http.<url>.extraheader = AUTHORIZATION: basic <base64(x-access-token:<TOKEN>)>`.
    // The prefix patterns above catch the *plaintext* `ghs_…` token, but the
    // agent runs with an unrestricted `Read` tool and can read `.git/config`,
    // whose credential is stored base64-encoded. Committing that blob to an
    // allowed path would exfiltrate the workflow GITHUB_TOKEN, and the base64
    // form matches none of the raw-prefix rules — it would otherwise only trip
    // the WARN-tier high-entropy rule, which does not stop the loop. The
    // 15-byte prefix encodes to a fixed 20-char base64 string, so this is an
    // effectively zero-false-positive hard fail.
    re: /eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]{10,}/,
  },
];

/**
 * Warning patterns. Matches are noisy enough that hard-failing on them would
 * stop the loop on benign content (hashes in lockfiles, minified JS, base64
 * fixtures), so they are surfaced as `core.info` telemetry only. Operators
 * can promote a pattern to hard-fail once it accumulates real-world hits.
 */
export const WARN_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "credential-assignment",
    severity: "warn",
    // `password = "secret"`, `api_key: 'abc...'`, `secret="..."`.
    // Length floor (6) avoids matching empty placeholders / test fixtures.
    re: /\b(?:password|secret|api[_-]?key)\b\s*[:=]\s*['"][^'"\n]{6,}['"]/i,
  },
  {
    name: "high-entropy-long-string",
    severity: "warn",
    // 32+ char run of base64-url-safe characters — broad on purpose.
    // Anchored to word boundaries so partial matches inside larger tokens are
    // also caught.
    re: /\b[A-Za-z0-9_-]{32,}\b/,
  },
];

/**
 * Scan a set of (path, added-content) pairs for secret patterns.
 *
 * Each pattern is tested against the entire `content` (not line-by-line) —
 * multi-line keys (`-----BEGIN ... KEY-----` ... `-----END ... KEY-----`)
 * would otherwise be split across lines and miss. Patterns match at most once
 * per file, so a single offending file produces a single finding per rule
 * rather than flooding the stop comment.
 */
export function scanForSecrets(
  targets: readonly SecretScanTarget[]
): SecretScanResult {
  const hardFailures: SecretScanFinding[] = [];
  const warnings: SecretScanFinding[] = [];

  for (const target of targets) {
    if (target.content.length === 0) continue;

    for (const pattern of HARD_FAIL_SECRET_PATTERNS) {
      if (pattern.re.test(target.content)) {
        hardFailures.push({
          pattern: pattern.name,
          severity: pattern.severity,
          path: target.path,
        });
      }
    }
    for (const pattern of WARN_SECRET_PATTERNS) {
      if (pattern.re.test(target.content)) {
        warnings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          path: target.path,
        });
      }
    }
  }

  return { hardFailures, warnings };
}

/**
 * Decode a git-quoted path. Git wraps paths containing non-ASCII or shell-
 * special characters in double quotes and escapes the contents C-style
 * (`\\`, `\"`, `\t`, `\n`, `\r`, plus `\NNN` octal byte values for non-ASCII).
 *
 * This handles the common escapes; bytes outside the basic set fall through
 * with the escape preserved rather than corrupting them. The goal is to
 * recover *enough* of the original path for diagnostics and to ensure scanning
 * still runs against the file's added lines — perfect round-trip is not
 * required.
 */
/**
 * Decode a git C-quoted path (the inner content, without the surrounding
 * `"..."`). Git emits this form when a path contains control characters,
 * embedded quotes, backslashes, or — when `core.quotepath` is unset —
 * non-ASCII bytes. Recognized escapes: `\n` / `\t` / `\r` / `\"` / `\\` and
 * `\NNN` octal bytes.
 *
 * TY-306 #2: exported so `parseGitNumstat` can share the same decode logic
 * and keep scope-check and secret-scan reasoning about the same filename
 * even when paths contain tabs / newlines / embedded quotes.
 */
export function unquoteGitPath(quoted: string): string {
  let result = "";
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i];
    if (c !== "\\" || i === quoted.length - 1) {
      result += c;
      continue;
    }
    const next = quoted[i + 1]!;
    if (next === "n") { result += "\n"; i++; continue; }
    if (next === "t") { result += "\t"; i++; continue; }
    if (next === "r") { result += "\r"; i++; continue; }
    if (next === '"') { result += '"'; i++; continue; }
    if (next === "\\") { result += "\\"; i++; continue; }
    // \NNN octal byte
    if (/[0-7]/.test(next) && i + 3 < quoted.length && /[0-7]/.test(quoted[i + 2]!) && /[0-7]/.test(quoted[i + 3]!)) {
      const oct = quoted.slice(i + 1, i + 4);
      result += String.fromCharCode(parseInt(oct, 8));
      i += 3;
      continue;
    }
    result += c;
  }
  return result;
}

/**
 * Parse the path field of a unified-diff file header (`+++ ` / `--- ` value).
 *
 * Accepts both the bare form (`b/<path>`) and the git-quoted form
 * (`"b/<path>"`, used when the path contains tabs, newlines, non-ASCII, etc).
 * Returns `null` for the deletion sentinel `/dev/null`. Paths are returned
 * without the `a/` or `b/` prefix.
 *
 * For unquoted bare-form headers, git appends a trailing tab + timestamp
 * delimiter when paths contain spaces — e.g. `+++ b/foo bar.txt\t`. The
 * trailing tab is part of the diff format, not the filename, so we strip
 * any trailing tab / space / CR before returning. Without this, the
 * SecretScanFinding.path would carry the bogus suffix and stop comments
 * would print copy-paste-broken paths.
 */
function parseDiffHeaderPath(headerValue: string): string | null {
  let value = headerValue;

  if (value.startsWith('"')) {
    // Quoted form: scan for the closing quote and unquote that span.
    // Anything after the closing quote (e.g. ` 1970-01-01 ...` timestamp
    // suffix when --raw is set) is trailing metadata and dropped.
    const closingQuote = value.lastIndexOf('"');
    if (closingQuote >= 1) {
      value = unquoteGitPath(value.slice(1, closingQuote));
    }
  } else {
    // Bare form: trim trailing tab / space / CR (timestamp delimiter,
    // accidental whitespace).
    value = value.replace(/[\t \r]+$/, "");
  }

  if (value === "/dev/null") return null;

  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  // Unrecognised shape — return as-is so additions are still collected under
  // a diagnostic label rather than dropped entirely (bypassing the scanner).
  return value;
}

/**
 * Extract per-file added content from a unified-diff stdout.
 *
 * Uses a small state machine to distinguish file-header `+++` / `---` lines
 * from real content lines that happen to start with `++` / `--`. The
 * distinction matters: a source line whose actual content begins with `++`
 * (encoded in the diff as `+++ ...`) must NOT be treated as a header — doing
 * so would silently drop the line from secret scanning.
 *
 * State transitions:
 *   - `diff --git a/<path> b/<path>` → resets to "before hunk", captures the
 *     b-side path as a tentative active path
 *   - `--- <a-path>` (only before hunk) → diff metadata, ignored
 *   - `+++ <b-path>` (only before hunk) → confirms/replaces the active path
 *   - `@@ ... @@` → switches into hunk mode; from here, `+`-prefixed lines
 *     are content, and headers do NOT recur until the next `diff --git`
 *   - `+<content>` (in hunk) → added line, accumulated under active path
 *
 * Path parsing supports git's quoted form (`+++ "b/..."`) used when the path
 * contains tabs, newlines, or non-ASCII bytes.
 *
 * Returns one target per distinct path, with `content` being the
 * newline-joined added lines (without the `+` prefix).
 */
export function extractAddedContentFromUnifiedDiff(
  diff: string
): SecretScanTarget[] {
  const additions = new Map<string, string[]>();
  let activePath: string | null = null;
  let insideHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>` — capture the b-side path. Paths with
      // spaces use the same two-token form (a/<…> b/<…>); we pick the last
      // " b/" occurrence so spaces in the path do not split the field. Quoted
      // paths (`"b/…"`) are refined when the `+++` header arrives.
      const bMarker = " b/";
      const idx = line.lastIndexOf(bMarker);
      activePath = idx >= 0 ? line.slice(idx + bMarker.length) : null;
      insideHunk = false;
      continue;
    }

    if (line.startsWith("@@")) {
      // Entering a hunk. From here, every `+`-prefixed line is content —
      // including ones that start with `++` (encoded as `+++ ...`).
      insideHunk = true;
      continue;
    }

    if (!insideHunk) {
      // Pre-hunk header zone: `+++` / `---` are file headers, never content.
      if (line.startsWith("+++ ")) {
        const value = line.slice("+++ ".length);
        const parsed = parseDiffHeaderPath(value);
        activePath = parsed; // null for /dev/null (deletion)
        continue;
      }
      if (line.startsWith("--- ")) continue;
      // Other pre-hunk metadata (`index ...`, `similarity index ...`,
      // `rename from ...`, etc.) is silently skipped.
      continue;
    }

    // Inside a hunk: classify by the leading marker only.
    if (!line.startsWith("+")) continue;
    if (activePath === null) continue;
    const added = line.slice(1);
    let bucket = additions.get(activePath);
    if (bucket === undefined) {
      bucket = [];
      additions.set(activePath, bucket);
    }
    bucket.push(added);
  }

  return Array.from(additions, ([path, lines]) => ({
    path,
    content: lines.join("\n"),
  }));
}

/**
 * Format the `Detail:` body for the `secret_leak_suspected` stop comment.
 *
 * The detail never embeds the matched value — only the pattern name and the
 * file path — so reading the stop comment cannot itself become a secret-leak
 * vector. Recovery requires `/restart-review --hard` so the leaked content
 * cannot be re-introduced by the same Codex finding hash.
 */
export function formatSecretLeakDetail(
  hardFailures: readonly SecretScanFinding[]
): string {
  const lines: string[] = [
    "Auto-fix blocked — the repair diff contained values matching high-confidence secret patterns.",
    "",
    "Detected patterns (matched values intentionally omitted from this comment):",
  ];
  for (const finding of hardFailures) {
    lines.push(`  - ${finding.pattern} in ${finding.path}`);
  }
  lines.push("");
  lines.push(
    "Recovery: review the affected files manually, remove any committed-but-leaked values, then issue `/restart-review --hard` to clear iteration history.",
  );
  lines.push("`/restart-review` (without --hard) is rejected for this stop reason to prevent the same finding hash from immediately re-triggering the leak.");
  lines.push("");
  lines.push("See docs/operations/security.md (secret-scanner ポリシー) and docs/operations/stop-and-recovery.md.");
  return lines.join("\n");
}
