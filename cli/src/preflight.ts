/**
 * Pre-flight framework (TY-346 framework; TY-347 fills in the check set).
 *
 * A pre-flight surfaces the silent-failure classes that otherwise only appear
 * after the first PR runs (missing label / Codex not connected / missing push
 * token / toolchain mismatch). Each check is independent and read-only; a check
 * that cannot determine its answer returns `unknown` (never a silent pass).
 *
 * Output: a human table by default and a stable JSON schema with `--json`.
 * Exit codes: 0 = no errors (warnings/unknown allowed), 1 = an error to fix
 * before the first PR, 2 = the check run itself could not proceed (handled by
 * the command when the context cannot be built — e.g. auth/repo resolution).
 */
import type { GhClient, Probe, RepoInfo } from "./gh.js";
import type { ToolchainDetection } from "./toolchain.js";

export type CheckStatus = "ok" | "warning" | "error" | "unknown";

export interface CheckResult {
  /** Stable machine id, e.g. "label.gate" or "secret.loopPilotPushToken". */
  id: string;
  status: CheckStatus;
  /** Short human text. */
  summary: string;
  /** Actionable detail. */
  details?: string;
  /** Concrete commands or UI steps to resolve. */
  nextSteps?: string[];
}

export interface PreflightReport {
  ok: boolean;
  repository: string;
  checks: CheckResult[];
}

/** Knobs the checks read. TY-347 extends this as it adds checks. */
export interface PreflightContext {
  repository: string;
  gh: GhClient;
  /** Detected toolchain (from `init` detection), if available. */
  toolchain?: ToolchainDetection;
  /** Effective CHECK_COMMAND the operator configured / the CLI suggests. */
  checkCommand?: string;
  /** Gate label name (vars.LOOPPILOT_LABEL || "loop-pilot"). */
  label?: string;
  /** Whether full-auto is configured (label not required when true). */
  fullAuto?: boolean;

  // ── TY-347 gathered signals (populated by gatherSignals; checks interpret) ──
  /** Default branch name (for the branch-protection probe). */
  defaultBranch?: string;
  /** LOOPPILOT_AUTO_MERGE === "true". */
  autoMerge?: boolean;
  /** Resolved Codex bot login (vars.CODEX_BOT_LOGIN || default). */
  codexBotLogin?: string;
  /** Secret NAMES, or a failed probe (e.g. 403). */
  secretNames?: Probe<string[]>;
  /** Required status-check contexts on the default branch (value [] = none). */
  requiredChecks?: Probe<string[]>;
  /** Repo default-branch + allow-auto-merge setting. */
  repoInfo?: Probe<RepoInfo>;
  /** Whether recent Codex bot activity was seen (inference). */
  codexSeen?: Probe<boolean>;
}

export type Check = (ctx: PreflightContext) => Promise<CheckResult>;

/**
 * Run all checks. A check that throws is converted to an `unknown` result so
 * one failing probe never aborts the whole pre-flight (and never silently
 * passes).
 */
export async function runPreflight(checks: Check[], ctx: PreflightContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const check of checks) {
    try {
      out.push(await check(ctx));
    } catch (e) {
      out.push({
        id: "check.error",
        status: "unknown",
        summary: "a check could not run",
        details: e instanceof Error ? e.message : String(e),
        nextSteps: ["Re-run `gh looppilot doctor`; if it persists, check `gh auth status` and repo permissions."],
      });
    }
  }
  return out;
}

export function buildReport(repository: string, checks: CheckResult[]): PreflightReport {
  // ok iff no hard errors. warning / unknown do NOT fail the report (exit 0),
  // matching the TY-347 exit-code contract.
  const ok = !checks.some((c) => c.status === "error");
  return { ok, repository, checks };
}

/** 0 = no errors, 1 = at least one error. (2 is set by the command on a build failure.) */
export function exitCodeForReport(report: PreflightReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

export function formatJson(report: PreflightReport): string {
  // Stable field order so downstream tooling / snapshots are deterministic.
  return JSON.stringify(
    {
      ok: report.ok,
      repository: report.repository,
      checks: report.checks.map((c) => ({
        id: c.id,
        status: c.status,
        summary: c.summary,
        details: c.details ?? null,
        nextSteps: c.nextSteps ?? [],
      })),
    },
    null,
    2,
  );
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "✓ OK   ",
  warning: "! WARN ",
  error: "✗ ERROR",
  unknown: "? UNKWN",
};

/** Human-readable grouped table. */
export function formatTable(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`LoopPilot pre-flight — ${report.repository}`);
  lines.push("");
  for (const c of report.checks) {
    lines.push(`${STATUS_GLYPH[c.status]}  ${c.id}  —  ${c.summary}`);
    if (c.details) lines.push(`           ${c.details}`);
    for (const step of c.nextSteps ?? []) {
      lines.push(`           → ${step}`);
    }
  }
  lines.push("");
  const counts = countByStatus(report.checks);
  lines.push(
    `Summary: ${counts.ok} ok, ${counts.warning} warning, ${counts.error} error, ${counts.unknown} unknown` +
      ` — ${report.ok ? "no blocking errors" : "fix the errors above before the first PR"}`,
  );
  return lines.join("\n");
}

export function countByStatus(checks: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warning: 0, error: 0, unknown: 0 };
  for (const c of checks) counts[c.status]++;
  return counts;
}
