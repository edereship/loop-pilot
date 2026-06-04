import { describe, it, expect } from "vitest";
import { isLoop } from "../src/loop-detector.js";
import { computeFindingsHash } from "../src/findings-hash.js";
import {
  createInitialState,
  deserializeState,
  serializeState,
} from "../src/state-manager.js";
import type { Finding, FindingsHashEntry } from "../src/types.js";

const baseFinding: Finding = {
  severity: "P1",
  commentId: 1001,
  path: "src/foo.ts",
  line: 10,
  title: "Unused variable",
  body: "Variable `x` is declared but never used.",
};

const anotherFinding: Finding = {
  severity: "P0",
  commentId: 1002,
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

  it("TY-305 #F: detects a loop across Codex cosmetic whitespace re-renders of the same finding", () => {
    // Codex emitted findings A at iteration 1 (base) and iteration 2
    // (escalated). At iteration 3 it re-renders the same logical finding
    // with cosmetic whitespace drift (trailing newline + CRLF) — without
    // body whitespace normalization those would hash differently and
    // `isLoop` would return false, burning iterations until max_iterations.
    // With TY-305 normalization the hash matches and the second escalated
    // observation correctly trips `loop_detected`.
    const original: Finding = { ...baseFinding, body: "foo bar" };
    const cosmeticDrift: Finding = {
      ...baseFinding,
      body: "foo bar  \r\n",
    };

    const originalHash = computeFindingsHash([original]);
    const driftHash = computeFindingsHash([cosmeticDrift]);
    // Sanity check: the normalization actually collapses the two bodies.
    expect(originalHash).toBe(driftHash);

    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: originalHash, modelTier: "base" },
      { iteration: 2, hash: originalHash, modelTier: "escalated" },
    ];

    expect(isLoop([cosmeticDrift], findingsHashHistory)).toBe(true);
  });

  it("TY-307 #E: no phantom loop when one of two same-body anchors is fixed", () => {
    // Codex reported the same logical issue at two anchors (same body,
    // different lines). The prior iteration recorded that 2-finding set; the
    // agent fixed one anchor, so this iteration carries a single finding.
    // Before the Set-dedup removal both sets hashed to H1 and — with the last
    // entry at the escalated tier — `isLoop` falsely returned true even though
    // real progress was made. With distinct hashes there is no match.
    const anchorA: Finding = { ...baseFinding, line: 10, body: "use let" };
    const anchorB: Finding = { ...baseFinding, line: 50, body: "use let" };

    const twoAnchorHash = computeFindingsHash([anchorA, anchorB]);
    const findingsHashHistory: FindingsHashEntry[] = [
      { iteration: 1, hash: twoAnchorHash, modelTier: "escalated" },
    ];

    expect(isLoop([anchorB], findingsHashHistory)).toBe(false);
  });

  it("TY-296: detects an A→B→C→D→A cycle after the history has been persisted through serializeState", () => {
    // Regression for TY-296: with MAX_HISTORY_ENTRIES=3 the original A was
    // trimmed before the cycle closed, so `isLoop` returned false and the
    // workflow burned every iteration at the base tier until `max_iterations`.
    // The post-fix history must round-trip through serialize/deserialize
    // (matching the real on-PR lifecycle) before the loop check runs.
    const findingsA: Finding[] = [baseFinding];
    const findingsB: Finding[] = [anotherFinding];
    const findingsC: Finding[] = [{ ...baseFinding, path: "src/c.ts", title: "C" }];
    const findingsD: Finding[] = [{ ...baseFinding, path: "src/d.ts", title: "D" }];

    const hashA = computeFindingsHash(findingsA);
    const hashB = computeFindingsHash(findingsB);
    const hashC = computeFindingsHash(findingsC);
    const hashD = computeFindingsHash(findingsD);

    const persisted = serializeState({
      ...createInitialState(),
      findingsHashHistory: [
        { iteration: 1, hash: hashA, modelTier: "base" },
        { iteration: 2, hash: hashB, modelTier: "base" },
        { iteration: 3, hash: hashC, modelTier: "base" },
        { iteration: 4, hash: hashD, modelTier: "base" },
      ],
    });
    const restored = deserializeState(persisted);
    expect(restored).not.toBeNull();

    // iter 5 sees findings A again — must be classified as a real loop now
    // that history is no longer prematurely trimmed.
    expect(isLoop(findingsA, restored!.findingsHashHistory)).toBe(true);
  });
});
