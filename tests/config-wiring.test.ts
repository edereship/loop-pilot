import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Config-wiring matrix guards (companion to reusable-workflows.test.ts).
//
// These enforce the end-to-end invariant the config-wiring audit checks: a
// value an operator can set (Repository variable / action input), and that the
// docs tell them to set, must reach the code that reads it — across
// L5 reusable workflow → L4 composite → L3 sub-action → L2 src/config.ts →
// L1 consumer. Every precedent (TY-335 / TY-337 / TY-350) re-broke because
// nothing failed CI on the full matrix; these tests are that backstop.

const configSrc = readFileSync("src/config.ts", "utf8");
const loopReusable = readFileSync(".github/workflows/loop.yml", "utf8");
const loopComposite = readFileSync("loop/action.yml", "utf8");
const securityDoc = readFileSync("docs/operations/security.md", "utf8");
const readmeEn = readFileSync("README.md", "utf8");
const readmeJa = readFileSync("README.ja.md", "utf8");

// Concatenate every src module EXCEPT config.ts (the definition site) so we can
// detect config fields that are loaded but consumed by nobody.
const srcConsumerBlob = readdirSync("src")
  .filter((f) => f.endsWith(".ts") && f !== "config.ts")
  .map((f) => readFileSync(`src/${f}`, "utf8"))
  .join("\n");

/** Property names declared on an exported interface in src/config.ts. */
function interfaceFields(interfaceName: string): string[] {
  const start = configSrc.indexOf(`export interface ${interfaceName} {`);
  if (start === -1) throw new Error(`interface ${interfaceName} not found`);
  const body = configSrc.slice(start, configSrc.indexOf("\n}", start));
  // Field lines are indented exactly two spaces; JSDoc lines (`   *`) are not.
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]);
}

describe("config-wiring: no dead config field (L2 loaded → L1 consumed)", () => {
  // Credentials are loaded + validated inside config.ts (the auth xor) and
  // forwarded to anthropics/claude-code-action via loop/action.yml `with:`,
  // never read back through the config object — so they are intentionally not
  // consumed as `config.<field>`. Everything else MUST have a consumer.
  const YAML_FORWARDED_CREDENTIALS = new Set([
    "anthropicApiKey",
    "claudeCodeOauthToken",
  ]);

  it("every BaseConfig / ClaudeAuthConfig field is read by some entrypoint or helper", () => {
    const fields = [
      ...interfaceFields("BaseConfig"),
      ...interfaceFields("ClaudeAuthConfig"),
    ];
    // Sanity: extraction works and found a realistic field count.
    expect(fields.length).toBeGreaterThan(20);

    const dead = fields.filter(
      (f) =>
        !YAML_FORWARDED_CREDENTIALS.has(f) &&
        !new RegExp(`\\.${f}\\b`).test(srcConsumerBlob),
    );
    expect(dead).toEqual([]);
  });
});

describe("config-wiring: composite forwards every operator input (TY-335 / TY-337 / TY-350)", () => {
  it("each input loop.yml passes to loop@v1 is declared AND referenced by loop/action.yml", () => {
    const stepIdx = loopReusable.indexOf("uses: edereship/loop-pilot/loop@v1");
    expect(stepIdx).toBeGreaterThan(-1);
    const after = loopReusable.slice(stepIdx);
    const withIdx = after.indexOf("\n        with:");
    const nextStepIdx = after.indexOf("\n      - name:", withIdx);
    const withBlock = after.slice(
      withIdx,
      nextStepIdx === -1 ? undefined : nextStepIdx,
    );
    // `with:` keys are indented exactly ten spaces.
    const keys = [
      ...withBlock.matchAll(/^ {10}([a-z][a-z0-9-]+):/gm),
    ].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);

    const cutWires = keys.filter(
      (k) =>
        !loopComposite.includes(`\n  ${k}:`) || // declared as a composite input
        !loopComposite.includes(`inputs.${k}`), // forwarded / consumed inline
    );
    expect(cutWires).toEqual([]);
  });
});

describe("config-wiring: docs never steer operators at removed inputs (TY-350)", () => {
  // These scope inputs were removed in v1.1.0 because they were never wired
  // from the reusable workflow into the composite (TY-350). Only scope-policy.md
  // (the migration note) may mention them; an operational doc that recommends
  // one as a live option is a broken recovery path.
  const REMOVED_SCOPE_INPUTS = [
    "scope-additional-hard-block-prefixes",
    "scope-allowed-path-prefixes",
    "looppilot-hard-block-override",
  ];

  it("security.md does not present a removed scope input as a live remediation", () => {
    const present = REMOVED_SCOPE_INPUTS.filter((name) =>
      securityDoc.includes(name),
    );
    expect(present).toEqual([]);
  });
});

describe("config-wiring: README EN/JA variable tables stay in sync", () => {
  function tableVariables(md: string, header: string): Set<string> {
    const start = md.indexOf(header);
    if (start === -1) throw new Error(`table header not found: ${header}`);
    // Walk contiguous table rows from the header until the first non-`|` line
    // (the blank line that ends the table), so unrelated later tables — e.g.
    // the secrets table — are not swept in.
    const lines = md.slice(start).split("\n");
    const vars = new Set<string>();
    for (let i = 2; i < lines.length; i++) {
      // i=0 header, i=1 the |---| separator; rows start at i=2.
      if (!lines[i].startsWith("|")) break;
      const m = lines[i].match(/^\|\s*`([A-Z][A-Z0-9_]+)`/);
      if (m) vars.add(m[1]);
    }
    return vars;
  }

  it("README.ja documents every variable README.md documents", () => {
    const en = tableVariables(readmeEn, "| Variable | Default |");
    const ja = tableVariables(readmeJa, "| Variable | デフォルト |");
    const missingInJa = [...en].filter((v) => !ja.has(v));
    expect(missingInJa).toEqual([]);
  });

  it("both READMEs document the functional CLAUDE_CODE_MAX_TURNS knob", () => {
    expect(readmeEn).toContain("CLAUDE_CODE_MAX_TURNS");
    expect(readmeJa).toContain("CLAUDE_CODE_MAX_TURNS");
  });
});
