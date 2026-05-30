import { describe, expect, it } from "vitest";
import { buildInitPlan, executeInitPlan, type InitIO } from "../src/init.js";
import { detectToolchain } from "../src/toolchain.js";

describe("buildInitPlan", () => {
  it("generates two callers, the gate label, and a CHECK_COMMAND suggestion for a Node repo", () => {
    const plan = buildInitPlan(detectToolchain(["package.json", "package-lock.json"]));
    expect(plan.language).toBe("node");
    expect(plan.checkCommand).toBe("npm run check");
    expect(plan.callers.map((c) => c.path)).toEqual([
      ".github/workflows/looppilot-init.yml",
      ".github/workflows/looppilot-loop.yml",
    ]);
    expect(plan.label).toEqual({ name: "loop-pilot", color: "BFD4F2", description: "Run LoopPilot on this PR" });
    expect(plan.callers[1].content).toContain("language: node");
  });

  it("omits the label under full-auto", () => {
    const plan = buildInitPlan(detectToolchain(["go.mod"]), { fullAuto: true });
    expect(plan.label).toBeNull();
    expect(plan.language).toBe("go");
    expect(plan.callers[1].content).toContain("language: go");
  });

  it("honors an overridden CHECK_COMMAND and label name", () => {
    const plan = buildInitPlan(detectToolchain(["requirements.txt"]), {
      checkCommand: "pytest -q",
      labelName: "ai-fix",
    });
    expect(plan.checkCommand).toBe("pytest -q");
    expect(plan.label?.name).toBe("ai-fix");
  });

  it("notes when the toolchain could not be detected", () => {
    const plan = buildInitPlan(detectToolchain(["README.md"]));
    expect(plan.notes.join("\n")).toContain("Could not auto-detect");
    expect(plan.language).toBe("none");
  });

  it("notes ambiguity for a polyglot repo", () => {
    const plan = buildInitPlan(detectToolchain(["package.json", "package-lock.json", "pyproject.toml"]));
    expect(plan.notes.join("\n")).toContain("Also detected");
  });

  it("warns when an overridden CHECK_COMMAND is unsafe", () => {
    const plan = buildInitPlan(detectToolchain(["package.json"]), { checkCommand: "npm run check; rm -rf /" });
    expect(plan.notes.join("\n")).toContain("not allowlist-safe");
  });

  it("always includes the manual (non-automatable) steps", () => {
    const plan = buildInitPlan(detectToolchain(["package.json"]));
    const joined = plan.manualSteps.join("\n");
    expect(joined).toContain("Codex GitHub App");
    expect(joined).toContain("ANTHROPIC_API_KEY");
    expect(joined).toContain("LOOPPILOT_PUSH_TOKEN");
    expect(joined).toContain("gh looppilot doctor");
  });
});

function fakeIO(existing: string[] = []) {
  const writes: Record<string, string> = {};
  const labels: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const io: InitIO = {
    fileExists: (p) => existing.includes(p),
    writeFile: (p, content) => {
      writes[p] = content;
    },
    log: (m) => logs.push(m),
    createLabel: async (name, color, description) => {
      labels.push([name, color, description]);
      return "created";
    },
  };
  return { io, writes, labels, logs };
}

describe("executeInitPlan", () => {
  it("writes both callers and creates the label", async () => {
    const plan = buildInitPlan(detectToolchain(["package.json", "package-lock.json"]));
    const { io, writes, labels } = fakeIO();
    const res = await executeInitPlan(plan, io);
    expect(Object.keys(writes)).toEqual([
      ".github/workflows/looppilot-init.yml",
      ".github/workflows/looppilot-loop.yml",
    ]);
    expect(res.written).toHaveLength(2);
    expect(labels).toEqual([["loop-pilot", "BFD4F2", "Run LoopPilot on this PR"]]);
  });

  it("skips existing caller files unless --force", async () => {
    const plan = buildInitPlan(detectToolchain(["package.json"]));
    const { io, writes, logs } = fakeIO([".github/workflows/looppilot-init.yml"]);
    const res = await executeInitPlan(plan, io);
    expect(writes[".github/workflows/looppilot-init.yml"]).toBeUndefined();
    expect(res.skipped).toContain(".github/workflows/looppilot-init.yml");
    expect(logs.join("\n")).toContain("already exists");
  });

  it("overwrites existing files with --force", async () => {
    const plan = buildInitPlan(detectToolchain(["package.json"]));
    const { io, writes } = fakeIO([".github/workflows/looppilot-init.yml"]);
    await executeInitPlan(plan, io, { force: true });
    expect(writes[".github/workflows/looppilot-init.yml"]).toBeDefined();
  });

  it("dry-run writes nothing and creates no label", async () => {
    const plan = buildInitPlan(detectToolchain(["package.json"]));
    const { io, writes, labels, logs } = fakeIO();
    await executeInitPlan(plan, io, { dryRun: true });
    expect(Object.keys(writes)).toHaveLength(0);
    expect(labels).toHaveLength(0);
    expect(logs.join("\n")).toContain("would write");
  });
});
