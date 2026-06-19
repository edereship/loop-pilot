/**
 * Heuristics for detecting non-review status messages that Codex posts in
 * place of a real review — currently scoped to usage-limit / quota-exceeded
 * notices. These look like ordinary bot comments but contain no findings, so
 * without explicit detection the loop would mis-classify them as
 * `no_findings` and mark the LoopPilot `done`.
 *
 * The patterns are anchored to phrases observed in production (see
 * `tests/fixtures/codex-usage-limit.txt`) and tolerate small wording drift
 * (singular/plural, "code review" vs "reviews").
 *
 * **Keep aligned with `.github/workflows/looppilot-loop.yml`.** The
 * workflow trigger filter (TY-229) admits Codex bot messages containing
 * `"Codex usage limit"` or `"Codex quota"` as substrings (case-insensitive).
 * Patterns added here that do not contain one of those substrings will not
 * fire in production because the workflow drops the message before
 * `runPreFix` runs.
 */

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /reached your codex usage limits?(?: for code reviews?)?/i,
  /codex usage limits? (?:reached|exceeded)/i,
  /you have (?:exceeded|reached|hit) (?:the )?codex (?:usage )?(?:limits?|cap)/i,
  /codex quota (?:limits? (?:reached|exceeded)|exceeded|has been exceeded)/i,
  /codex (?:is (?:currently )?)?rate limited/i,
  /(?:hit|reached|exceeded) (?:the )?codex (?:rate )?limit/i,
  /codex limit exceeded/i,
  /codex usage cap (?:has been )?(?:reached|exceeded)/i,
  /your codex (?:quota|usage cap) has been (?:reached|exceeded)/i,
];

export function isCodexUsageLimitMessage(body: string): boolean {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(body));
}
