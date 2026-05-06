import { describe, expect, it } from "vitest";
import {
  buildNoApplicableEditsDetail,
  formatFileSkipReason,
} from "../src/stop-detail.js";

describe("buildNoApplicableEditsDetail", () => {
  it("includes sanitized Claude skip reasons in the stop detail", () => {
    const detail = buildNoApplicableEditsDetail([
      {
        filePath: "src/example.ts",
        reason: "I cannot fix this safely.\nSee [secret](https://example.com). ```",
      },
    ]);

    expect(detail).toBe(
      "Claude returned no applicable edits for any selected file. Reasons: src/example.ts: I cannot fix this safely. See secret. ``"
    );
  });

  it("uses the generic detail when there are no skip reasons", () => {
    expect(buildNoApplicableEditsDetail([])).toBe(
      "Claude returned no applicable edits for any selected file"
    );
  });
});

describe("formatFileSkipReason", () => {
  it("formats thrown file errors as sanitized skip reasons", () => {
    expect(formatFileSkipReason("src/example.ts", new Error("Bad\nrequest ```"))).toEqual({
      filePath: "src/example.ts",
      reason: "Bad request ``",
    });
  });
});
