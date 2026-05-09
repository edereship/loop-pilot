import Anthropic from "@anthropic-ai/sdk";
import { fixFile as defaultFixFile } from "./claude-fix-engine.js";
import { applyEdits } from "./edit-applier.js";
import type { EditOperation, Finding, PrContext } from "./types.js";

export interface SkippedFinding {
  finding: Finding;
  reason: string;
}

export interface SequentialFixResult {
  appliedEdits: EditOperation[];
  skippedFindings: SkippedFinding[];
  modifiedFiles: string[];
}

type FixFileFn = typeof defaultFixFile;

export interface SequentialFixOptions {
  client?: Anthropic;
  findings: Finding[];
  prContext: PrContext;
  iteration: number;
  maxIterations: number;
  maxInputTokensPerFile: number;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  fixFile?: FixFileFn;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function formatFindingLabel(finding: Finding): string {
  return `${finding.severity} ${finding.path}:${finding.line} ${finding.title}`;
}

function getSuccessfulEdits(
  edits: EditOperation[],
  failedEdits: EditOperation[],
): EditOperation[] {
  return edits.filter((edit) => !failedEdits.includes(edit));
}

export async function processFindingsSequentially(
  options: SequentialFixOptions,
): Promise<SequentialFixResult> {
  const fixFile = options.fixFile ?? defaultFixFile;
  const client = options.client ?? ({} as Anthropic);
  const contentByPath = new Map<string, string>();
  const changedContentByPath = new Map<string, string>();
  const appliedEdits: EditOperation[] = [];
  const skippedFindings: SkippedFinding[] = [];
  // Track which edits and findings belong to each file so write failures can be
  // rolled back from appliedEdits and surfaced as skipped findings.
  const editsByPath = new Map<string, EditOperation[]>();
  const findingsByPath = new Map<string, Finding[]>();

  for (const finding of options.findings) {
    let currentContent = contentByPath.get(finding.path);
    if (currentContent === undefined) {
      try {
        currentContent = options.readFile(finding.path);
        contentByPath.set(finding.path, currentContent);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Cannot read file";
        options.warn?.(`[sequential-fix] Skipping ${formatFindingLabel(finding)}: ${reason}`);
        skippedFindings.push({ finding, reason });
        continue;
      }
    }

    const estimatedTokens = Math.ceil(currentContent.length / 4);
    if (estimatedTokens > options.maxInputTokensPerFile) {
      const reason = `file estimated ${estimatedTokens} tokens exceeds max ${options.maxInputTokensPerFile}`;
      options.warn?.(`[sequential-fix] Skipping ${formatFindingLabel(finding)}: ${reason}`);
      skippedFindings.push({ finding, reason });
      continue;
    }

    try {
      options.log?.(`[sequential-fix] Fixing ${formatFindingLabel(finding)}`);
      const fixResult = await fixFile(
        client,
        options.prContext,
        finding.path,
        currentContent,
        [finding],
        options.iteration,
        options.maxIterations,
      );

      if (fixResult.skippedReason) {
        skippedFindings.push({ finding, reason: fixResult.skippedReason });
        continue;
      }

      if (fixResult.edits.length === 0) {
        skippedFindings.push({
          finding,
          reason: "Claude returned no edit_file calls.",
        });
        continue;
      }

      const applyResult = applyEdits(
        currentContent,
        fixResult.edits,
        finding.path,
      );

      const successfulEdits = applyResult.success
        ? fixResult.edits
        : getSuccessfulEdits(fixResult.edits, applyResult.failedEdits);

      let nextContent = applyResult.content;
      if (nextContent === null && successfulEdits.length > 0) {
        const successfulApplyResult = applyEdits(
          currentContent,
          successfulEdits,
          finding.path,
        );
        nextContent = successfulApplyResult.content;
      }

      if (successfulEdits.length === 0 || nextContent === null) {
        skippedFindings.push({
          finding,
          reason: "No returned edits could be applied to the latest file content.",
        });
        continue;
      }

      if (!applyResult.success) {
        skippedFindings.push({
          finding,
          reason: `${applyResult.failedEdits.length} edit(s) could not be applied and require manual follow-up.`,
        });
      }

      contentByPath.set(finding.path, nextContent);
      changedContentByPath.set(finding.path, nextContent);
      appliedEdits.push(...successfulEdits);

      // Track edits and findings per file so write failures can be rolled back.
      const fileEdits = editsByPath.get(finding.path) ?? [];
      fileEdits.push(...successfulEdits);
      editsByPath.set(finding.path, fileEdits);

      const fileFindings = findingsByPath.get(finding.path) ?? [];
      fileFindings.push(finding);
      findingsByPath.set(finding.path, fileFindings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.warn?.(`[sequential-fix] Skipping ${formatFindingLabel(finding)}: ${reason}`);
      skippedFindings.push({ finding, reason });
    }
  }

  const modifiedFiles: string[] = [];

  for (const [filePath, content] of changedContentByPath) {
    try {
      options.writeFile(filePath, content);
      modifiedFiles.push(filePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.warn?.(
        `[sequential-fix] Failed to write ${filePath}: ${reason}`,
      );

      // Roll back edits for this file from appliedEdits so the iteration is
      // not incorrectly treated as successful by the caller.
      const fileEdits = editsByPath.get(filePath) ?? [];
      if (fileEdits.length > 0) {
        const fileEditsSet = new Set(fileEdits);
        const kept = appliedEdits.filter((e) => !fileEditsSet.has(e));
        appliedEdits.splice(0, appliedEdits.length, ...kept);
      }

      // Surface the findings for this file as skipped so callers have full
      // visibility into what was not actually persisted.
      const fileFindings = findingsByPath.get(filePath) ?? [];
      for (const finding of fileFindings) {
        skippedFindings.push({
          finding,
          reason: `write failed: ${reason}`,
        });
      }
    }
  }

  return {
    appliedEdits,
    skippedFindings,
    modifiedFiles,
  };
}
