import type { ParsedComment, Severity } from "./types.js";

// Leading \n is optional so the pattern matches when the footer is the only body content
const CODEX_FOOTER_PATTERN = /\n?Useful\? React with 👍 \/ 👎\.\s*$/;
// TY-273 #B1: accept any single-severity or `/`-joined chain of severities
// (`No P0 findings`, `No P0/P1 findings`, `No P2/P3 findings`, etc.). The
// earlier expression only matched `no findings` or the literal `no p0/p1
// findings`, so wording like `No P0 findings.` slipped through and was then
// re-classified as a P0 finding by FALLBACK_KEYWORD_REGEX. Mirrors the
// `specificNoFindingsMatches` pattern in `src/review-collector.ts` so the
// two layers agree on what counts as a "no findings" sentence.
const NO_FINDINGS_PATTERN =
  /\bno\s+(?:p[0-3](?:\s*\/\s*p[0-3])*\s+)?findings?\b|\b0\s+findings?\b|\bno\s+issues?\b/i;

// Stage 1: bare badge (P0) or bracketed badge ([P0]). Extended to P0..P3 (TY-256).
const STAGE1_REGEX = /^\s*\[?(P[0-3])\]?\s*(.*)/;

// Stage 2: Markdown bold variants (**P0** or **[P0]**). Extended to P0..P3 (TY-256).
const STAGE2_REGEX = /^\s*(?:\*{2})?\[?(P[0-3])\]?(?:\*{2})?\s*(.*)/;

// Codex currently renders severity as an image badge:
// **<sub><sub>![P2 Badge](...)</sub></sub>  Title**
// Extended to P0..P3 (TY-256).
const IMAGE_BADGE_REGEX = /!\[(P[0-3])\s+Badge\]\([^)]+\)(?:\s*<\/sub>)*\s*(.*)$/i;

// Fallback: P0 or P1 keyword anywhere in text. Intentionally not extended to
// P2/P3 — looser patterns risk false positives (e.g., the strings "P2" / "P3"
// appearing in code or prose unrelated to severity tags). P2/P3 must carry an
// explicit badge to be recognized (TY-256).
const FALLBACK_KEYWORD_REGEX = /\b(P0|P1)\b/;

const SEVERITY_ORDER: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/** Severity 全列挙 (urgency 順)。 */
export const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3"];

/** 文字列が有効な Severity か。 */
export function isSeverity(value: string): value is Severity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

/**
 * 2 つの severity を urgency 順で比較する。
 * 戻り値が負なら `a` の方が緊急、正なら `b` の方が緊急、0 なら同等。
 */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

/**
 * `severity` が `threshold` 以上の urgency か (= 修正対象に含めるか) を返す。
 *
 * threshold は「これより低い (= 数値が大きい) severity を除外する」境界として
 * 使う。例: threshold=`P1` → P0/P1 は含む、P2/P3 は除外。threshold=`P3` は
 * すべてを含む (実質 filter なし)。
 */
export function isAtLeastSeverity(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[threshold];
}

/**
 * Parses a raw Codex inline comment body into severity, title, and body.
 *
 * Why staged regex: Codex posts severity in multiple formats (bare, bracketed,
 * Markdown bold). We cascade from most-specific to least-specific to avoid
 * false positives from looser patterns.
 */
export function parseSeverity(rawBody: string): ParsedComment {
  // Preprocess: strip leading whitespace/newlines before regex application
  const stripped = rawBody.replace(/^[\s\n]+/, "");

  // Split into first line (title candidate) and remainder (body candidate)
  const doubleNewlineIndex = stripped.indexOf("\n\n");
  const firstLine =
    doubleNewlineIndex === -1
      ? stripped
      : stripped.slice(0, doubleNewlineIndex);
  const rawBodyPart =
    doubleNewlineIndex === -1 ? "" : stripped.slice(doubleNewlineIndex + 2);

  // Remove Codex footer from body
  const body = rawBodyPart.replace(CODEX_FOOTER_PATTERN, "").trim();

  // Attempt Stage 1 match against first line
  const stage1Match = STAGE1_REGEX.exec(firstLine);
  if (stage1Match) {
    const severity = stage1Match[1] as Severity;
    const title = stage1Match[2].trim();
    // Only accept if the match is not just a keyword buried in prose —
    // stage1 anchors at start so a match here is always a badge prefix.
    // However we must not accept a line like "Some text P0 buried" via stage1
    // because stage1 is anchored with \s* which would skip all leading space
    // but would still require the badge to be the first non-space token.
    return { severity, title: cleanTitle(title), body };
  }

  // Attempt Stage 2 match against first line (Markdown bold variants)
  const stage2Match = STAGE2_REGEX.exec(firstLine);
  if (stage2Match) {
    const severity = stage2Match[1] as Severity;
    const title = stage2Match[2].trim();
    return { severity, title: cleanTitle(title), body };
  }

  const imageBadgeMatch = IMAGE_BADGE_REGEX.exec(firstLine);
  if (imageBadgeMatch) {
    const severity = imageBadgeMatch[1].toUpperCase() as Severity;
    const title = imageBadgeMatch[2].trim();
    return { severity, title: cleanTitle(title), body };
  }

  // Fallback: search entire stripped text for P0 or P1 keyword
  if (NO_FINDINGS_PATTERN.test(firstLine)) {
    return { severity: null, title: firstLine.trim(), body };
  }
  const fallbackMatch = FALLBACK_KEYWORD_REGEX.exec(stripped);
  if (fallbackMatch) {
    const severity = fallbackMatch[1] as "P0" | "P1";
    // Use first line as title in fallback
    return { severity, title: firstLine.trim(), body };
  }

  // No severity found
  return { severity: null, title: firstLine.trim(), body };
}

function cleanTitle(title: string): string {
  return title
    .trim()
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .trim();
}
