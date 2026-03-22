import { describe, it, expect } from "vitest";
import { sanitizeOutput } from "../src/check-runner.js";

describe("sanitizeOutput", () => {
  it("removes ANSI escape sequences", () => {
    const input = "\x1b[31mError\x1b[0m: something failed";
    expect(sanitizeOutput(input)).toBe("Error: something failed");
  });

  it("removes multiple ANSI sequences", () => {
    const input = "\x1b[1m\x1b[33mWarning:\x1b[0m check \x1b[32mpassed\x1b[0m";
    expect(sanitizeOutput(input)).toBe("Warning: check passed");
  });

  it("returns input unchanged when no ANSI sequences present", () => {
    const input = "clean output line";
    expect(sanitizeOutput(input)).toBe("clean output line");
  });

  it("truncates output exceeding 60000 chars", () => {
    const longOutput = "x".repeat(70000);
    const result = sanitizeOutput(longOutput);
    expect(result.length).toBeLessThanOrEqual(60000);
  });

  it("preserves head and tail lines when truncating", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${"x".repeat(400)}`);
    const longOutput = lines.join("\n");
    const result = sanitizeOutput(longOutput);
    expect(result).toContain("line 1:");
    expect(result).toContain("... (truncated) ...");
    expect(result).toContain("line 200:");
  });

  it("returns short output unchanged", () => {
    const input = "short output";
    expect(sanitizeOutput(input)).toBe("short output");
  });
});
