import { describe, it, expect } from "vitest";
import { findMismatchedActionRefs } from "../src/action-ref-check.js";

const OWNER_PREFIX = "edereship/loop-pilot";

describe("findMismatchedActionRefs", () => {
  it("returns [] when every edereship/loop-pilot ref matches the expected major", () => {
    const yaml = [
      `uses: ${OWNER_PREFIX}/loop/pre-fix@v1`,
      `uses: ${OWNER_PREFIX}/loop/post-fix@v1`,
    ].join("\n");
    expect(findMismatchedActionRefs(yaml, "v1")).toEqual([]);
  });

  it("flags refs whose major differs from expected", () => {
    const yaml = `uses: ${OWNER_PREFIX}/loop/pre-fix@v2`;
    expect(findMismatchedActionRefs(yaml, "v1")).toEqual([
      { ref: `${OWNER_PREFIX}/loop/pre-fix`, found: "v2", expected: "v1" },
    ]);
  });

  it("ignores third-party actions (e.g. actions/checkout@v5)", () => {
    const yaml = "uses: actions/checkout@v5";
    expect(findMismatchedActionRefs(yaml, "v1")).toEqual([]);
  });

  it("treats a full semver tag's major as the expected (v1.2.3 -> v1)", () => {
    const yaml = `uses: ${OWNER_PREFIX}/init@v1`;
    expect(findMismatchedActionRefs(yaml, "v1.2.3")).toEqual([]);
  });

  it("flags a pinned SHA or non-@v ref as a mismatch", () => {
    const yaml = `uses: ${OWNER_PREFIX}/loop@main`;
    expect(findMismatchedActionRefs(yaml, "v1")).toEqual([
      { ref: `${OWNER_PREFIX}/loop`, found: "main", expected: "v1" },
    ]);
  });
});
