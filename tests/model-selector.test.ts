import { describe, expect, it } from "vitest";
import { selectModel } from "../src/model-selector.js";
import type { Finding } from "../src/types.js";

const finding = (severity: "P0" | "P1" | "P2"): Finding => ({
  severity,
  path: "src/foo.ts",
  line: 1,
  title: "t",
  body: "b",
});

const defaultInput = {
  override: "",
  baseModel: "claude-sonnet-4-6",
  escalatedModel: "claude-opus-4-7",
  findings: [],
  previousCheckFailure: null,
  repeatedFinding: false,
};

describe("selectModel", () => {
  it("returns override tier when override is set, regardless of escalation signals", () => {
    const result = selectModel({
      ...defaultInput,
      override: "claude-haiku-4-5-20251001",
      findings: [finding("P0")],
      previousCheckFailure: "boom",
    });
    expect(result).toEqual({
      model: "claude-haiku-4-5-20251001",
      tier: "override",
      escalationReasons: [],
    });
  });

  it("returns base tier when no escalation signals", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1"), finding("P2")],
    });
    expect(result).toEqual({
      model: "claude-sonnet-4-6",
      tier: "base",
      escalationReasons: [],
    });
  });

  it("escalates when a P0 finding is present", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1"), finding("P0")],
    });
    expect(result).toEqual({
      model: "claude-opus-4-7",
      tier: "escalated",
      escalationReasons: ["p0_finding"],
    });
  });

  it("escalates when previousCheckFailure is a non-empty string", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P2")],
      previousCheckFailure: "tsc failed",
    });
    expect(result).toEqual({
      model: "claude-opus-4-7",
      tier: "escalated",
      escalationReasons: ["previous_check_failure"],
    });
  });

  it("treats an empty string previousCheckFailure as no failure", () => {
    const result = selectModel({
      ...defaultInput,
      previousCheckFailure: "",
    });
    expect(result.tier).toBe("base");
  });

  it("lists both reasons when P0 and previousCheckFailure both fire", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P0")],
      previousCheckFailure: "boom",
    });
    expect(result).toEqual({
      model: "claude-opus-4-7",
      tier: "escalated",
      escalationReasons: ["p0_finding", "previous_check_failure"],
    });
  });

  it("does not escalate when only P1/P2 findings exist", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1"), finding("P1"), finding("P2")],
    });
    expect(result.tier).toBe("base");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("override takes precedence even with empty findings", () => {
    const result = selectModel({
      ...defaultInput,
      override: "claude-opus-4-7",
      findings: [],
    });
    expect(result.tier).toBe("override");
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("escalates with repeated_finding when repeatedFinding is true", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1")],
      repeatedFinding: true,
    });
    expect(result).toEqual({
      model: "claude-opus-4-7",
      tier: "escalated",
      escalationReasons: ["repeated_finding"],
    });
  });

  it("lists all three escalation reasons when all signals fire together", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P0")],
      previousCheckFailure: "tsc failed",
      repeatedFinding: true,
    });
    expect(result).toEqual({
      model: "claude-opus-4-7",
      tier: "escalated",
      escalationReasons: [
        "p0_finding",
        "previous_check_failure",
        "repeated_finding",
      ],
    });
  });

  it("override still wins when repeatedFinding is true", () => {
    const result = selectModel({
      ...defaultInput,
      override: "claude-haiku-4-5-20251001",
      findings: [finding("P1")],
      repeatedFinding: true,
    });
    expect(result.tier).toBe("override");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.escalationReasons).toEqual([]);
  });
});
