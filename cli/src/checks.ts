/**
 * Pre-flight checks (TY-346 core set: label + toolchain). TY-347 adds the
 * secret / branch-protection / Codex-inference / auth checks to `allChecks`.
 *
 * Each check is a `Check`: read-only, returns a `CheckResult`, and degrades to
 * `unknown` (never a silent pass) when it lacks permission to determine the
 * answer.
 */
import { GhError } from "./gh.js";
import type { Check, CheckResult, PreflightContext } from "./preflight.js";
import { validateCheckCommand } from "./check-command-allowlist.js";
import type { Ecosystem } from "./toolchain.js";

export const DEFAULT_LABEL = "loop-pilot";
export const LABEL_COLOR = "BFD4F2";
export const LABEL_DESCRIPTION = "Run LoopPilot on this PR";

/** Gate label existence (the #1 silent-failure: no label → no workflow runs). */
export const labelCheck: Check = async (ctx: PreflightContext): Promise<CheckResult> => {
  const label = ctx.label || DEFAULT_LABEL;
  if (ctx.fullAuto) {
    return {
      id: "label.gate",
      status: "ok",
      summary: `full-auto mode: gate label not required`,
      details: `LOOPPILOT_FULL_AUTO=true runs every non-fork PR; the '${label}' label is not needed.`,
    };
  }
  try {
    const exists = await ctx.gh.labelExists(ctx.repository, label);
    if (exists) {
      return { id: "label.gate", status: "ok", summary: `gate label '${label}' exists` };
    }
    return {
      id: "label.gate",
      status: "error",
      summary: `gate label '${label}' is missing`,
      details:
        "Without the gate label, the workflow `if:` evaluates false and NO Actions run is generated — the most common silent failure.",
      nextSteps: [
        `gh label create ${label} --color ${LABEL_COLOR} --description "${LABEL_DESCRIPTION}"`,
        "…or set the Repository variable LOOPPILOT_FULL_AUTO=true to run on every non-fork PR.",
      ],
    };
  } catch (e) {
    if (e instanceof GhError && e.status === 403) {
      return {
        id: "label.gate",
        status: "unknown",
        summary: `cannot read labels for ${ctx.repository} (HTTP 403)`,
        details: "The token lacks permission to list labels; cannot confirm the gate label.",
        nextSteps: ["Re-run with a `gh` session that has read access to the repository's issues/labels."],
      };
    }
    throw e;
  }
};

const ECOSYSTEM_BINARIES: Record<string, Ecosystem> = {
  npm: "node",
  pnpm: "node",
  yarn: "node",
  bun: "node",
  npx: "node",
  pytest: "python",
  python: "python",
  python3: "python",
  go: "go",
  cargo: "rust",
  make: "make",
};

function ecosystemOfCommand(cmd: string): Ecosystem | null {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return ECOSYSTEM_BINARIES[first] ?? null;
}

/**
 * CHECK_COMMAND safety + toolchain consistency (the #4 silent-failure: a
 * non-matching toolchain means CHECK_COMMAND can't run and every fix reverts).
 */
export const toolchainCheck: Check = async (ctx: PreflightContext): Promise<CheckResult> => {
  const cmd = (ctx.checkCommand ?? "").trim();
  if (!cmd) {
    return {
      id: "toolchain.checkCommand",
      status: "warning",
      summary: "CHECK_COMMAND is not set",
      details: "Post-fix runs CHECK_COMMAND to verify each fix; without it the default `npm run check` is used.",
      nextSteps: ["Set the Repository variable CHECK_COMMAND (e.g. `pytest`, `go test ./...`, `make check`)."],
    };
  }

  const validation = validateCheckCommand(cmd);
  if (!validation.ok) {
    return {
      id: "toolchain.checkCommand",
      status: "error",
      summary: `CHECK_COMMAND is unsafe / unsupported: ${cmd}`,
      details: `Rejected: ${validation.reason}. The action's allowlist would refuse to run it, exhausting --max-turns.`,
      nextSteps: ["Use a command whose first token is a known runner (npm/pnpm/yarn/pytest/go/cargo/make/…) with no shell metacharacters."],
    };
  }

  const cmdEco = ecosystemOfCommand(cmd);
  const detected = ctx.toolchain?.ecosystem ?? null;
  if (detected && cmdEco && cmdEco !== detected) {
    return {
      id: "toolchain.checkCommand",
      status: "warning",
      summary: `CHECK_COMMAND (${cmdEco}) does not match the detected toolchain (${detected})`,
      details: `Detected ${detected} from ${ctx.toolchain?.evidence.join(", ") || "repo markers"}, but CHECK_COMMAND looks like a ${cmdEco} command.`,
      nextSteps: [`Confirm the caller's \`language:\` input and CHECK_COMMAND both target ${detected}, or override intentionally.`],
    };
  }

  return {
    id: "toolchain.checkCommand",
    status: "ok",
    summary: `CHECK_COMMAND is allowlist-safe${detected ? ` and consistent with ${detected}` : ""}: ${cmd}`,
  };
};

/** TY-346 core checks. TY-347 prepends/append its checks here. */
export function coreChecks(): Check[] {
  return [labelCheck, toolchainCheck];
}
