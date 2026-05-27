import { describe, expect, it } from "vitest";
import { isAutoReviewAllowed } from "../src/pr-labels.js";

describe("isAutoReviewAllowed", () => {
  it("returns true when the required label is currently on the PR", () => {
    expect(isAutoReviewAllowed("LoopPilot", ["LoopPilot"])).toBe(true);
    expect(isAutoReviewAllowed("LoopPilot", ["bug", "LoopPilot", "P1"])).toBe(
      true,
    );
  });

  it("returns false when the required label is missing", () => {
    expect(isAutoReviewAllowed("LoopPilot", [])).toBe(false);
    expect(isAutoReviewAllowed("LoopPilot", ["bug", "P1"])).toBe(false);
  });

  it("matches labels case-insensitively to align with workflow YAML contains()", () => {
    expect(isAutoReviewAllowed("loop-pilot", ["Loop-Pilot"])).toBe(true);
    expect(isAutoReviewAllowed("Loop-Pilot", ["loop-pilot"])).toBe(true);
    expect(isAutoReviewAllowed("LOOP-PILOT", ["loop-pilot"])).toBe(true);
  });

  it("does not match a partial label name", () => {
    expect(isAutoReviewAllowed("LoopPilot", ["LoopPilot-2"])).toBe(false);
    expect(isAutoReviewAllowed("review", ["LoopPilot"])).toBe(false);
  });

  it("returns false for an empty requiredLabel (fail-safe against misconfiguration)", () => {
    expect(isAutoReviewAllowed("", [])).toBe(false);
    expect(isAutoReviewAllowed("", ["LoopPilot", "bug"])).toBe(false);
  });
});
