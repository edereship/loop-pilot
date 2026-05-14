import type { Finding, PrContext } from "./types.js";

/**
 * Repair request payload passed to `anthropics/claude-code-action@v1`.
 *
 * The shape is deliberately stable so it can be JSON-serialized and embedded
 * in a workflow input. See TY-235 for the design and TY-236 for the workflow
 * integration that consumes this payload.
 */
export interface ClaudeCodeRepairRequest {
  version: 1;
  pr: {
    number: number;
    title: string;
    branch: string;
    headSha: string | null;
  };
  execution: {
    iteration: number;
    maxIterations: number;
    checkCommand: string;
    previousCheckFailure: string | null;
  };
  findings: ClaudeCodeRepairFinding[];
  instructions: string;
}

export interface ClaudeCodeRepairFinding {
  severity: "P0" | "P1" | "P2";
  path: string;
  line: number;
  title: string;
  body: string;
  /**
   * Always true: `path` / `line` mark the investigation entry point only,
   * not the bounded scope of the fix. Claude Code is expected to follow
   * callers, type definitions, tests, and configuration from there.
   */
  entryPointOnly: true;
}

/** Maximum characters preserved from a previous `CHECK_COMMAND` failure output. */
export const PREVIOUS_CHECK_FAILURE_MAX_CHARS = 20_000;

const SEVERITY_RANK: Record<ClaudeCodeRepairFinding["severity"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/**
 * Truncate a CHECK_COMMAND failure output to a safe length, keeping the tail.
 *
 * Tail-preserving truncation is preferred because CHECK_COMMAND output
 * (test runs, type checks, build logs) typically surfaces the actionable
 * error near the end. The returned string length is guaranteed to be at
 * most `maxChars`.
 */
export function truncatePreviousCheckFailure(
  output: string,
  maxChars: number = PREVIOUS_CHECK_FAILURE_MAX_CHARS
): string {
  if (output.length <= maxChars) return output;

  const buildHeader = (omitted: number): string =>
    `[... truncated ${omitted} leading characters of CHECK_COMMAND output; showing tail ...]\n`;

  // Worst-case header length (omitted at most output.length) reserves enough
  // budget so the final string never exceeds maxChars when there is room.
  const headerBudget = buildHeader(output.length).length;
  if (headerBudget >= maxChars) {
    // Budget is too small to fit a marker — just keep the tail verbatim.
    return output.slice(output.length - maxChars);
  }
  const tailRoom = maxChars - headerBudget;
  const tail = output.slice(output.length - tailRoom);
  const omitted = output.length - tail.length;
  return buildHeader(omitted) + tail;
}

function toRepairFinding(finding: Finding): ClaudeCodeRepairFinding {
  return {
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    title: finding.title,
    body: finding.body,
    entryPointOnly: true,
  };
}

function compareFindings(
  a: ClaudeCodeRepairFinding,
  b: ClaudeCodeRepairFinding
): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.body < b.body ? -1 : a.body > b.body ? 1 : 0;
}

const INSTRUCTION_LINES: readonly string[] = [
  "1. Each Codex finding's `path` and `line` mark an investigation entry point, NOT the bounded scope of the fix. Explore related files, callers, type definitions, existing tests, and configuration as needed to produce a consistent repair.",
  "2. Treat existing tests as the specification. If a test captures the intended behavior, do not weaken or rewrite it to make a faulty fix pass; fix the production code instead.",
  "3. If your edits surface type errors, test failures, or caller mismatches elsewhere in the repository, investigate those related sites and repair them so the codebase remains consistent.",
  "4. Make the minimal change required to address each finding. Do not perform unrelated refactors, formatting sweeps, dependency upgrades, or style changes.",
  "5. Do not read or output secrets such as API keys, tokens, credentials, or the contents of environment variables that may carry secrets.",
  "6. Do not assume network access. Do not add new external dependencies and do not call out to external services as part of the repair.",
  "7. Do not execute arbitrary shell commands. Only the configured CHECK_COMMAND is expected to run as part of verification.",
  "8. After your edits, the repository must be in a state where the configured CHECK_COMMAND succeeds. The workflow will run the final CHECK_COMMAND verification regardless of your own checks, so leave the tree in a verifiable state.",
];

/**
 * Build the canonical, deterministic repair request payload.
 *
 * Findings are sorted by (severity, path, line, title, body) so the payload
 * is stable regardless of the order findings arrive from the parser.
 */
export function buildClaudeCodeRepairRequest(input: {
  prContext: PrContext;
  headSha?: string | null;
  findings: Finding[];
  iteration: number;
  maxIterations: number;
  checkCommand: string;
  previousCheckFailure?: string | null;
}): ClaudeCodeRepairRequest {
  const findings = input.findings
    .map(toRepairFinding)
    .sort(compareFindings);

  const previousCheckFailure =
    input.previousCheckFailure == null
      ? null
      : truncatePreviousCheckFailure(input.previousCheckFailure);

  return {
    version: 1,
    pr: {
      number: input.prContext.number,
      title: input.prContext.title,
      branch: input.prContext.branch,
      headSha: input.headSha ?? null,
    },
    execution: {
      iteration: input.iteration,
      maxIterations: input.maxIterations,
      checkCommand: input.checkCommand,
      previousCheckFailure,
    },
    findings,
    instructions: INSTRUCTION_LINES.join("\n"),
  };
}

function formatFindingBlock(
  finding: ClaudeCodeRepairFinding,
  index: number
): string {
  return [
    `### Finding ${index + 1} — ${finding.severity}`,
    `- Entry point: ${finding.path}:${finding.line} (investigation start, not fix scope)`,
    `- Title: ${finding.title}`,
    "",
    finding.body.trim(),
  ].join("\n");
}

/**
 * Render a human-readable prompt for `claude-code-action` from a repair
 * request. The output covers PR context, findings, the constraints required
 * by TY-235, and an optional previous-failure block when applicable.
 */
export function buildClaudeCodeRepairPrompt(
  request: ClaudeCodeRepairRequest
): string {
  const { pr, execution, findings } = request;
  const headSha = pr.headSha ?? "(not provided)";

  const sections: string[] = [];

  sections.push("You are Claude Code performing repo-level repair on a pull request.");

  sections.push(
    [
      "## PR Context",
      `- PR #${pr.number}: ${pr.title}`,
      `- Branch: ${pr.branch}`,
      `- Head SHA: ${headSha}`,
      `- Iteration: ${execution.iteration} / ${execution.maxIterations}`,
      `- CHECK_COMMAND: \`${execution.checkCommand}\``,
    ].join("\n")
  );

  const findingsHeader = `## Codex Findings (${findings.length})`;
  if (findings.length === 0) {
    sections.push(`${findingsHeader}\n\n(no findings supplied)`);
  } else {
    const blocks = findings.map((f, i) => formatFindingBlock(f, i)).join("\n\n");
    sections.push(`${findingsHeader}\n\n${blocks}`);
  }

  sections.push(`## Instructions\n${INSTRUCTION_LINES.join("\n")}`);

  if (execution.previousCheckFailure != null) {
    // Use a fence delimiter longer than any backtick run in the content so
    // the fence cannot be closed early by backtick sequences inside the log.
    const longestRun = Math.max(
      2,
      ...Array.from(
        execution.previousCheckFailure.matchAll(/`+/g),
        (m) => m[0].length
      )
    );
    const fence = "`".repeat(longestRun + 1);
    sections.push(
      [
        "## Previous CHECK_COMMAND Failure",
        "The previous CHECK_COMMAND run failed with the output below. Use it as additional context for what to fix.",
        "",
        fence,
        execution.previousCheckFailure,
        fence,
      ].join("\n")
    );
  }

  return sections.join("\n\n") + "\n";
}

/**
 * Serialize the repair request to a deterministic JSON string suitable for
 * fixture snapshots and workflow inputs.
 *
 * Determinism relies on the builder producing objects with a fixed key
 * insertion order; `JSON.stringify` then emits keys in that same order.
 */
export function serializeClaudeCodeRepairRequest(
  request: ClaudeCodeRepairRequest
): string {
  return JSON.stringify(request, null, 2);
}
