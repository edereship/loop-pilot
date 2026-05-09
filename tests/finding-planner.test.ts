import { describe, expect, it } from "vitest";
import { planFindingsForIteration } from "../src/finding-planner.js";
import type { Finding } from "../src/types.js";

const findings: Finding[] = [
  {
    severity: "P2",
    path: "src/zeta.ts",
    line: 30,
    title: "P2 in later file",
    body: "Low priority issue.",
  },
  {
    severity: "P1",
    path: "src/alpha.ts",
    line: 20,
    title: "P1 in same file",
    body: "High priority issue.",
  },
  {
    severity: "P0",
    path: "src/alpha.ts",
    line: 10,
    title: "P0 in same file",
    body: "Urgent issue.",
  },
  {
    severity: "P1",
    path: "src/beta.ts",
    line: 5,
    title: "P1 in another file",
    body: "High priority issue in another file.",
  },
];

describe("planFindingsForIteration", () => {
  it("orders selected findings by severity so P0 is handled before P1/P2", () => {
    const plan = planFindingsForIteration(findings, 10);

    expect(plan.selectedFindings.map((finding) => finding.title)).toEqual([
      "P0 in same file",
      "P1 in same file",
      "P1 in another file",
      "P2 in later file",
    ]);
  });

  it("selects complete files up to maxFiles and reports deferred files", () => {
    const plan = planFindingsForIteration(findings, 1);

    expect(plan.selectedFindings.map((finding) => finding.path)).toEqual([
      "src/alpha.ts",
      "src/alpha.ts",
    ]);
    expect(plan.deferredFiles).toEqual(["src/beta.ts", "src/zeta.ts"]);
  });
});
