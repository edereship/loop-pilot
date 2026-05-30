import { describe, expect, it } from "vitest";
import { detectToolchain, toWorkflowLanguage } from "../src/toolchain.js";

describe("detectToolchain", () => {
  it("detects a Node repo and the npm package manager from package-lock.json", () => {
    const d = detectToolchain(["package.json", "package-lock.json", "src"]);
    expect(d.ecosystem).toBe("node");
    expect(d.language).toBe("node");
    expect(d.packageManager).toBe("npm");
    expect(d.checkCommand).toBe("npm run check");
    expect(d.evidence).toContain("package.json");
  });

  it("detects pnpm / yarn / bun from their lockfiles", () => {
    expect(detectToolchain(["package.json", "pnpm-lock.yaml"]).packageManager).toBe("pnpm");
    expect(detectToolchain(["package.json", "pnpm-lock.yaml"]).checkCommand).toBe("pnpm run check");
    expect(detectToolchain(["package.json", "yarn.lock"]).packageManager).toBe("yarn");
    expect(detectToolchain(["package.json", "yarn.lock"]).checkCommand).toBe("yarn run check");
    expect(detectToolchain(["package.json", "bun.lockb"]).packageManager).toBe("bun");
  });

  it("prefers an existing `check` script, then `test`, over the default", () => {
    const withCheck = detectToolchain(["package.json", "package-lock.json"], {
      scripts: { check: "tsc && vitest run", test: "vitest run" },
    });
    expect(withCheck.checkCommand).toBe("npm run check");

    const withTestOnly = detectToolchain(["package.json", "package-lock.json"], {
      scripts: { test: "vitest run" },
    });
    expect(withTestOnly.checkCommand).toBe("npm run test");

    const noScripts = detectToolchain(["package.json", "package-lock.json"], { scripts: {} });
    expect(noScripts.checkCommand).toBe("npm run check");
  });

  it("detects Python from requirements.txt or pyproject.toml → pytest", () => {
    expect(detectToolchain(["requirements.txt"]).ecosystem).toBe("python");
    expect(detectToolchain(["pyproject.toml"]).ecosystem).toBe("python");
    expect(detectToolchain(["requirements.txt"]).language).toBe("python");
    expect(detectToolchain(["requirements.txt"]).checkCommand).toBe("pytest");
  });

  it("detects Go from go.mod → go test ./...", () => {
    const d = detectToolchain(["go.mod", "main.go"]);
    expect(d.ecosystem).toBe("go");
    expect(d.checkCommand).toBe("go test ./...");
  });

  it("detects Rust from Cargo.toml → cargo test", () => {
    const d = detectToolchain(["Cargo.toml", "src"]);
    expect(d.ecosystem).toBe("rust");
    expect(d.checkCommand).toBe("cargo test");
  });

  it("detects Make from a Makefile → make check, language=none", () => {
    const d = detectToolchain(["Makefile"]);
    expect(d.ecosystem).toBe("make");
    expect(d.language).toBe("none"); // make uses preinstalled tools; no language toolchain
    expect(d.checkCommand).toBe("make check");
  });

  it("returns ecosystem=null / language=none / empty command when nothing is recognized", () => {
    const d = detectToolchain(["README.md", "LICENSE"]);
    expect(d.ecosystem).toBeNull();
    expect(d.language).toBe("none");
    expect(d.checkCommand).toBe("");
  });

  it("picks the highest-priority ecosystem and reports the rest as ambiguity (node over Makefile)", () => {
    const d = detectToolchain(["package.json", "package-lock.json", "Makefile"]);
    expect(d.ecosystem).toBe("node");
    expect(d.alsoDetected).toContain("make");
  });

  it("treats a polyglot Node+Python repo as ambiguous, primary by priority (node)", () => {
    const d = detectToolchain(["package.json", "package-lock.json", "pyproject.toml"]);
    expect(d.ecosystem).toBe("node");
    expect(d.alsoDetected).toContain("python");
  });
});

describe("toWorkflowLanguage", () => {
  it("maps make and null to none, passes through the rest", () => {
    expect(toWorkflowLanguage("node")).toBe("node");
    expect(toWorkflowLanguage("python")).toBe("python");
    expect(toWorkflowLanguage("go")).toBe("go");
    expect(toWorkflowLanguage("rust")).toBe("rust");
    expect(toWorkflowLanguage("make")).toBe("none");
    expect(toWorkflowLanguage(null)).toBe("none");
  });
});
