import { describe, it, expect } from "vitest";
import { computeFindingsHash } from "../src/findings-hash.js";
import type { Finding } from "../src/types.js";

const baseFinding: Finding = {
  severity: "P1",
  path: "src/foo.ts",
  line: 10,
  title: "Unused variable",
  body: "Variable `x` is declared but never used.",
};

describe("computeFindingsHash", () => {
  it("returns the same hash for the same findings (deterministic)", () => {
    const findings: Finding[] = [baseFinding];
    expect(computeFindingsHash(findings)).toBe(computeFindingsHash(findings));
  });

  it("returns the same hash regardless of input order (order independent)", () => {
    const finding2: Finding = {
      severity: "P0",
      path: "src/bar.ts",
      line: 42,
      title: "Null dereference",
      body: "Potential null dereference on `obj.value`.",
    };
    const hashAB = computeFindingsHash([baseFinding, finding2]);
    const hashBA = computeFindingsHash([finding2, baseFinding]);
    expect(hashAB).toBe(hashBA);
  });

  it("returns a different hash for different findings", () => {
    const differentFinding: Finding = {
      ...baseFinding,
      body: "A completely different issue description.",
    };
    expect(computeFindingsHash([baseFinding])).not.toBe(
      computeFindingsHash([differentFinding])
    );
  });

  it("returns the same hash when only `line` differs (line excluded from key)", () => {
    const findingLine10: Finding = { ...baseFinding, line: 10 };
    const findingLine99: Finding = { ...baseFinding, line: 99 };
    expect(computeFindingsHash([findingLine10])).toBe(
      computeFindingsHash([findingLine99])
    );
  });

  it("returns the same hash for line:null and line:0 since line is excluded from the key (TY-280)", () => {
    // TY-280 surfaces `line: null` for file-level findings. `findings-hash`
    // historically excluded `line` from the key (line drifts as code is
    // edited), so `null` and `0` MUST produce the same hash — otherwise the
    // pre-TY-280 → post-TY-280 transition would falsely flag the same Codex
    // file-level finding as "new" and consume an extra iteration.
    const fileLevel: Finding = { ...baseFinding, line: null };
    const lineZero: Finding = { ...baseFinding, line: 0 };
    expect(computeFindingsHash([fileLevel])).toBe(
      computeFindingsHash([lineZero])
    );
  });

  it("returns a 16-character hex string", () => {
    const hash = computeFindingsHash([baseFinding]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
