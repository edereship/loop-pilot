export interface SkipReason {
  filePath: string;
  reason: string;
}

const NO_APPLICABLE_EDITS_DETAIL =
  "Claude returned no applicable edits for any selected file";

function sanitizeDetail(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{3,}/g, "``")
    .trim();
}

export function formatFileSkipReason(filePath: string, reason: unknown): SkipReason {
  const text = reason instanceof Error ? reason.message : String(reason);
  return { filePath, reason: sanitizeDetail(text) };
}

export function buildNoApplicableEditsDetail(skipReasons: SkipReason[]): string {
  if (skipReasons.length === 0) {
    return NO_APPLICABLE_EDITS_DETAIL;
  }

  const reasons = skipReasons
    .slice(0, 3)
    .map(({ filePath, reason }) => `${filePath}: ${sanitizeDetail(reason)}`)
    .join("; ");

  return `${NO_APPLICABLE_EDITS_DETAIL}. Reasons: ${reasons}`;
}
