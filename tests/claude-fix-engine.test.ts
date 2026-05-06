import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildClaudeRequest,
  buildSystemPrompt,
  DEFAULT_CLAUDE_MODEL,
  parseEditOperations,
} from "../src/claude-fix-engine.js";

const prContext = {
  number: 7,
  title: "E2E test PR",
  branch: "linear/RCM-TY-11",
};

const findings = [
  {
    severity: "P1" as const,
    path: "src/example.ts",
    line: 12,
    title: "Fix this",
    body: "The current implementation is unsafe.",
  },
];

describe("buildSystemPrompt", () => {
  it("counts the current fix attempt as remaining iteration budget", () => {
    const prompt = buildSystemPrompt(1, 1);

    expect(prompt).toContain("Only 1 iteration(s) remaining");
    expect(prompt).not.toContain("Only 0 iteration(s) remaining");
  });
});

describe("buildClaudeRequest", () => {
  it("allows Claude to abstain while making edit_file available", () => {
    const request = buildClaudeRequest(
      prContext,
      "src/example.ts",
      "export const value = 1;\n",
      findings,
      1,
      2
    );

    expect(request.tools).toHaveLength(1);
    expect(request.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(request.tools?.[0]?.name).toBe("edit_file");
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.system).toContain("If a minimal safe fix is possible, call edit_file");
  });
});

describe("parseEditOperations", () => {
  it("returns text-only responses as a skipped reason", () => {
    const response = {
      content: [{ type: "text", text: "I cannot fix this safely." }],
    } as Anthropic.Message;

    expect(parseEditOperations(response)).toEqual({
      edits: [],
      skippedReason: "I cannot fix this safely.",
    });
  });

  it("reports invalid edit_file tool input as a skipped reason", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "edit_file",
          input: { path: "src/example.ts" },
        },
      ],
    } as unknown as Anthropic.Message;

    expect(parseEditOperations(response)).toEqual({
      edits: [],
      skippedReason: "Claude called edit_file, but all tool inputs were invalid.",
    });
  });
});
