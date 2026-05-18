import type { Finding, PrContext, Severity } from "./types.js";

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
    findingsTruncated: FindingsTruncationStats;
  };
  findings: ClaudeCodeRepairFinding[];
  /**
   * Effective scope policy applied by the post-fix step (TY-278). `null` when
   * the caller could not derive the policy (e.g. unexpected parse error); the
   * prompt then omits the policy section and Claude falls back to the
   * pre-TY-278 behaviour of learning the boundary from `scope_violation`
   * rejections after the fact.
   */
  scopePolicy: ClaudeCodeRepairScopePolicy | null;
  instructions: string;
}

export interface FindingsTruncationStats {
  /** Number of findings received from the parser before any cap. */
  received: number;
  /** Number of findings embedded in the payload (= min(received, MAX_FINDINGS_PER_REQUEST)). */
  embedded: number;
  /** Total body chars from findings fully dropped by the count cap. */
  droppedFindingChars: number;
  /** Total body chars trimmed by the per-body cap (does not include dropped findings). */
  truncatedBodyChars: number;
}

export interface ClaudeCodeRepairFinding {
  severity: Severity;
  path: string;
  /**
   * 1-based line number from Codex, or `null` for file-level / outdated
   * comments (TY-280). The prompt builder formats `null` as `(file-level)`
   * rather than `path:0`, which would otherwise be read as a real first-line
   * anchor.
   */
  line: number | null;
  title: string;
  body: string;
  /**
   * Always true: `path` / `line` mark the investigation entry point only,
   * not the bounded scope of the fix. Claude Code is expected to follow
   * callers, type definitions, tests, and configuration from there.
   */
  entryPointOnly: true;
}

/**
 * Effective scope policy surfaced to claude-code-action via the repair prompt
 * (TY-278). The post-fix step enforces the same policy after the run, so
 * sharing it up-front lets Claude avoid edits that would be reverted server-
 * side (e.g. modifications under `.github/`).
 */
export interface ClaudeCodeRepairScopePolicy {
  /**
   * Effective blocked paths in display order. Removals (`!path`) are already
   * resolved — the operator's spec is not exposed to Claude verbatim.
   */
  blockedPaths: readonly ClaudeCodeBlockedPath[];
  /** Effective max changed-file count. Mirrors `ScopeCheckPolicy.maxFiles`. */
  maxFiles: number;
  /** Effective max changed-line count (added + deleted). */
  maxLines: number;
  /**
   * Root-level dotfiles (paths matching /^\.[^/]+$/) are always blocked by
   * the post-fix step via its ROOT_DOTFILE_RE fallback unless they appear here.
   * `undefined` is treated as an empty array (no exemptions, all root dotfiles
   * blocked). Mirrors `ScopeCheckPolicy.exemptedRootDotfiles`.
   */
  exemptedRootDotfiles?: readonly string[];
}

export interface ClaudeCodeBlockedPath {
  /** Repo-relative path or directory prefix (trailing slash for directories). */
  path: string;
  /**
   * True iff the entry cannot be unblocked via `AUTO_REVIEW_BLOCK_PATHS=!path`.
   * Currently only `.github/` is locked.
   */
  locked: boolean;
}

/** Maximum characters preserved from a previous `CHECK_COMMAND` failure output. */
export const PREVIOUS_CHECK_FAILURE_MAX_CHARS = 20_000;

/** Maximum number of findings embedded in a single repair request. */
export const MAX_FINDINGS_PER_REQUEST = 30;

/** Maximum characters preserved from a single finding's body. */
export const MAX_FINDING_BODY_CHARS = 4_000;

/** Fraction of the truncation budget allocated to head (vs. tail). 25% head / 75% tail. */
const HEAD_RATIO = 0.25;

const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function buildMiddleMarker(
  omitted: number,
  head: number,
  tail: number
): string {
  return `[... truncated ${omitted} characters from the middle of CHECK_COMMAND output; kept ${head} head + ${tail} tail ...]\n`;
}

/**
 * Truncate a CHECK_COMMAND failure output to a safe length, keeping a head
 * slice and a tail slice with a middle marker.
 *
 * jest / vitest / pytest surface actionable errors at the tail, while tsc /
 * eslint surface the first actionable error at the head. Splitting the
 * `maxChars` budget 25 / 75 between head and tail covers both patterns. The
 * returned string length is guaranteed to be at most `maxChars`.
 */
export function truncatePreviousCheckFailure(
  output: string,
  maxChars: number = PREVIOUS_CHECK_FAILURE_MAX_CHARS
): string {
  if (output.length <= maxChars) return output;

  // Worst-case marker length uses upper bounds on omitted / head / tail so
  // the actual marker can only be shorter than what we reserve. The extra
  // +1 reserves space for an optional leading "\n" inserted when the head
  // slice doesn't already end with a newline.
  const worstMarker = buildMiddleMarker(output.length, maxChars, maxChars);
  const reservedMarkerBudget = worstMarker.length + 1;
  if (reservedMarkerBudget >= maxChars) {
    // Budget is too small to fit head + marker + tail — fall back to tail
    // verbatim (same shape as the original tail-only truncation fallback).
    return output.slice(output.length - maxChars);
  }

  const remainingBudget = maxChars - reservedMarkerBudget;
  const headRoom = Math.floor(remainingBudget * HEAD_RATIO);
  const tailRoom = remainingBudget - headRoom;

  const head = output.slice(0, headRoom);
  const tail = output.slice(output.length - tailRoom);
  const omitted = output.length - head.length - tail.length;
  const marker = buildMiddleMarker(omitted, head.length, tail.length);
  const leadingNewline = head.endsWith("\n") ? "" : "\n";
  return head + leadingNewline + marker + tail;
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
  // TY-280: file-level findings (line === null) sort before inline findings
  // so Claude reads broader-scope guidance first within the same severity/path
  // tiebreaker bucket.
  const al = a.line ?? -1;
  const bl = b.line ?? -1;
  if (al !== bl) return al - bl;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.body < b.body ? -1 : a.body > b.body ? 1 : 0;
}

function buildFindingBodyMarker(omitted: number): string {
  return `[... truncated ${omitted} leading characters of finding body; showing tail ...]\n`;
}

/**
 * Truncate a finding body to at most `maxChars` keeping the tail, matching
 * the marker style used by `truncatePreviousCheckFailure`'s tail fallback.
 *
 * Returns the (possibly unchanged) body and the number of leading characters
 * removed, so `applyFindingCaps` can aggregate `truncatedBodyChars`.
 */
function truncateFindingBody(
  body: string,
  maxChars: number = MAX_FINDING_BODY_CHARS
): { body: string; droppedChars: number } {
  if (body.length <= maxChars) return { body, droppedChars: 0 };

  // Worst-case marker uses omitted = body.length, an upper bound that ensures
  // the actual marker is no longer than what we reserve from the budget.
  const worstMarker = buildFindingBodyMarker(body.length);
  if (worstMarker.length >= maxChars) {
    // Budget too small for any marker — keep the tail verbatim.
    const truncated = body.slice(body.length - maxChars);
    return { body: truncated, droppedChars: body.length - truncated.length };
  }

  const tailRoom = maxChars - worstMarker.length;
  const tail = body.slice(body.length - tailRoom);
  const omitted = body.length - tail.length;
  const marker = buildFindingBodyMarker(omitted);
  return { body: marker + tail, droppedChars: omitted };
}

/**
 * Apply count cap and per-body cap to an already-sorted list of findings.
 *
 * `findings` MUST be sorted by `compareFindings` before calling, so the count
 * cap retains the highest-priority entries deterministically. The function
 * does NOT re-sort after truncation — body changes would otherwise shift the
 * (severity, path, line, title, body) tiebreaker order.
 */
function applyFindingCaps(findings: ClaudeCodeRepairFinding[]): {
  kept: ClaudeCodeRepairFinding[];
  stats: FindingsTruncationStats;
} {
  const received = findings.length;
  const dropped = findings.slice(MAX_FINDINGS_PER_REQUEST);
  const droppedFindingChars = dropped.reduce(
    (sum, f) => sum + f.body.length,
    0
  );

  const survivors = findings.slice(0, MAX_FINDINGS_PER_REQUEST);

  let truncatedBodyChars = 0;
  const kept = survivors.map((finding) => {
    const { body, droppedChars } = truncateFindingBody(finding.body);
    truncatedBodyChars += droppedChars;
    return droppedChars === 0 ? finding : { ...finding, body };
  });

  return {
    kept,
    stats: {
      received,
      embedded: kept.length,
      droppedFindingChars,
      truncatedBodyChars,
    },
  };
}

const INSTRUCTION_LINES: readonly string[] = [
  "1. Each Codex finding's `path` and `line` mark an investigation entry point, NOT the bounded scope of the fix. Explore related files, callers, type definitions, existing tests, and configuration as needed to produce a consistent repair.",
  "2. Treat existing tests as the specification. If a test captures the intended behavior, do not weaken or rewrite it to make a faulty fix pass; fix the production code instead.",
  "3. If your own edits cause new type errors, test failures, or caller mismatches elsewhere in the repository, you MUST fix those induced breakages — they count as part of the repair, not as \"unrelated refactor\". Do not, however, fix pre-existing issues that your edits did not surface.",
  "4. Beyond #3, make the minimal change required to address each finding. Do not perform unrelated refactors, formatting sweeps, dependency upgrades, or style changes for code you did not need to touch.",
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
  /**
   * Effective scope policy enforced by post-fix (TY-278). `null` / undefined
   * omits the scope policy section from the rendered prompt.
   */
  scopePolicy?: ClaudeCodeRepairScopePolicy | null;
}): ClaudeCodeRepairRequest {
  // Sort once, then apply count + body caps in that locked order. Do not
  // re-sort afterwards — body truncation would otherwise alter the tiebreaker.
  const sorted = input.findings.map(toRepairFinding).sort(compareFindings);
  const { kept: findings, stats: findingsTruncated } = applyFindingCaps(sorted);

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
      findingsTruncated,
    },
    findings,
    scopePolicy: input.scopePolicy ?? null,
    instructions: INSTRUCTION_LINES.join("\n"),
  };
}

function formatFindingBlock(
  finding: ClaudeCodeRepairFinding,
  index: number
): string {
  // TY-280: render file-level findings (line === null) as `path (file-level — …)`
  // instead of `path:0`, which Claude would otherwise read as a real first-line
  // anchor. Codex inline review comments use line=null for file-level / outdated
  // comments and historically all surfaced as `:0` after review-collector
  // collapsed null to 0.
  const entryPoint =
    finding.line === null
      ? `${finding.path} (file-level — no specific line; investigation start, not fix scope)`
      : `${finding.path}:${finding.line} (investigation start, not fix scope)`;
  return [
    `### Finding ${index + 1} — ${finding.severity}`,
    `- Entry point: ${entryPoint}`,
    `- Title: ${finding.title}`,
    "",
    finding.body.trim(),
  ].join("\n");
}

function formatBlockedPathEntry(entry: ClaudeCodeBlockedPath): string {
  return entry.locked
    ? `  - ${entry.path} (structurally locked, cannot be overridden)`
    : `  - ${entry.path}`;
}

function formatScopePolicySection(policy: ClaudeCodeRepairScopePolicy): string {
  const blockedHeader =
    policy.blockedPaths.length > 0
      ? "- Blocked paths (do not modify; reverted server-side after your run):"
      : "- Blocked paths: (none configured)";
  const blockedLines = policy.blockedPaths.map(formatBlockedPathEntry);
  const exempted = policy.exemptedRootDotfiles ?? [];
  const dotfileRule =
    exempted.length > 0
      ? `- Root dotfiles (any \`.*\` file at repo root): blocked — exempted: ${[...exempted].sort().join(", ")}`
      : "- Root dotfiles (any `.*` file at repo root): blocked";
  return [
    "## Scope Policy (your edits must satisfy)",
    blockedHeader,
    ...blockedLines,
    dotfileRule,
    `- Max files changed: ${policy.maxFiles}`,
    `- Max lines changed (added + deleted): ${policy.maxLines}`,
    "",
    "If a faithful repair would exceed these limits, stop and explain rather than producing a partial fix that will be reverted.",
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

  const { received, embedded } = execution.findingsTruncated;
  const droppedCount = received - embedded;
  const findingsHeader =
    droppedCount > 0
      ? `## Codex Findings (${embedded} of ${received} — ${droppedCount} truncated due to per-request cap)`
      : `## Codex Findings (${findings.length})`;
  if (findings.length === 0) {
    sections.push(`${findingsHeader}\n\n(no findings supplied)`);
  } else {
    const blocks = findings.map((f, i) => formatFindingBlock(f, i)).join("\n\n");
    sections.push(`${findingsHeader}\n\n${blocks}`);
  }

  // TY-278: Surface the effective scope policy between Codex Findings and
  // Instructions so Claude can read the boundary right before the action
  // checklist. `null` falls back to the pre-TY-278 behaviour (section omitted).
  if (request.scopePolicy !== null) {
    sections.push(formatScopePolicySection(request.scopePolicy));
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
