import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMismatchedActionRefs } from "../src/action-ref-check.js";

// TY-345: reusable `workflow_call` workflows + thin callers.
const initReusable = readFileSync(".github/workflows/init.yml", "utf8");
const loopReusable = readFileSync(".github/workflows/loop.yml", "utf8");
const initCaller = readFileSync(".github/workflows/looppilot-init.yml", "utf8");
const loopCaller = readFileSync(".github/workflows/looppilot-loop.yml", "utf8");
const readme = readFileSync("README.md", "utf8");

describe("reusable workflows: workflow_call surface", () => {
  it("both reusable workflows are workflow_call entrypoints", () => {
    expect(initReusable).toContain("on:\n  workflow_call:");
    expect(loopReusable).toContain("on:\n  workflow_call:");
  });

  it("reusable init enumerates the optional Codex token secret (cross-org callers cannot inherit)", () => {
    // GITHUB_TOKEN is provided automatically and must NOT be declared.
    expect(initReusable).toContain("secrets:");
    expect(initReusable).toContain("CODEX_REVIEW_REQUEST_TOKEN:");
    expect(initReusable).not.toContain("GITHUB_TOKEN:\n        required");
  });

  it("reusable loop enumerates all four custom secrets (GITHUB_TOKEN stays implicit)", () => {
    for (const s of [
      "CODEX_REVIEW_REQUEST_TOKEN:",
      "LOOPPILOT_PUSH_TOKEN:",
      "ANTHROPIC_API_KEY:",
      "CLAUDE_CODE_OAUTH_TOKEN:",
    ]) {
      expect(loopReusable).toContain(s);
    }
  });
});

describe("reusable workflows: sub-action refs use the published tag, never ./", () => {
  it("reusable loop calls the composite action by published path@v1, not a local ./ ref", () => {
    expect(loopReusable).toContain("uses: team-yubune/loop-pilot/loop@v1");
    expect(loopReusable).not.toContain("uses: ./loop");
  });

  it("reusable init calls the composite action by published path@v1, not a local ./ ref", () => {
    expect(initReusable).toContain("uses: team-yubune/loop-pilot/init@v1");
    expect(initReusable).not.toContain("uses: ./init");
  });

  it("the action-ref release guard (TY-342) sees a consistent @v1 major in the reusable workflows", () => {
    expect(findMismatchedActionRefs(loopReusable, "v1")).toEqual([]);
    expect(findMismatchedActionRefs(initReusable, "v1")).toEqual([]);
    // A major bump must flag the reusable workflows too, so a release can't
    // ship a v2 tag while these still point at @v1.
    expect(findMismatchedActionRefs(loopReusable, "v2").length).toBeGreaterThan(0);
    expect(findMismatchedActionRefs(initReusable, "v2").length).toBeGreaterThan(0);
  });
});

describe("reusable workflows: permissions", () => {
  it("reusable loop declares the full write set plus actions: read for the auto-merge guard", () => {
    expect(loopReusable).toContain("contents: write");
    expect(loopReusable).toContain("pull-requests: write");
    expect(loopReusable).toContain("issues: write");
    expect(loopReusable).toContain("actions: read");
  });

  it("reusable init declares contents: read (init never pushes)", () => {
    expect(initReusable).toContain("contents: read");
    expect(initReusable).toContain("pull-requests: write");
    expect(initReusable).toContain("issues: write");
  });
});

describe("reusable loop: switchable toolchain via the `language` input", () => {
  it("declares a `language` input defaulting to node", () => {
    expect(loopReusable).toContain("inputs:");
    expect(loopReusable).toContain("language:");
    expect(loopReusable).toContain('default: "node"');
  });

  it("gates each toolchain setup step on inputs.language", () => {
    expect(loopReusable).toContain("if: inputs.language == 'node'");
    expect(loopReusable).toContain("if: inputs.language == 'python'");
    expect(loopReusable).toContain("if: inputs.language == 'go'");
    expect(loopReusable).toContain("if: inputs.language == 'rust'");
  });

  it("keeps the historical Node default behaviour (setup-node + npm ci)", () => {
    expect(loopReusable).toContain("uses: actions/setup-node@v5");
    expect(loopReusable).toContain(
      "if: inputs.language == 'node' && hashFiles('package-lock.json') != ''",
    );
    expect(loopReusable).toContain("run: npm ci");
  });
});

describe("thin dogfooding callers", () => {
  it("init caller forwards to the local reusable workflow with inherited secrets", () => {
    expect(initCaller).toContain("uses: ./.github/workflows/init.yml");
    expect(initCaller).toContain("secrets: inherit");
  });

  it("loop caller forwards to the local reusable workflow with inherited secrets and actions: read", () => {
    expect(loopCaller).toContain("uses: ./.github/workflows/loop.yml");
    expect(loopCaller).toContain("secrets: inherit");
    expect(loopCaller).toContain("actions: read");
  });

  it("callers carry the trigger events but none of the gate logic", () => {
    expect(initCaller).toContain("pull_request:");
    expect(loopCaller).toContain("issue_comment:");
    expect(loopCaller).toContain("pull_request_review:");
    // The 51-line Codex gate must NOT be duplicated into the callers.
    expect(initCaller).not.toContain("chatgpt-codex-connector[bot]");
    expect(loopCaller).not.toContain("chatgpt-codex-connector[bot]");
    expect(loopCaller).not.toContain("LOOPPILOT_FULL_AUTO");
  });

  it("callers stay thin (~22 lines or fewer of non-comment YAML)", () => {
    const nonComment = (s: string) =>
      s.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;
    expect(nonComment(initCaller)).toBeLessThanOrEqual(22);
    expect(nonComment(loopCaller)).toBeLessThanOrEqual(24);
  });
});

describe("README documents the cross-org adopter caller", () => {
  it("references the reusable workflows by tagged path", () => {
    expect(readme).toContain("team-yubune/loop-pilot/.github/workflows/init.yml@v1");
    expect(readme).toContain("team-yubune/loop-pilot/.github/workflows/loop.yml@v1");
  });

  it("enumerates the cross-org secrets and the actions: read permission", () => {
    expect(readme).toContain("CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}");
    expect(readme).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(readme).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(readme).toContain("actions: read");
  });

  it("documents the language input for non-Node toolchains", () => {
    expect(readme).toContain("language:");
  });
});
