import type { ParsedComment } from "./types";

// Leading \n is optional so the pattern matches when the footer is the only body content
const CODEX_FOOTER_PATTERN = /\n?Useful\? React with 👍 \/ 👎\.\s*$/;

// Stage 1: bare badge (P0) or bracketed badge ([P0])
const STAGE1_REGEX = /^\s*\[?(P[0-2])\]?\s*(.*)/;

// Stage 2: Markdown bold variants (**P0** or **[P0]**)
const STAGE2_REGEX = /^\s*(?:\*{2})?\[?(P[0-2])\]?(?:\*{2})?\s*(.*)/;

// Fallback: P0 or P1 keyword anywhere in text (P2 not included per spec)
const FALLBACK_KEYWORD_REGEX = /\b(P0|P1)\b/;

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
    const severity = stage1Match[1] as "P0" | "P1" | "P2";
    const title = stage1Match[2].trim();
    // Only accept if the match is not just a keyword buried in prose —
    // stage1 anchors at start so a match here is always a badge prefix.
    // However we must not accept a line like "Some text P0 buried" via stage1
    // because stage1 is anchored with \s* which would skip all leading space
    // but would still require the badge to be the first non-space token.
    return { severity, title, body };
  }

  // Attempt Stage 2 match against first line (Markdown bold variants)
  const stage2Match = STAGE2_REGEX.exec(firstLine);
  if (stage2Match) {
    const severity = stage2Match[1] as "P0" | "P1" | "P2";
    const title = stage2Match[2].trim();
    return { severity, title, body };
  }

  // Fallback: search entire stripped text for P0 or P1 keyword
  const fallbackMatch = FALLBACK_KEYWORD_REGEX.exec(stripped);
  if (fallbackMatch) {
    const severity = fallbackMatch[1] as "P0" | "P1";
    // Use first line as title in fallback
    return { severity, title: firstLine.trim(), body };
  }

  // No severity found
  return { severity: null, title: firstLine.trim(), body };
}
