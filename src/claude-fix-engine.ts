import Anthropic from "@anthropic-ai/sdk";
import type { EditOperation, Finding, PrContext } from "./types.js";

export interface FixFileResult {
  edits: EditOperation[];
  skippedReason: string | null;
}

const MODEL = "claude-opus-4-0-20250514";

const EDIT_FILE_TOOL: Anthropic.Tool = {
  name: "edit_file",
  description: "Replace a specific code section in a file",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      old_code: { type: "string" },
      new_code: { type: "string" },
      explanation: { type: "string" },
    },
    required: ["path", "old_code", "new_code", "explanation"],
  },
};

function buildSystemPrompt(iteration: number, maxIterations: number): string {
  const remainingIterations = maxIterations - iteration;
  const conservativeNote =
    remainingIterations <= 2
      ? `\nIMPORTANT: Only ${remainingIterations} iteration(s) remaining. Be very conservative — only fix the most critical issues (P0) and ensure each fix is correct the first time.`
      : "";

  return `You are an automated code fix assistant. Your task is to fix code issues identified by code review.

Rules:
- Fix ONLY P0 (critical) and P1 (high priority) issues. Ignore P2 and lower.
- Make the MINIMAL change necessary to fix each issue. Do not refactor or improve unrelated code.
- Use the edit_file tool for EVERY fix. Do not output explanatory text without a corresponding tool call.
- Each edit_file call must replace exactly the problematic code section with the corrected version.
- The old_code field must match EXACTLY what appears in the file (including whitespace and indentation).
- If you cannot safely fix an issue without understanding more context, skip it rather than guess.
- Do not introduce new dependencies or change function signatures unless strictly required to fix the issue.
- If there are no fixable issues, do not call edit_file at all.${conservativeNote}`;
}

function buildUserPrompt(
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[]
): string {
  const findingsJson = JSON.stringify(findings, null, 2);

  return `## Pull Request Context
- PR #${prContext.number}: ${prContext.title}
- Branch: ${prContext.branch}

## File to Fix: ${filePath}

\`\`\`
${fileContent}
\`\`\`

## Findings to Fix

${findingsJson}

Please fix the P0 and P1 findings above using the edit_file tool. Make minimal, targeted changes.`;
}

/**
 * Determine if an error is retryable and how long to wait.
 * Returns null if the error should not be retried.
 */
interface RetryDecision {
  shouldRetry: boolean;
  waitMs: number;
}

function getRetryDecision(
  error: unknown,
  attempt: number
): RetryDecision {
  if (error instanceof Anthropic.RateLimitError) {
    // 429: exponential backoff 30s → 5min, max 3 retries
    if (attempt >= 3) return { shouldRetry: false, waitMs: 0 };
    const waitMs = Math.min(30_000 * Math.pow(2, attempt - 1), 300_000);
    return { shouldRetry: true, waitMs };
  }

  if (error instanceof Anthropic.InternalServerError) {
    // 500-503: exponential backoff 10s → 2min, max 3 retries
    const status = error.status;
    if (
      typeof status === "number" &&
      status >= 500 &&
      status <= 503
    ) {
      if (attempt >= 3) return { shouldRetry: false, waitMs: 0 };
      const waitMs = Math.min(10_000 * Math.pow(2, attempt - 1), 120_000);
      return { shouldRetry: true, waitMs };
    }
    return { shouldRetry: false, waitMs: 0 };
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    // timeout: fixed 30s, max 2 retries
    if (attempt >= 2) return { shouldRetry: false, waitMs: 0 };
    return { shouldRetry: true, waitMs: 30_000 };
  }

  // 408 (Request Timeout) via HTTP status
  if (
    error instanceof Error &&
    "status" in error &&
    (error as unknown as { status: number }).status === 408
  ) {
    if (attempt >= 2) return { shouldRetry: false, waitMs: 0 };
    return { shouldRetry: true, waitMs: 30_000 };
  }

  // 400 or other 4xx: no retry
  return { shouldRetry: false, waitMs: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse tool_use blocks from a Claude API response into EditOperation[].
 * Returns null if no tool calls were made (treat as skipped).
 */
function parseEditOperations(
  response: Anthropic.Message
): { edits: EditOperation[]; skippedReason: string | null } {
  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (toolUseBlocks.length === 0) {
    // Claude responded with text only — extract text as the skip reason
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    const reason =
      textBlocks.length > 0
        ? textBlocks.map((b) => b.text).join("\n").trim()
        : "Claude did not call edit_file (no explanation provided)";
    return { edits: [], skippedReason: reason };
  }

  const edits: EditOperation[] = toolUseBlocks
    .filter((block) => block.name === "edit_file")
    .map((block) => {
      const input = block.input as {
        path: string;
        old_code: string;
        new_code: string;
        explanation: string;
      };
      return {
        path: input.path,
        oldCode: input.old_code,
        newCode: input.new_code,
        explanation: input.explanation,
      };
    });

  return { edits, skippedReason: null };
}

/**
 * Call Claude with edit_file tool to get code fixes for a single file.
 * Retries on transient API errors according to the retry strategy.
 */
export async function fixFile(
  client: Anthropic,
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[],
  iteration: number,
  maxIterations: number
): Promise<FixFileResult> {
  const systemPrompt = buildSystemPrompt(iteration, maxIterations);
  const userPrompt = buildUserPrompt(prContext, filePath, fileContent, findings);

  let attempt = 0;

  while (true) {
    attempt++;

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [EDIT_FILE_TOOL],
        tool_choice: { type: "auto" },
      });

      return parseEditOperations(response);
    } catch (error) {
      const decision = getRetryDecision(error, attempt);

      if (!decision.shouldRetry) {
        // Re-throw non-retryable errors to let the caller handle them
        throw error;
      }

      await sleep(decision.waitMs);
      // Continue to next iteration (retry)
    }
  }
}

/**
 * Retry failed edits by creating synthetic findings from the failed edits'
 * explanations and calling fixFile with the current intermediate file content.
 */
export async function retryFailedEdits(
  client: Anthropic,
  prContext: PrContext,
  filePath: string,
  currentContent: string,
  failedEdits: EditOperation[],
  iteration: number,
  maxIterations: number
): Promise<FixFileResult> {
  // Convert failed edits into synthetic findings so fixFile can process them
  const syntheticFindings: Finding[] = failedEdits.map((edit, index) => ({
    severity: "P1" as const,
    path: filePath,
    // Use 0 as a placeholder line number since we don't have the original line
    line: 0,
    title: `Retry failed edit ${index + 1}`,
    body: edit.explanation,
  }));

  return fixFile(
    client,
    prContext,
    filePath,
    currentContent,
    syntheticFindings,
    iteration,
    maxIterations
  );
}
