import { describe, expect, it } from "vitest";
import { isAutoReviewAllowed } from "../src/pr-labels.js";

describe("isAutoReviewAllowed", () => {
  it("returns true when no label is required (gating disabled)", () => {
    expect(isAutoReviewAllowed("", [])).toBe(true);
    expect(isAutoReviewAllowed("", ["auto-review", "bug"])).toBe(true);
  });

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

  it("matches labels case-sensitively to align with GitHub semantics", () => {
    expect(isAutoReviewAllowed("auto-review", ["Auto-Review"])).toBe(false);
    expect(isAutoReviewAllowed("Auto-Review", ["auto-review"])).toBe(false);
  });

  it("does not match a partial label name", () => {
    expect(isAutoReviewAllowed("auto-review", ["auto-review-2"])).toBe(false);
    expect(isAutoReviewAllowed("review", ["auto-review"])).toBe(false);
  });
});
