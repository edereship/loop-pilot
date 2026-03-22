import type { EditOperation } from "./types.js";

export interface ApplyResult {
  success: boolean;
  content: string | null;
  failedEdits: EditOperation[];
}

/**
 * Find all start indices of `needle` in `haystack`.
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    indices.push(idx);
    searchFrom = idx + 1;
  }
  return indices;
}

/**
 * Normalize a string by converting CRLF→LF and trimming trailing whitespace
 * from each line, for fuzzy matching purposes.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/**
 * Find all normalized match positions of `normalizedNeedle` within
 * `normalizedHaystack`, returning start indices into the normalized haystack.
 */
function findNormalizedMatches(
  normalizedHaystack: string,
  normalizedNeedle: string
): number[] {
  return findAllOccurrences(normalizedHaystack, normalizedNeedle);
}

/**
 * Given a start index into the normalized haystack, compute how many characters
 * in the ORIGINAL content correspond to the match region.
 *
 * The mapping is built by iterating original lines alongside normalized lines,
 * tracking cumulative byte offsets in both strings.
 */
function findActualMatchLength(
  originalContent: string,
  normalizedContent: string,
  normalizedStartIndex: number,
  normalizedNeedle: string
): { originalStart: number; originalLength: number } | null {
  const originalLines = originalContent.split("\n");
  const normalizedLines = normalizedContent.split("\n");

  // Build a mapping: normalizedOffset[i] → originalOffset[i] for line starts
  let origOffset = 0;
  let normOffset = 0;
  const lineMap: Array<{ origStart: number; normStart: number }> = [];

  for (let i = 0; i < normalizedLines.length; i++) {
    lineMap.push({ origStart: origOffset, normStart: normOffset });
    origOffset += (originalLines[i] ?? "").length + 1; // +1 for \n
    normOffset += normalizedLines[i].length + 1; // +1 for \n
  }

  // Find which normalized line the match starts at
  const normalizedEndIndex = normalizedStartIndex + normalizedNeedle.length;

  let startLineIndex = -1;
  let endLineIndex = -1;

  for (let i = 0; i < lineMap.length; i++) {
    if (lineMap[i].normStart === normalizedStartIndex) {
      startLineIndex = i;
    }
    // End is exclusive — find the line where the match ends (before the trailing \n)
    const normLineEnd =
      lineMap[i].normStart + normalizedLines[i].length;
    if (normLineEnd === normalizedEndIndex) {
      endLineIndex = i;
      break;
    }
  }

  if (startLineIndex === -1 || endLineIndex === -1) {
    return null;
  }

  const originalStart = lineMap[startLineIndex].origStart;
  // Original end = start of next line (consuming the \n) — but we don't consume
  // the trailing \n of the last matched line; we only replace the matched text itself.
  // The original region covers from startLine.origStart to end of endLine (without trailing \n).
  const origEndLineStart = lineMap[endLineIndex].origStart;
  const origEndLineContent = originalLines[endLineIndex] ?? "";
  const originalEnd = origEndLineStart + origEndLineContent.length;

  return {
    originalStart,
    originalLength: originalEnd - originalStart,
  };
}

/**
 * Convert a character offset within `content` to a 1-based line number.
 */
function offsetToLine(content: string, offset: number): number {
  const before = content.slice(0, offset);
  return before.split("\n").length;
}

/**
 * Apply a list of edit operations to file content.
 *
 * Behavior:
 * - Tries exact match first; falls back to whitespace-normalized match.
 * - When old_code appears multiple times, selects the match nearest to lineHint.
 * - Applies edits in reverse order (bottom of file first) to avoid index shifts.
 * - All-or-nothing: if any edit cannot be matched, returns failure with null content.
 */
export function applyEdits(
  content: string,
  edits: EditOperation[],
  filePath: string,
  lineHints?: number[]
): ApplyResult {
  // Step 1: For each edit, resolve the match position in the original content.
  interface ResolvedEdit {
    edit: EditOperation;
    originalStart: number;
    originalLength: number;
  }

  const resolved: ResolvedEdit[] = [];
  const failedEdits: EditOperation[] = [];

  const normalizedContent = normalizeWhitespace(content);

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const lineHint = lineHints ? lineHints[i] : undefined;

    // Try exact match first
    let matchIndices = findAllOccurrences(content, edit.oldCode);
    let useNormalized = false;

    if (matchIndices.length === 0) {
      // Fall back to normalized match
      const normalizedOldCode = normalizeWhitespace(edit.oldCode);
      const normIndices = findNormalizedMatches(
        normalizedContent,
        normalizedOldCode
      );

      if (normIndices.length === 0) {
        failedEdits.push(edit);
        continue;
      }

      // Convert normalized indices back to original content positions
      const candidates: ResolvedEdit[] = [];
      for (const normIdx of normIndices) {
        const normalizedOldCode2 = normalizeWhitespace(edit.oldCode);
        const mapping = findActualMatchLength(
          content,
          normalizedContent,
          normIdx,
          normalizedOldCode2
        );
        if (mapping) {
          candidates.push({
            edit,
            originalStart: mapping.originalStart,
            originalLength: mapping.originalLength,
          });
        }
      }

      if (candidates.length === 0) {
        failedEdits.push(edit);
        continue;
      }

      // Select by lineHint if available
      const chosen = selectNearest(candidates, content, lineHint);
      resolved.push(chosen);
      useNormalized = true;
    } else {
      // Convert exact match indices to ResolvedEdit entries
      const candidates: ResolvedEdit[] = matchIndices.map((idx) => ({
        edit,
        originalStart: idx,
        originalLength: edit.oldCode.length,
      }));

      const chosen = selectNearest(candidates, content, lineHint);
      resolved.push(chosen);
    }
  }

  if (failedEdits.length > 0) {
    return { success: false, content: null, failedEdits };
  }

  // Step 2: Sort resolved edits by originalStart descending (bottom-first)
  resolved.sort((a, b) => b.originalStart - a.originalStart);

  // Step 3: Apply replacements from bottom to top
  let result = content;
  for (const { edit, originalStart, originalLength } of resolved) {
    result =
      result.slice(0, originalStart) +
      edit.newCode +
      result.slice(originalStart + originalLength);
  }

  return { success: true, content: result, failedEdits: [] };
}

/**
 * From a list of candidate resolved edits, select the one whose start line is
 * nearest to lineHint. If lineHint is undefined, returns the first candidate.
 */
function selectNearest(
  candidates: Array<{
    edit: EditOperation;
    originalStart: number;
    originalLength: number;
  }>,
  content: string,
  lineHint: number | undefined
): { edit: EditOperation; originalStart: number; originalLength: number } {
  if (candidates.length === 1 || lineHint === undefined) {
    return candidates[0];
  }

  let bestCandidate = candidates[0];
  let bestDistance = Math.abs(
    offsetToLine(content, candidates[0].originalStart) - lineHint
  );

  for (let i = 1; i < candidates.length; i++) {
    const line = offsetToLine(content, candidates[i].originalStart);
    const distance = Math.abs(line - lineHint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidates[i];
    }
  }

  return bestCandidate;
}
