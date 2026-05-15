import { describe, expect, it } from "vitest";
import {
  BASELINE_BASH_ALLOWED_TOOLS,
  CHECK_COMMAND_BINARY_WHITELIST,
  deriveAllowedBashTools,
  serializeAllowedBashTools,
  validateCheckCommand,
} from "../src/check-command-allowlist.js";

describe("validateCheckCommand", () => {
  it.each([
    "npm run check",
    "pnpm run check",
    "pnpm test",
    "yarn run check",
    "yarn test --coverage",
    "bun test",
    "pytest tests/",
    "pytest -xvs tests/foo",
    "make check",
    "make test:unit",
    "python -m pytest",
    "python3 -m unittest",
    "cargo test",
    "go test ./...",
    "mise run check",
    "task check",
    "just check",
    "npx vitest run",
  ])("accepts safe command: %s", (cmd) => {
    expect(validateCheckCommand(cmd)).toEqual({ ok: true });
  });

  it.each([
    "",
    "   ",
    "rm -rf /",
    "curl http://evil.example",
    "sh -c 'echo hi'",
    "bash -c whoami",
    "eval echo hi",
    "unknown-tool run check",
  ])("rejects command whose first token is not whitelisted: %s", (cmd) => {
    const result = validateCheckCommand(cmd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it.each([
    "npm run check; rm -rf /",
    "npm run check && npm test",
    "npm run check || echo failed",
    "npm run check | tee log",
    "npm run check > /tmp/out",
    "npm run check < input",
    "npm run `id`",
    "npm run $(whoami)",
    "npm run $USER",
    'npm run "check"',
    "npm run 'check'",
    "npm run check\nrm -rf /",
    "npm run check,Bash(rm -rf /)",
    "npm run check\\",
    "npm run check*",
    "npm run check?",
    "npm run (check)",
  ])("rejects command with shell metacharacters: %s", (cmd) => {
    const result = validateCheckCommand(cmd);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateCheckCommand("  npm run check  ")).toEqual({ ok: true });
  });
});

describe("deriveAllowedBashTools", () => {
  it("returns baseline plus the exact CHECK_COMMAND when whitelisted", () => {
    const result = deriveAllowedBashTools("pnpm run check");
    expect(result.rejection).toBeNull();
    expect(result.tools).toEqual([
      ...BASELINE_BASH_ALLOWED_TOOLS,
      "Bash(pnpm run check)",
    ]);
  });

  it("avoids duplicating when CHECK_COMMAND is already in the baseline", () => {
    const result = deriveAllowedBashTools("npm run check");
    expect(result.rejection).toBeNull();
    expect(result.tools).toEqual([...BASELINE_BASH_ALLOWED_TOOLS]);
  });

  it("trims CHECK_COMMAND before promoting", () => {
    const result = deriveAllowedBashTools("  pytest tests/  ");
    expect(result.rejection).toBeNull();
    expect(result.tools.at(-1)).toBe("Bash(pytest tests/)");
  });

  it("returns baseline only and surfaces a rejection reason on unsafe input", () => {
    const result = deriveAllowedBashTools("npm run check; rm -rf /");
    expect(result.tools).toEqual([...BASELINE_BASH_ALLOWED_TOOLS]);
    expect(result.rejection).toMatch(/safe set/i);
  });

  it("rejects empty CHECK_COMMAND without throwing", () => {
    const result = deriveAllowedBashTools("");
    expect(result.tools).toEqual([...BASELINE_BASH_ALLOWED_TOOLS]);
    expect(result.rejection).toMatch(/empty/i);
  });

  it("rejects commands whose binary is not in the whitelist", () => {
    const result = deriveAllowedBashTools("docker run foo");
    expect(result.rejection).toMatch(/'docker'/);
    expect(result.tools).toEqual([...BASELINE_BASH_ALLOWED_TOOLS]);
  });

  it("covers every binary in the whitelist", () => {
    for (const binary of CHECK_COMMAND_BINARY_WHITELIST) {
      const result = deriveAllowedBashTools(`${binary} run check`.trim());
      expect(result.rejection, `expected ${binary} to be accepted`).toBeNull();
    }
  });
});

describe("serializeAllowedBashTools", () => {
  it("joins entries with a comma and no spaces", () => {
    expect(serializeAllowedBashTools(["Bash(npm ci)", "Bash(git log)"])).toBe(
      "Bash(npm ci),Bash(git log)",
    );
  });

  it("returns an empty string for an empty list", () => {
    expect(serializeAllowedBashTools([])).toBe("");
  });
});
