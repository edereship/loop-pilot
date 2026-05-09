import { describe, expect, it } from "vitest";
import { processFindingsSequentially } from "../src/sequential-fix-runner.js";
import type { EditOperation, Finding, PrContext } from "../src/types.js";

const prContext: PrContext = {
  number: 138,
  title: "TY-138",
  branch: "linear/TY-138",
};

function finding(
  severity: Finding["severity"],
  path: string,
  line: number,
  title: string,
): Finding {
  return {
    severity,
    path,
    line,
    title,
    body: `${title} body`,
  };
}

describe("processFindingsSequentially", () => {
  it("passes same-file findings one at a time with the latest in-memory content and writes once at the end", async () => {
    const files = new Map([
      [
        "src/same.ts",
        "export function value() {\n  return 1;\n}\n",
      ],
    ]);
    const writes: Array<{ path: string; content: string }> = [];
    const seenContents: string[] = [];

    const result = await processFindingsSequentially({
      findings: [
        finding("P0", "src/same.ts", 2, "first finding"),
        finding("P1", "src/same.ts", 2, "second finding"),
      ],
      prContext,
      iteration: 1,
      maxIterations: 3,
      maxInputTokensPerFile: 30_000,
      readFile: (path) => files.get(path) ?? "",
      writeFile: (path, content) => {
        writes.push({ path, content });
        files.set(path, content);
      },
      fixFile: async (_client, _context, path, content, requestFindings) => {
        seenContents.push(content);
        const requestFinding = requestFindings[0];
        const edit: EditOperation =
          requestFinding.title === "first finding"
            ? {
                path,
                oldCode: "return 1;",
                newCode: "return 2;",
                explanation: "Fix first finding",
              }
            : {
                path,
                oldCode: "return 2;",
                newCode: "return 3;",
                explanation: "Fix second finding",
              };
        return { edits: [edit], skippedReason: null };
      },
    });

    expect(seenContents).toEqual([
      "export function value() {\n  return 1;\n}\n",
      "export function value() {\n  return 2;\n}\n",
    ]);
    expect(writes).toEqual([
      {
        path: "src/same.ts",
        content: "export function value() {\n  return 3;\n}\n",
      },
    ]);
    expect(result.appliedEdits.map((edit) => edit.explanation)).toEqual([
      "Fix first finding",
      "Fix second finding",
    ]);
    expect(result.skippedFindings).toEqual([]);
    expect(result.modifiedFiles).toEqual(["src/same.ts"]);
  });

  it("continues after an unfixable finding and aggregates fixable findings across files", async () => {
    const files = new Map([
      ["src/a.ts", "export const a = 1;\n"],
      ["src/b.ts", "export const b = 1;\n"],
    ]);

    const result = await processFindingsSequentially({
      findings: [
        finding("P0", "src/a.ts", 1, "fixable P0"),
        finding("P1", "src/b.ts", 1, "manual P1"),
        finding("P2", "src/b.ts", 1, "fixable P2"),
      ],
      prContext,
      iteration: 1,
      maxIterations: 3,
      maxInputTokensPerFile: 30_000,
      readFile: (path) => files.get(path) ?? "",
      writeFile: (path, content) => files.set(path, content),
      fixFile: async (_client, _context, path, _content, requestFindings) => {
        const requestFinding = requestFindings[0];
        if (requestFinding.title === "manual P1") {
          return { edits: [], skippedReason: "needs a new file" };
        }
        const symbol = path === "src/a.ts" ? "a" : "b";
        return {
          edits: [
            {
              path,
              oldCode: `export const ${symbol} = 1;`,
              newCode: `export const ${symbol} = 2;`,
              explanation: `Fix ${requestFinding.title}`,
            },
          ],
          skippedReason: null,
        };
      },
    });

    expect(result.appliedEdits).toHaveLength(2);
    expect(result.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.skippedFindings).toEqual([
      {
        finding: expect.objectContaining({ title: "manual P1" }),
        reason: "needs a new file",
      },
    ]);
    expect(files.get("src/a.ts")).toBe("export const a = 2;\n");
    expect(files.get("src/b.ts")).toBe("export const b = 2;\n");
  });

  it("preserves applicable edits when another edit for the same finding cannot be matched", async () => {
    const files = new Map([
      ["src/partial.ts", "export const fixed = false;\nexport const stale = false;\n"],
    ]);

    const result = await processFindingsSequentially({
      findings: [
        finding("P1", "src/partial.ts", 1, "partially fixable finding"),
      ],
      prContext,
      iteration: 1,
      maxIterations: 3,
      maxInputTokensPerFile: 30_000,
      readFile: (path) => files.get(path) ?? "",
      writeFile: (path, content) => files.set(path, content),
      fixFile: async () => ({
        edits: [
          {
            path: "src/partial.ts",
            oldCode: "export const fixed = false;",
            newCode: "export const fixed = true;",
            explanation: "Apply the valid part of the finding",
          },
          {
            path: "src/partial.ts",
            oldCode: "export const missing = false;",
            newCode: "export const missing = true;",
            explanation: "This stale replacement should be skipped",
          },
        ],
        skippedReason: null,
      }),
    });

    expect(result.appliedEdits.map((edit) => edit.explanation)).toEqual([
      "Apply the valid part of the finding",
    ]);
    expect(result.skippedFindings).toEqual([
      {
        finding: expect.objectContaining({ title: "partially fixable finding" }),
        reason: "1 edit(s) could not be applied and require manual follow-up.",
      },
    ]);
    expect(files.get("src/partial.ts")).toBe(
      "export const fixed = true;\nexport const stale = false;\n",
    );
  });

  it("reports stopped eligibility only when every finding is unfixable", async () => {
    const result = await processFindingsSequentially({
      findings: [
        finding("P0", "src/a.ts", 1, "manual P0"),
        finding("P1", "src/b.ts", 1, "manual P1"),
      ],
      prContext,
      iteration: 1,
      maxIterations: 3,
      maxInputTokensPerFile: 30_000,
      readFile: () => "export const value = 1;\n",
      writeFile: () => {
        throw new Error("writeFile should not be called");
      },
      fixFile: async () => ({ edits: [], skippedReason: "manual only" }),
    });

    expect(result.appliedEdits).toHaveLength(0);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.skippedFindings).toHaveLength(2);
  });
});
