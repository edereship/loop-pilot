import { describe, it, expect } from "vitest";
import { computeFindingsHash } from "../src/findings-hash.js";
import type { Finding } from "../src/types.js";

const baseFinding: Finding = {
  severity: "P1",
  commentId: 1001,
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
      commentId: 1002,
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

  // TY-305: Codex re-renders the same logical finding with cosmetic whitespace
  // drift (CRLF↔LF, trailing line whitespace, outer trim) between iterations.
  // The hash must treat those as the same body so loop detection still fires.
  describe("TY-305: body whitespace normalization", () => {
    it("#A: trailing newline does not affect the hash", () => {
      const withoutNewline: Finding = { ...baseFinding, body: "foo bar" };
      const withNewline: Finding = { ...baseFinding, body: "foo bar\n" };
      expect(computeFindingsHash([withoutNewline])).toBe(
        computeFindingsHash([withNewline]),
      );
    });

    it("#B: CRLF vs LF line endings produce the same hash", () => {
      const lf: Finding = { ...baseFinding, body: "foo\nbar" };
      const crlf: Finding = { ...baseFinding, body: "foo\r\nbar" };
      expect(computeFindingsHash([lf])).toBe(computeFindingsHash([crlf]));
    });

    it("#C: trailing per-line whitespace does not affect the hash", () => {
      const trimmed: Finding = { ...baseFinding, body: "foo bar\nbaz" };
      const trailingSpaces: Finding = {
        ...baseFinding,
        body: "foo bar  \nbaz",
      };
      expect(computeFindingsHash([trimmed])).toBe(
        computeFindingsHash([trailingSpaces]),
      );
    });

    it("#D: internal whitespace runs (inside a line) are preserved as distinct", () => {
      // Code snippets / stack-trace indentation must stay distinguishable —
      // we only normalize *edge* whitespace, not internal runs. A body
      // with double-space inside a line is a different finding from one
      // with single-space.
      const singleSpace: Finding = { ...baseFinding, body: "foo bar" };
      const doubleSpace: Finding = { ...baseFinding, body: "foo  bar" };
      expect(computeFindingsHash([singleSpace])).not.toBe(
        computeFindingsHash([doubleSpace]),
      );
    });
  });

  // TY-307: Codex reports the same logical issue at two anchors (same body,
  // different lines). Dropping the Set dedup keeps both as separate hash
  // entries so a 2-finding iteration and the 1-finding iteration left after
  // one is fixed hash differently — preventing a phantom `loop_detected`.
  describe("TY-307: per-line finding count is preserved", () => {
    const anchorA: Finding = { ...baseFinding, line: 10, body: "use let" };
    const anchorB: Finding = { ...baseFinding, line: 50, body: "use let" };

    it("#A: two same-body anchors hash differently from one of them alone", () => {
      expect(computeFindingsHash([anchorA, anchorB])).not.toBe(
        computeFindingsHash([anchorB]),
      );
    });

    it("#B: a single finding's hash is unaffected by its line (line still excluded)", () => {
      expect(computeFindingsHash([anchorA])).toBe(
        computeFindingsHash([anchorB]),
      );
    });

    it("#C: a duplicated finding hashes differently from a single one (count matters)", () => {
      const single: Finding = { ...baseFinding, line: 10, body: "use let" };
      expect(computeFindingsHash([single, single])).not.toBe(
        computeFindingsHash([single]),
      );
    });

    it("#D: order remains irrelevant across different paths", () => {
      const inFoo: Finding = { ...baseFinding, path: "src/foo.ts", body: "use let" };
      const inBar: Finding = { ...baseFinding, path: "src/bar.ts", body: "use let" };
      expect(computeFindingsHash([inFoo, inBar])).toBe(
        computeFindingsHash([inBar, inFoo]),
      );
    });
  });
});
