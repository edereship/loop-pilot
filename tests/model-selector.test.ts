import { describe, expect, it } from "vitest";
import { selectModel } from "../src/model-selector.js";
import type { Finding } from "../src/types.js";

const finding = (severity: "P0" | "P1" | "P2"): Finding => ({
  severity,
  commentId: 1,
  path: "src/foo.ts",
  line: 1,
  title: "t",
  body: "b",
});

const defaultInput = {
  baseModel: "claude-sonnet-4-6",
  escalatedModel: "claude-opus-4-6",
  findings: [],
  previousCheckFailure: null,
  repeatedFinding: false,
  previousMaxTurnsExceeded: false,
};

describe("selectModel", () => {
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
      model: "claude-opus-4-6",
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
      model: "claude-opus-4-6",
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
      model: "claude-opus-4-6",
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

  it("escalates with repeated_finding when repeatedFinding is true", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1")],
      repeatedFinding: true,
    });
    expect(result).toEqual({
      model: "claude-opus-4-6",
      tier: "escalated",
      escalationReasons: ["repeated_finding"],
    });
  });

  it("escalates with previous_max_turns_exceeded when previousMaxTurnsExceeded is true (TY-258)", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P2")],
      previousMaxTurnsExceeded: true,
    });
    expect(result).toEqual({
      model: "claude-opus-4-6",
      tier: "escalated",
      escalationReasons: ["previous_max_turns_exceeded"],
    });
  });

  it("does not escalate from this signal when previousMaxTurnsExceeded is false (TY-258)", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P1"), finding("P2")],
      previousMaxTurnsExceeded: false,
    });
    expect(result.tier).toBe("base");
    expect(result.escalationReasons).not.toContain("previous_max_turns_exceeded");
  });

  it("lists all four escalation reasons when every signal fires together (TY-258)", () => {
    const result = selectModel({
      ...defaultInput,
      findings: [finding("P0")],
      previousCheckFailure: "tsc failed",
      repeatedFinding: true,
      previousMaxTurnsExceeded: true,
    });
    expect(result).toEqual({
      model: "claude-opus-4-6",
      tier: "escalated",
      escalationReasons: [
        "p0_finding",
        "previous_check_failure",
        "repeated_finding",
        "previous_max_turns_exceeded",
      ],
    });
  });

  it("BASE === ESCALATED yields a fixed model even at the escalated tier", () => {
    const result = selectModel({
      ...defaultInput,
      baseModel: "claude-opus-4-6",
      escalatedModel: "claude-opus-4-6",
      findings: [finding("P0")],
    });
    expect(result.tier).toBe("escalated");
    expect(result.model).toBe("claude-opus-4-6");
  });
});
