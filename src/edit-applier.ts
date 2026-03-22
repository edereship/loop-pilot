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
 * Uses a character-level offset map so that matches starting mid-line (not at
 * a line boundary) are correctly resolved — the previous line-boundary-only
 * approach returned null for partial-line edits.
 */
function findActualMatchLength(
  originalContent: string,
  normalizedContent: string,
  normalizedStartIndex: number,
  normalizedNeedle: string
): { originalStart: number; originalLength: number } | null {
  const originalLines = originalContent.split("\n");
  const normalizedLines = normalizedContent.split("\n");

  if (originalLines.length !== normalizedLines.length) {
    return null;
  }

  // Build character-level offset map from normalized → original positions
  // by iterating line-by-line and tracking cumulative offsets.
  let origOffset = 0;
  let normOffset = 0;

  const normalizedEndIndex = normalizedStartIndex + normalizedNeedle.length;

  let originalStart = -1;
  let originalEnd = -1;

  for (let i = 0; i < normalizedLines.length; i++) {
    const origLine = originalLines[i] ?? "";
    const normLine = normalizedLines[i];
    const normLineStart = normOffset;
    const normLineEnd = normOffset + normLine.length;

    // Check if this line overlaps with the match region
    if (normalizedStartIndex >= normLineStart && normalizedStartIndex <= normLineEnd) {
      // Match starts within this line
      const intraLineOffset = normalizedStartIndex - normLineStart;
      // Map to same intra-line offset in the original (whitespace-normalized
      // only trims trailing, so leading content is positionally equivalent)
      originalStart = origOffset + Math.min(intraLineOffset, origLine.length);
    }

    if (normalizedEndIndex >= normLineStart && normalizedEndIndex <= normLineEnd) {
      // Match ends within this line
      const intraLineOffset = normalizedEndIndex - normLineStart;
      originalEnd = origOffset + Math.min(intraLineOffset, origLine.length);
    }

    origOffset += origLine.length + 1; // +1 for \n
    normOffset += normLine.length + 1; // +1 for \n

    if (originalStart !== -1 && originalEnd !== -1) {
      break;
    }
  }

  if (originalStart === -1 || originalEnd === -1 || originalEnd < originalStart) {
    return null;
  }

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

  // Step 2.5: Detect overlapping edit ranges (sorted descending, so check next.end > current.start)
  for (let i = 0; i < resolved.length - 1; i++) {
    const current = resolved[i]; // higher start (later in file)
    const next = resolved[i + 1]; // lower start (earlier in file)
    const nextEnd = next.originalStart + next.originalLength;
    if (nextEnd > current.originalStart) {
      failedEdits.push(current.edit);
      resolved.splice(i, 1);
      i--;
    }
  }

  // Partial failure: apply non-overlapping edits, report overlapping ones as failed
  if (failedEdits.length > 0 && resolved.length === 0) {
    return { success: false, content: null, failedEdits };
  }

  // Step 3: Apply replacements from bottom to top
  let result = content;
  for (const { edit, originalStart, originalLength } of resolved) {
    result =
      result.slice(0, originalStart) +
      edit.newCode +
      result.slice(originalStart + originalLength);
  }

  // Partial success: some edits applied, some overlapping ones failed
  if (failedEdits.length > 0) {
    return { success: false, content: result, failedEdits };
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
