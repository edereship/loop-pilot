import { describe, it, expect } from "vitest";
import { applyEdits } from "../src/edit-applier";
import type { EditOperation } from "../src/types";

describe("applyEdits", () => {
  // Test 1: Single edit applied correctly
  it("applies a single edit to file content", () => {
    const content = `function greet(name: string) {
  return "Hello, " + name;
}
`;
    const edits: EditOperation[] = [
      {
        path: "src/greet.ts",
        oldCode: `  return "Hello, " + name;`,
        newCode: `  return \`Hello, \${name}!\`;`,
        explanation: "Use template literal",
      },
    ];

    const result = applyEdits(content, edits, "src/greet.ts");
    expect(result.success).toBe(true);
    expect(result.failedEdits).toHaveLength(0);
    expect(result.content).toBe(`function greet(name: string) {
  return \`Hello, \${name}!\`;
}
`);
  });

  // Test 2: Multiple edits applied in reverse order (bottom-first)
  it("applies multiple edits in reverse order to avoid line-number shifts", () => {
    const content = `line one
line two
line three
line four
line five
`;
    const edits: EditOperation[] = [
      {
        path: "src/file.ts",
        oldCode: "line one",
        newCode: "line ONE\nextra line",
        explanation: "Expand first line",
      },
      {
        path: "src/file.ts",
        oldCode: "line five",
        newCode: "line FIVE",
        explanation: "Change last line",
      },
    ];

    const result = applyEdits(content, edits, "src/file.ts");
    expect(result.success).toBe(true);
    expect(result.failedEdits).toHaveLength(0);
    // Both edits should be applied correctly despite line shift from first edit
    expect(result.content).toBe(`line ONE
extra line
line two
line three
line four
line FIVE
`);
  });

  // Test 3: Whitespace normalization (trailing spaces in file content)
  it("matches old_code even when file has trailing whitespace", () => {
    // File content has trailing spaces on lines
    const content = `function foo() {  \n  const x = 1;  \n  return x;\n}\n`;
    const edits: EditOperation[] = [
      {
        path: "src/foo.ts",
        // old_code without trailing spaces
        oldCode: `function foo() {\n  const x = 1;\n  return x;\n}`,
        newCode: `function foo() {\n  const x = 42;\n  return x;\n}`,
        explanation: "Change constant value",
      },
    ];

    const result = applyEdits(content, edits, "src/foo.ts");
    expect(result.success).toBe(true);
    expect(result.failedEdits).toHaveLength(0);
    expect(result.content).toContain("const x = 42;");
  });

  // Test 4: CRLF normalization
  it("matches old_code when file uses CRLF line endings", () => {
    // File content uses CRLF
    const content = "function bar() {\r\n  return 0;\r\n}\r\n";
    const edits: EditOperation[] = [
      {
        path: "src/bar.ts",
        // old_code uses LF only
        oldCode: "function bar() {\n  return 0;\n}",
        newCode: "function bar() {\n  return 1;\n}",
        explanation: "Change return value",
      },
    ];

    const result = applyEdits(content, edits, "src/bar.ts");
    expect(result.success).toBe(true);
    expect(result.failedEdits).toHaveLength(0);
    expect(result.content).toContain("return 1;");
  });

  // Test 5: Multiple matches → nearest to lineHint selected
  it("selects the match nearest to the lineHint when old_code appears multiple times", () => {
    // "  return null;" appears at line 2 and line 5
    const content = `function first() {
  return null;
}

function second() {
  return null;
}
`;
    const edits: EditOperation[] = [
      {
        path: "src/multi.ts",
        oldCode: "  return null;",
        newCode: "  return undefined;",
        explanation: "Change return value in second function",
      },
    ];

    // lineHint=5 should select the second occurrence (line 5 in 0-based content)
    const result = applyEdits(content, edits, "src/multi.ts", [5]);
    expect(result.success).toBe(true);
    expect(result.failedEdits).toHaveLength(0);
    // First occurrence unchanged, second occurrence replaced
    expect(result.content).toBe(`function first() {
  return null;
}

function second() {
  return undefined;
}
`);
  });

  // Test 6: old_code not found → failure
  it("returns failure when old_code cannot be found in file content", () => {
    const content = `function baz() {
  return 42;
}
`;
    const edits: EditOperation[] = [
      {
        path: "src/baz.ts",
        oldCode: "  return 999; // does not exist",
        newCode: "  return 0;",
        explanation: "This edit cannot be applied",
      },
    ];

    const result = applyEdits(content, edits, "src/baz.ts");
    expect(result.success).toBe(false);
    expect(result.content).toBeNull();
    expect(result.failedEdits).toHaveLength(1);
    expect(result.failedEdits[0].oldCode).toBe("  return 999; // does not exist");
  });

  // Test 7: Partial failure → all-or-nothing (content is null)
  it("returns all-or-nothing failure when any edit cannot be applied", () => {
    const content = `const a = 1;
const b = 2;
const c = 3;
`;
    const edits: EditOperation[] = [
      {
        path: "src/consts.ts",
        oldCode: "const a = 1;",
        newCode: "const a = 10;",
        explanation: "Valid edit",
      },
      {
        path: "src/consts.ts",
        oldCode: "const z = 99; // does not exist",
        newCode: "const z = 100;",
        explanation: "Invalid edit",
      },
    ];

    const result = applyEdits(content, edits, "src/consts.ts");
    expect(result.success).toBe(false);
    // All-or-nothing: content must be null even though first edit was valid
    expect(result.content).toBeNull();
    expect(result.failedEdits).toHaveLength(1);
    expect(result.failedEdits[0].oldCode).toBe("const z = 99; // does not exist");
  });

  // Test 8: Overlapping edits detected and rejected
  it("detects overlapping edits and reports them as failed", () => {
    const content = `function example() {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}
`;
    const edits: EditOperation[] = [
      {
        path: "src/example.ts",
        oldCode: "  const a = 1;\n  const b = 2;",
        newCode: "  const a = 10;\n  const b = 20;",
        explanation: "Edit A: covers lines 2-3",
      },
      {
        path: "src/example.ts",
        oldCode: "  const b = 2;\n  const c = 3;",
        newCode: "  const b = 200;\n  const c = 300;",
        explanation: "Edit B: overlaps with edit A on line 3",
      },
    ];

    const result = applyEdits(content, edits, "src/example.ts");
    expect(result.success).toBe(false);
    expect(result.failedEdits.length).toBeGreaterThanOrEqual(1);
  });

  // Test 9: Overlapping edits — partial success (non-overlapping edits applied)
  it("applies non-overlapping edits and reports overlapping ones as failed", () => {
    const content = `line one
line two
line three
line four
line five
`;
    const edits: EditOperation[] = [
      {
        path: "src/file.ts",
        oldCode: "line one",
        newCode: "line ONE",
        explanation: "Non-overlapping edit",
      },
      {
        path: "src/file.ts",
        oldCode: "line two\nline three",
        newCode: "line TWO\nline THREE",
        explanation: "Edit A: covers lines 2-3",
      },
      {
        path: "src/file.ts",
        oldCode: "line three\nline four",
        newCode: "line 3\nline 4",
        explanation: "Edit B: overlaps with edit A on line 3",
      },
    ];

    const result = applyEdits(content, edits, "src/file.ts");
    expect(result.success).toBe(false);
    // content should not be null — non-overlapping edits should be applied
    expect(result.content).not.toBeNull();
    expect(result.content).toContain("line ONE");
    expect(result.failedEdits.length).toBeGreaterThanOrEqual(1);
  });

  // Test 10: Normalized matching for partial-line edits (mid-line match)
  it("applies normalized match for partial-line edits with trailing whitespace", () => {
    // File has trailing spaces — old_code is a partial line without trailing spaces
    const content = `function foo() {  \n  const x = 1;  \n  return x;\n}\n`;
    const edits: EditOperation[] = [
      {
        path: "src/foo.ts",
        // Partial line match (not at line boundary)
        oldCode: "const x = 1;",
        newCode: "const x = 42;",
        explanation: "Change constant value via partial-line match",
      },
    ];

    const result = applyEdits(content, edits, "src/foo.ts");
    // Exact match should work here since "const x = 1;" exists without trailing space in substring
    expect(result.success).toBe(true);
    expect(result.content).toContain("const x = 42;");
  });
});
