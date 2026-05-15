import { describe, it, expect } from "vitest";
import { isLoop } from "../src/loop-detector.js";
import { computeFindingsHash } from "../src/findings-hash.js";
import type { Finding, FindingsHashEntry } from "../src/types.js";

const baseFinding: Finding = {
  severity: "P1",
  path: "src/foo.ts",
  line: 10,
  title: "Unused variable",
  body: "Variable `x` is declared but never used.",
};

const anotherFinding: Finding = {
  severity: "P0",
  path: "src/bar.ts",
  line: 42,
  title: "Null dereference",
  body: "Potential null dereference on `obj.value`.",
};

describe("isLoop", () => {
  it("returns true when the last entry's tier is escalated and hash matches", () => {
    const currentFindings: Finding[] = [baseFinding];
    const currentHash = computeFindingsHash(currentFindings);
    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: currentHash, modelTier: "escalated" },
    ];

    expect(isLoop(currentFindings, findingsHashHistory)).toBe(true);
  });

  it("returns false when the last entry's tier is base and hash matches (escalation opportunity)", () => {
    const currentFindings: Finding[] = [baseFinding];
    const currentHash = computeFindingsHash(currentFindings);
    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: currentHash, modelTier: "base" },
    ];

    expect(isLoop(currentFindings, findingsHashHistory)).toBe(false);
  });

  it("treats missing modelTier as escalated (legacy state)", () => {
    const currentFindings: Finding[] = [baseFinding];
    const currentHash = computeFindingsHash(currentFindings);
    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: currentHash },
    ];

    expect(isLoop(currentFindings, findingsHashHistory)).toBe(true);
  });

  it("returns true for oscillation (A→B→A pattern)", () => {
    const findingsA: Finding[] = [baseFinding];
    const findingsB: Finding[] = [anotherFinding];

    const hashA = computeFindingsHash(findingsA);
    const hashB = computeFindingsHash(findingsB);

    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: hashA, modelTier: "base" },
      { iteration: 2, hash: hashB, modelTier: "base" },
    ];

    // At iteration 3, we see findings A again — non-last match means real loop
    // regardless of the last entry's tier.
    expect(isLoop(findingsA, findingsHashHistory)).toBe(true);
  });

  it("returns true when current hash matches an older entry even if last entry is base with a different hash", () => {
    const findingsA: Finding[] = [baseFinding];
    const findingsB: Finding[] = [anotherFinding];

    const hashA = computeFindingsHash(findingsA);
    const hashB = computeFindingsHash(findingsB);

    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: hashA, modelTier: "escalated" },
      { iteration: 2, hash: hashB, modelTier: "base" },
    ];

    expect(isLoop(findingsA, findingsHashHistory)).toBe(true);
  });

  it("returns false when current findings hash does not match any hash in history", () => {
    const currentFindings: Finding[] = [baseFinding];
    const differentFinding: Finding = {
      ...baseFinding,
      body: "A completely different issue.",
    };
    const differentHash = computeFindingsHash([differentFinding]);

    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: differentHash, modelTier: "base" },
    ];

    expect(isLoop(currentFindings, findingsHashHistory)).toBe(false);
  });

  it("returns false when history is empty", () => {
    const currentFindings: Finding[] = [baseFinding];
    const findingsHashHistory: FindingsHashEntry[] = [];

    expect(isLoop(currentFindings, findingsHashHistory)).toBe(false);
  });

  it("base → escalated retry chain: escalated repeat stops on the next match", () => {
    const findings: Finding[] = [baseFinding];
    const hash = computeFindingsHash(findings);

    // After the base-tier retry has been promoted, the same hash recorded at
    // the escalated tier means we are out of escalation steps.
    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash, modelTier: "base" },
      { iteration: 2, hash, modelTier: "escalated" },
    ];

    expect(isLoop(findings, findingsHashHistory)).toBe(true);
  });
});
