import { describe, expect, it } from "vitest";
import {
  buildReport,
  exitCodeForReport,
  formatJson,
  formatTable,
  runPreflight,
  type Check,
  type CheckResult,
  type PreflightContext,
} from "../src/preflight.js";

const ctx = { repository: "acme/widgets" } as unknown as PreflightContext;

const ok = (id: string): CheckResult => ({ id, status: "ok", summary: `${id} ok` });

describe("runPreflight", () => {
  it("runs every check and preserves order", async () => {
    const checks: Check[] = [async () => ok("a"), async () => ok("b")];
    const res = await runPreflight(checks, ctx);
    expect(res.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("converts a throwing check into an `unknown` result (never aborts the run)", async () => {
    const checks: Check[] = [
      async () => ok("a"),
      async () => {
        throw new Error("boom");
      },
      async () => ok("c"),
    ];
    const res = await runPreflight(checks, ctx);
    expect(res.map((r) => r.status)).toEqual(["ok", "unknown", "ok"]);
    expect(res[1].details).toContain("boom");
  });
});

describe("buildReport / exit codes", () => {
  it("is ok (exit 0) when only warnings/unknown are present", () => {
    const report = buildReport("acme/widgets", [
      { id: "a", status: "ok", summary: "" },
      { id: "b", status: "warning", summary: "" },
      { id: "c", status: "unknown", summary: "" },
    ]);
    expect(report.ok).toBe(true);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("is not ok (exit 1) when any error is present", () => {
    const report = buildReport("acme/widgets", [
      { id: "a", status: "ok", summary: "" },
      { id: "b", status: "error", summary: "" },
    ]);
    expect(report.ok).toBe(false);
    expect(exitCodeForReport(report)).toBe(1);
  });
});

describe("formatJson", () => {
  it("emits the stable schema with details/nextSteps defaulted", () => {
    const report = buildReport("acme/widgets", [
      { id: "a", status: "ok", summary: "fine" },
      { id: "b", status: "error", summary: "bad", details: "why", nextSteps: ["do x"] },
    ]);
    const parsed = JSON.parse(formatJson(report));
    expect(parsed.ok).toBe(false);
    expect(parsed.repository).toBe("acme/widgets");
    expect(parsed.checks[0]).toEqual({
      id: "a",
      status: "ok",
      summary: "fine",
      details: null,
      nextSteps: [],
    });
    expect(parsed.checks[1].nextSteps).toEqual(["do x"]);
  });
});

describe("formatTable", () => {
  it("renders each check and a summary line", () => {
    const report = buildReport("acme/widgets", [
      { id: "label.gate", status: "error", summary: "missing", nextSteps: ["gh label create x"] },
    ]);
    const table = formatTable(report);
    expect(table).toContain("acme/widgets");
    expect(table).toContain("label.gate");
    expect(table).toContain("missing");
    expect(table).toContain("gh label create x");
    expect(table).toContain("fix the errors above");
  });
});
