import { describe, expect, it } from "vitest";
import {
  extractAddedContentFromUnifiedDiff,
  formatSecretLeakDetail,
  scanForSecrets,
  type SecretScanFinding,
} from "../src/secret-scanner.js";

/**
 * Fixture builders for secret-shaped strings.
 *
 * The literals are split with `+` so this source file never contains a
 * contiguous match for the scanner's own regexes. Without this, post-fix
 * scanning of `tests/secret-scanner.test.ts` would self-match every fixture
 * the moment claude-code-action touches the file (the diff would treat the
 * rewritten lines as additions). The reassembled runtime string still feeds
 * the scanner correctly — only the *source representation* avoids the
 * literal sequence.
 */
const FAKE_GHP_CLASSIC = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
const FAKE_GHU = "g" + "hu_abcdefghijklmnopqrstuv0123456789";
const FAKE_GHS = "g" + "hs_abcdefghijklmnopqrstuv0123456789";
const FAKE_GHR = "g" + "hr_abcdefghijklmnopqrstuvwx0123456789";
const FAKE_GITHUB_FINE_PAT =
  "g" + "ithub_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
const FAKE_ANTHROPIC_KEY =
  "s" + "k-ant-api03-abcdefghijklmnopqrstuvwx0123456789";
const FAKE_SLACK_BOT = "x" + "oxb-1234567890-abcdefghijklmnopqr";
const FAKE_AWS_AKIA = "AKI" + "AABCDEFGHIJKLMNOP";
const PEM_BEGIN = "----" + "-BEGIN";
const PEM_END = "----" + "-END";
function pemHeader(label: string): string {
  return `${PEM_BEGIN} ${label}-----`;
}
function pemFooter(label: string): string {
  return `${PEM_END} ${label}-----`;
}

describe("scanForSecrets — hard-fail patterns", () => {
  it("detects GitHub classic personal access tokens (ghp_…)", () => {
    const result = scanForSecrets([
      { path: "src/leak.ts", content: `const t = '${FAKE_GHP_CLASSIC}';` },
    ]);
    expect(result.hardFailures.map((f) => f.pattern)).toContain("github-pat-classic");
    expect(result.hardFailures.map((f) => f.path)).toContain("src/leak.ts");
  });

  it("detects GitHub user / server tokens (ghu_…, ghs_…)", () => {
    const ghu = scanForSecrets([{ path: "src/a.ts", content: FAKE_GHU }]);
    const ghs = scanForSecrets([{ path: "src/b.ts", content: FAKE_GHS }]);
    expect(ghu.hardFailures.length).toBeGreaterThan(0);
    expect(ghs.hardFailures.length).toBeGreaterThan(0);
  });

  it("detects Anthropic / OpenAI API keys (sk-…)", () => {
    const result = scanForSecrets([
      { path: "src/ai.ts", content: `const key = '${FAKE_ANTHROPIC_KEY}'` },
    ]);
    expect(result.hardFailures.map((f) => f.pattern)).toContain(
      "anthropic-or-openai-api-key"
    );
  });

  it("detects Slack bot / user tokens (xoxb-/xoxp-)", () => {
    const result = scanForSecrets([
      { path: "src/slack.ts", content: FAKE_SLACK_BOT },
    ]);
    expect(result.hardFailures.map((f) => f.pattern)).toContain("slack-token");
  });

  it("detects AWS access key IDs", () => {
    const result = scanForSecrets([
      { path: "infra/keys.ts", content: `AWS_ACCESS_KEY_ID=${FAKE_AWS_AKIA}` },
    ]);
    expect(result.hardFailures.map((f) => f.pattern)).toContain("aws-access-key-id");
  });

  it("detects PEM private key blocks (RSA / EC / OPENSSH / ENCRYPTED PRIVATE)", () => {
    for (const label of [
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "PRIVATE KEY",
    ]) {
      const result = scanForSecrets([
        { path: "deploy/id_rsa", content: `${pemHeader(label)}\n...\n` },
      ]);
      expect(
        result.hardFailures.map((f) => f.pattern),
        `should match for header: ${label}`,
      ).toContain("private-key-block");
    }
  });

  it("does NOT hard-fail on PUBLIC KEY blocks (TY-274 follow-up — public material is safe)", () => {
    const publicBlock = [
      pemHeader("PUBLIC KEY"),
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…",
      pemFooter("PUBLIC KEY"),
    ].join("\n");
    const result = scanForSecrets([{ path: "src/key.pub", content: publicBlock }]);
    expect(result.hardFailures.map((f) => f.pattern)).not.toContain(
      "private-key-block",
    );
  });

  it("detects fine-grained PATs (github_pat_…) and refresh tokens (ghr_…) (TY-274 follow-up)", () => {
    const finePat = scanForSecrets([
      { path: "src/a.ts", content: `GITHUB_TOKEN=${FAKE_GITHUB_FINE_PAT}` },
    ]);
    expect(finePat.hardFailures.map((f) => f.pattern)).toContain(
      "github-fine-grained-pat",
    );
    const refresh = scanForSecrets([
      { path: "src/b.ts", content: FAKE_GHR },
    ]);
    expect(refresh.hardFailures.map((f) => f.pattern)).toContain(
      "github-refresh-token",
    );
  });

  it("detects the base64 git checkout credential (.git/config x-access-token blob)", () => {
    // base64("x-access-token:ghs_<token>") — the form actions/checkout persists
    // into .git/config; an IPI-driven agent could read it and commit it to
    // exfiltrate the workflow GITHUB_TOKEN past the raw-prefix patterns.
    const leaked = Buffer.from(
      "x-access-token:ghs_AbCdEf1234567890AbCdEf1234567890",
    ).toString("base64");
    const result = scanForSecrets([
      { path: "src/leak.ts", content: `const h = "AUTHORIZATION: basic ${leaked}";` },
    ]);
    expect(result.hardFailures.map((f) => f.pattern)).toContain(
      "git-checkout-basic-auth",
    );
  });

  it("does not hard-fail on unrelated base64 that is not an x-access-token credential", () => {
    const benign = Buffer.from("hello world this is just some text").toString("base64");
    const result = scanForSecrets([{ path: "src/ok.ts", content: `const b = "${benign}";` }]);
    expect(result.hardFailures.map((f) => f.pattern)).not.toContain(
      "git-checkout-basic-auth",
    );
  });

  it("does not hard-fail on clean source code", () => {
    const clean = `
      import { foo } from "./bar.js";
      export function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const result = scanForSecrets([{ path: "src/ok.ts", content: clean }]);
    expect(result.hardFailures).toHaveLength(0);
  });
});

describe("scanForSecrets — warning patterns", () => {
  it("emits a warning for credential assignments", () => {
    const result = scanForSecrets([
      {
        path: "config/staging.ts",
        content: 'export const db = { password: "swordfish-prod" };',
      },
    ]);
    expect(result.warnings.map((f) => f.pattern)).toContain("credential-assignment");
    expect(result.hardFailures).toHaveLength(0);
  });

  it("emits a warning for high-entropy long strings", () => {
    // 40 chars, mixed case + digits, no metacharacters → matches the broad
    // [A-Za-z0-9_-]{32,} warning pattern.
    const blob = "Ab12CdEfGh34IjKlMnOp56QrStUvWxYz_a-b-c-d";
    const result = scanForSecrets([{ path: "src/blob.ts", content: blob }]);
    expect(result.warnings.map((f) => f.pattern)).toContain(
      "high-entropy-long-string"
    );
  });

  it("does not warn on short identifiers", () => {
    const result = scanForSecrets([
      { path: "src/short.ts", content: "const x = 'abc123';" },
    ]);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("scanForSecrets — input handling", () => {
  it("skips empty-content targets without producing findings", () => {
    const result = scanForSecrets([
      { path: "src/empty.ts", content: "" },
      { path: "src/also-empty.ts", content: "" },
    ]);
    expect(result.hardFailures).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("reports one finding per matching pattern per file (no duplicates per occurrence)", () => {
    // The same hard-fail prefix appears twice in the same file — we expect a
    // single finding, not two, so a single file cannot flood the stop comment.
    const ghpA = "g" + "hp_aaaaaaaaaaaaaaaaaaaa";
    const ghpB = "g" + "hp_bbbbbbbbbbbbbbbbbbbb";
    const twice = `${ghpA}\n${ghpB}\n`;
    const result = scanForSecrets([{ path: "src/dup.ts", content: twice }]);
    const ghpFindings = result.hardFailures.filter(
      (f) => f.pattern === "github-pat-classic"
    );
    expect(ghpFindings).toHaveLength(1);
  });
});

describe("extractAddedContentFromUnifiedDiff (TY-274 follow-up — diff-based scanning)", () => {
  it("returns only added lines, dropped per file, with `+` prefix stripped", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,3 @@",
      " const stays = 1;",
      "+const added = 'new';",
      "-const removed = 'old';",
      "+const alsoAdded = 2;",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toEqual([
      { path: "src/foo.ts", content: "const added = 'new';\nconst alsoAdded = 2;" },
    ]);
  });

  it("groups additions by file across multiple `diff --git` blocks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+line A",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "+line B",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.path === "src/a.ts")?.content).toBe("line A");
    expect(targets.find((t) => t.path === "src/b.ts")?.content).toBe("line B");
  });

  it("never treats `+++` / `---` headers as added content (regression guard)", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "+real content",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    // Header strings (with leading `+++ `, `--- `) must NOT bleed into content
    // — that would let a path containing a secret-shaped substring trigger
    // the scanner on its own filename.
    for (const t of targets) {
      expect(t.content).not.toContain("+++ ");
      expect(t.content).not.toContain("--- ");
    }
  });

  it("ignores `+++ /dev/null` and stops attributing added lines to a now-deleted file", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-stale line",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toEqual([]);
  });

  it("returns an empty array for an empty diff (no false-positive scan input)", () => {
    expect(extractAddedContentFromUnifiedDiff("")).toEqual([]);
  });

  it("treats `+++` inside a hunk as an added content line, not a file header (Codex P1 r3256339473)", () => {
    // A real source line whose actual text starts with `++` is encoded in
    // unified diff as `+++ ...` (the leading `+` marks "added", the rest is
    // verbatim content). Previously the parser saw `+++ ` and skipped the
    // line as a header, creating a bypass where a hard-fail secret could
    // ride into the repo on a `++`-prefixed line.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1,2 @@",
      " const stays = 1;",
      `+++ const t = '${fakeGhp}'; // line content starts with ++`,
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("src/foo.ts");
    // The leading `+` marker is stripped, leaving the original `++ const ...`
    // payload — which scanForSecrets must see so the hard-fail pattern matches.
    expect(targets[0]!.content).toContain(`++ const t = '${fakeGhp}';`);
  });

  it("parses git-quoted `+++ \"b/...\"` paths (Codex P1 r3256339474)", () => {
    // Git wraps paths in double-quotes when they contain tabs, newlines, or
    // non-ASCII bytes. Without quote handling, activePath stayed null and the
    // added lines were dropped — a tracked file with a non-ASCII name could
    // hide secret-shaped content with no scanner coverage.
    const diff = [
      'diff --git "a/docs/設定.md" "b/docs/設定.md"',
      '--- "a/docs/設定.md"',
      '+++ "b/docs/設定.md"',
      "@@ -1 +1 @@",
      "+leaked content for a quoted path",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.content).toBe("leaked content for a quoted path");
    // Path is unquoted and the leading "b/" stripped.
    expect(targets[0]!.path).toBe("docs/設定.md");
  });

  it("handles git-quoted paths with C-style escape sequences", () => {
    // Tab in the path: encoded as `\t`, wrapped in quotes.
    const diff = [
      'diff --git "a/has\\ttab.md" "b/has\\ttab.md"',
      '+++ "b/has\\ttab.md"',
      "@@ -0,0 +1 @@",
      "+content",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("has\ttab.md");
  });

  it("treats pure renames (no `--no-renames`) as zero added content (Codex P2 r3256339479)", () => {
    // With git's default rename detection, a pure rename emits the
    // `rename from`/`rename to` metadata block and no `+`/`-` lines for the
    // unchanged content. The scanner must therefore see ZERO additions for
    // such a file, even if the original body contained a hard-fail token —
    // otherwise renaming a file with a pre-existing secret-shaped fixture
    // would falsely re-flag it as a fresh leak.
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toEqual([]);
  });

  it("scans only the modified hunks of a rename-with-edits (default rename detection)", () => {
    // A rename combined with edits emits `--- a/<old>` / `+++ b/<new>`
    // headers and `+`/`-` lines for the actual diff. Only the +lines count
    // as additions; the rename metadata itself must not contaminate output.
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 92%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toEqual([{ path: "new.ts", content: "new line" }]);
  });

  it("TY-287 #2: low-similarity rename-with-edits (caught by --find-renames=20%) emits only changed lines, not pre-existing secret-shaped fixture content", () => {
    // Scenario: claude-code-action renames a JSON fixture and rewrites
    // ~70% of it. With git's default 50% threshold the change would have
    // been split into delete (`old.json`) + add (`new.json`), and the
    // add side would replay every pre-existing secret-shaped sample line
    // — hard-failing the scanner. With `--find-renames=20%` (TY-287 #2),
    // git keeps the same `rename from`/`rename to` shape it uses for
    // higher-similarity renames, so only the genuinely changed +lines
    // surface as additions and the fixture's pre-existing
    // `ghp_…`-style line stays out of the scan input.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const diff = [
      "diff --git a/tests/fixtures/old-config.json b/tests/fixtures/refactored-config.json",
      "similarity index 28%",
      "rename from tests/fixtures/old-config.json",
      "rename to tests/fixtures/refactored-config.json",
      "--- a/tests/fixtures/old-config.json",
      "+++ b/tests/fixtures/refactored-config.json",
      "@@ -3,1 +3,1 @@",
      // The pre-existing fake-PAT line stays in the file but is unchanged,
      // so it appears as context (not present in --unified=0 output) — the
      // important thing is that it does NOT appear as a `+` line. The only
      // emitted hunk is the rewritten section.
      `-  "label": "${fakeGhp}-old-value"`,
      `+  "label": "${fakeGhp}-new-value"`,
    ].join("\n");

    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe(
      "tests/fixtures/refactored-config.json",
    );
    // Only the single `+` line surfaces. The pre-existing `-`-side line is
    // dropped; without the rename header (i.e., if git had emitted
    // delete+add instead), the entire file body would have shown up here.
    expect(targets[0]!.content).toBe(
      `  "label": "${fakeGhp}-new-value"`,
    );
  });

  it("strips trailing tab / whitespace from unquoted header paths (Codex P3 r3256517019)", () => {
    // Git emits `+++ b/<path>\t<timestamp>` when the path has spaces or when
    // certain diff drivers add a timestamp. The trailing tab and anything
    // after must NOT be carried into `SecretScanFinding.path`, otherwise
    // operators copying the path from a stop comment hit a non-existent
    // filename.
    const diff = [
      "diff --git a/foo bar.txt b/foo bar.txt",
      "--- a/foo bar.txt\t",
      "+++ b/foo bar.txt\t",
      "@@ -1 +1 @@",
      "+leak",
    ].join("\n");
    const targets = extractAddedContentFromUnifiedDiff(diff);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("foo bar.txt"); // no trailing whitespace
    expect(targets[0]!.path).not.toMatch(/[\t \r]$/);
    expect(targets[0]!.content).toBe("leak");
  });
});

describe("formatSecretLeakDetail", () => {
  it("lists each finding but never includes the matched value", () => {
    const findings: SecretScanFinding[] = [
      { pattern: "github-pat-classic", severity: "hard", path: "src/leak.ts" },
      { pattern: "private-key-block", severity: "hard", path: "deploy/id_rsa" },
    ];
    const detail = formatSecretLeakDetail(findings);
    expect(detail).toContain("github-pat-classic in src/leak.ts");
    expect(detail).toContain("private-key-block in deploy/id_rsa");
    // The detail must be safe to copy-paste — no matched value bytes inside.
    expect(detail).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(detail).not.toMatch(/BEGIN .*KEY/);
  });

  it("instructs operators to use `/restart-review --hard` for recovery", () => {
    const detail = formatSecretLeakDetail([
      { pattern: "aws-access-key-id", severity: "hard", path: "infra/keys.ts" },
    ]);
    expect(detail).toMatch(/restart-review --hard/);
    expect(detail).toMatch(/secret-scanner ポリシー|stop-and-recovery/);
  });
});
