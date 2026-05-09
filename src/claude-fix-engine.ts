import Anthropic from "@anthropic-ai/sdk";
import type { EditOperation, Finding, PrContext } from "./types.js";

export interface FixFileResult {
  edits: EditOperation[];
  skippedReason: string | null;
}

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

const EDIT_FILE_TOOL = {
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
    additionalProperties: false,
  },
  strict: true,
} as Anthropic.Tool & { strict: true };

export function buildSystemPrompt(iteration: number, maxIterations: number): string {
  const remainingIterations = Math.max(1, maxIterations - iteration + 1);
  const conservativeNote =
    remainingIterations < 3
      ? `\nIMPORTANT: Only ${remainingIterations} iteration(s) remaining. Prefer conservative, minimal fixes over ambitious rewrites. Prioritize P0 findings over P1, then P2 when iteration budget is limited.`
      : "";

  return `You are a senior software engineer fixing code review findings on a pull request.
You will receive Codex review findings (P0/P1/P2 severity) and the source file content.
Use the edit_file tool to make precise, minimal fixes for each finding.

Rules:
- Fix ONLY the listed P0/P1/P2 findings. Do not fix anything else.
- Do not perform unrelated refactors, style changes, or improvements.
- Do not change public APIs unless strictly necessary to fix a finding.
- Preserve existing behavior outside the scope of each finding.
- Each edit_file call must include an explanation of why the change fixes the finding.
- If a minimal safe fix is possible, call edit_file. Do not answer with text only for fixable findings.
- If a finding cannot be fixed safely without risking breakage, do NOT edit the file.
  Instead, respond with a text message explaining why the fix is unsafe.
- You will be told the current iteration number and max iterations.${conservativeNote}`;
}

function buildUserPrompt(
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[],
  iteration: number,
  maxIterations: number
): string {
  const findingsJson = JSON.stringify(
    findings.map(({ severity, line, title, body }) => ({ severity, line, title, body })),
    null,
    2
  );

  return `## PR Context
- PR #${prContext.number}: ${prContext.title}
- Branch: ${prContext.branch}
- Iteration: ${iteration} / ${maxIterations}

## Target File
Path: ${filePath}

\`\`\`
${fileContent}
\`\`\`

## Findings to Fix
${findingsJson}

Fix each finding above using the edit_file tool.`;
}

export function buildClaudeRequest(
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[],
  iteration: number,
  maxIterations: number
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: DEFAULT_CLAUDE_MODEL,
    max_tokens: 8192,
    system: buildSystemPrompt(iteration, maxIterations),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          prContext,
          filePath,
          fileContent,
          findings,
          iteration,
          maxIterations
        ),
      },
    ],
    tools: [EDIT_FILE_TOOL],
    tool_choice: { type: "auto" },
  };
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
export function parseEditOperations(
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
    .flatMap((block) => {
      const input = block.input as Record<string, unknown>;
      // Validate all required fields are strings — Claude may omit or mistype fields
      if (
        typeof input.path !== "string" ||
        typeof input.old_code !== "string" ||
        typeof input.new_code !== "string" ||
        typeof input.explanation !== "string"
      ) {
        return [];
      }
      return [{
        path: input.path,
        oldCode: input.old_code,
        newCode: input.new_code,
        explanation: input.explanation,
      }];
    });

  if (edits.length === 0) {
    return {
      edits: [],
      skippedReason: "Claude called edit_file, but all tool inputs were invalid.",
    };
  }

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
  let attempt = 0;

  while (true) {
    attempt++;

    try {
      const response = await client.messages.create(
        buildClaudeRequest(
          prContext,
          filePath,
          fileContent,
          findings,
          iteration,
          maxIterations
        )
      );

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
