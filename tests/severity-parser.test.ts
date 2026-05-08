import { describe, it, expect } from "vitest";
import codexFixtures from "./fixtures/codex-inline-comments.json";
import { parseSeverity } from "../src/severity-parser";

describe("parseSeverity", () => {
  // --- Stage 1: bare or bracketed badge ---

  it('parses "P0 Title" → P0, "Title"', () => {
    const result = parseSeverity("P0 Title");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title");
  });

  it('parses "[P1] Title" → P1, "Title"', () => {
    const result = parseSeverity("[P1] Title");
    expect(result.severity).toBe("P1");
    expect(result.title).toBe("Title");
  });

  it('parses "[P0]Title" (no space) → P0, "Title"', () => {
    const result = parseSeverity("[P0]Title");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title");
  });

  it('parses "P2 Low priority" → P2', () => {
    const result = parseSeverity("P2 Low priority");
    expect(result.severity).toBe("P2");
    expect(result.title).toBe("Low priority");
  });

  // --- Stage 2: Markdown bold ---

  it('parses "**P0** Title" → P0, "Title"', () => {
    const result = parseSeverity("**P0** Title");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title");
  });

  it('parses "**[P0]** Title" → P0, "Title"', () => {
    const result = parseSeverity("**[P0]** Title");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title");
  });

  it("parses Codex image badge comments including P2", () => {
    const raw =
      "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Reject soft restart for exhausted/looped states**\n\nThe restart can stop again immediately.\n\nUseful? React with 👍 / 👎.";

    const result = parseSeverity(raw);

    expect(result.severity).toBe("P2");
    expect(result.title).toBe("Reject soft restart for exhausted/looped states");
    expect(result.body).toBe("The restart can stop again immediately.");
  });

  // --- Preprocessing: leading whitespace/newlines ---

  it('strips leading whitespace before matching ("\\n  P0 Title" → P0, "Title")', () => {
    const result = parseSeverity("\n  P0 Title");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title");
  });

  // --- Fallback: P0/P1 keyword anywhere in text ---

  it('finds P0 in middle of text via fallback ("Some text with P0 in the middle" → P0)', () => {
    const result = parseSeverity("Some text with P0 in the middle");
    expect(result.severity).toBe("P0");
    // First line is used as title in fallback
    expect(result.title).toBe("Some text with P0 in the middle");
  });

  it("does not suppress fallback P0/P1 matches when no-findings wording appears only in the body", () => {
    const raw =
      "Review details\n\nThe previous run reported no issues, but this comment flags a P1 regression.";
    const result = parseSeverity(raw);
    expect(result.severity).toBe("P1");
    expect(result.title).toBe("Review details");
  });

  // --- No match ---

  it('returns null severity for "No severity badge at all"', () => {
    const result = parseSeverity("No severity badge at all");
    expect(result.severity).toBeNull();
    expect(result.title).toBe("No severity badge at all");
  });

  // --- Title/body separation at \n\n ---

  it("separates title from body at double newline", () => {
    const raw = "P1 Fix memory leak\n\nThe allocator is never freed after use.";
    const result = parseSeverity(raw);
    expect(result.severity).toBe("P1");
    expect(result.title).toBe("Fix memory leak");
    expect(result.body).toBe("The allocator is never freed after use.");
  });

  it("returns empty string for body when no double newline is present", () => {
    const raw = "P0 Critical issue";
    const result = parseSeverity(raw);
    expect(result.body).toBe("");
  });

  // --- Footer removal ---

  it("strips Codex footer from body", () => {
    const raw =
      "P0 Crash on null input\n\nDereference without nil check.\nUseful? React with 👍 / 👎.";
    const result = parseSeverity(raw);
    expect(result.body).toBe("Dereference without nil check.");
  });

  it("handles body that is only the footer (strips to empty string)", () => {
    const raw = "P0 Title\n\nUseful? React with 👍 / 👎.";
    const result = parseSeverity(raw);
    expect(result.body).toBe("");
  });

  describe("Codex inline comment fixtures", () => {
    for (const fixture of codexFixtures) {
      it(`parses ${fixture.name}`, () => {
        const result = parseSeverity(fixture.body);
        expect(result).toEqual(fixture.expected);
      });
    }
  });
});
