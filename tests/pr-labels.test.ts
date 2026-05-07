import { describe, expect, it } from "vitest";
import { isAutoReviewAllowed } from "../src/pr-labels.js";

describe("isAutoReviewAllowed", () => {
  it("returns true when the required label is currently on the PR", () => {
    expect(isAutoReviewAllowed("auto-review", ["auto-review"])).toBe(true);
    expect(isAutoReviewAllowed("auto-review", ["bug", "auto-review", "P1"])).toBe(
      true,
    );
  });

  it("returns false when the required label is missing", () => {
    expect(isAutoReviewAllowed("auto-review", [])).toBe(false);
    expect(isAutoReviewAllowed("auto-review", ["bug", "P1"])).toBe(false);
  });

  it("matches labels case-insensitively to align with workflow YAML contains()", () => {
    expect(isAutoReviewAllowed("auto-review", ["Auto-Review"])).toBe(true);
    expect(isAutoReviewAllowed("Auto-Review", ["auto-review"])).toBe(true);
    expect(isAutoReviewAllowed("AUTO-REVIEW", ["auto-review"])).toBe(true);
  });

  it("does not match a partial label name", () => {
    expect(isAutoReviewAllowed("auto-review", ["auto-review-2"])).toBe(false);
    expect(isAutoReviewAllowed("review", ["auto-review"])).toBe(false);
  });

  it("returns false for an empty requiredLabel (fail-safe against misconfiguration)", () => {
    expect(isAutoReviewAllowed("", [])).toBe(false);
    expect(isAutoReviewAllowed("", ["auto-review", "bug"])).toBe(false);
  });
});
