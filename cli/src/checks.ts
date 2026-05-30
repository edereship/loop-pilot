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

// ── TY-347: secret / branch-protection / auto-merge / Codex-inference checks ──

const ANTHROPIC_API = "ANTHROPIC_API_KEY";
const ANTHROPIC_OAUTH = "CLAUDE_CODE_OAUTH_TOKEN";
const CODEX_TOKEN = "CODEX_REVIEW_REQUEST_TOKEN";
const PUSH_TOKEN = "LOOPPILOT_PUSH_TOKEN";

/** Anthropic auth: exactly one of API key / OAuth token (config.ts fail-fast). */
export const anthropicAuthCheck: Check = async (ctx): Promise<CheckResult> => {
  const sn = ctx.secretNames;
  if (!sn || !sn.ok) {
    return {
      id: "secret.anthropicAuth",
      status: "unknown",
      summary: "cannot verify Anthropic credentials",
      details: sn ? sn.reason : "secret names were not gathered.",
      nextSteps: ["Re-run with an account that can read the repo's Actions secrets (admin), or verify the secrets manually in Settings → Secrets and variables → Actions."],
    };
  }
  const hasApi = sn.value.includes(ANTHROPIC_API);
  const hasOauth = sn.value.includes(ANTHROPIC_OAUTH);
  if (hasApi && hasOauth) {
    return {
      id: "secret.anthropicAuth",
      status: "error",
      summary: "both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set",
      details: "pre-fix fail-fasts when both are set (prevents accidental per-token billing while you think you're on a subscription).",
      nextSteps: ["Remove one secret so exactly one Anthropic credential remains."],
    };
  }
  if (!hasApi && !hasOauth) {
    return {
      id: "secret.anthropicAuth",
      status: "error",
      summary: "no Anthropic credential is set",
      details: "Set exactly one of ANTHROPIC_API_KEY (API billing) or CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription). pre-fix fail-fasts on neither. (Repo + org secrets were checked; the workflows can't use environment secrets.)",
      nextSteps: ["Add one as a Repository secret: Settings → Secrets and variables → Actions."],
    };
  }
  return {
    id: "secret.anthropicAuth",
    status: "ok",
    summary: `exactly one Anthropic credential set (${hasApi ? ANTHROPIC_API : ANTHROPIC_OAUTH})`,
  };
};

/** Codex review-request token (recommended for a reliable Codex trigger). */
export const codexTokenCheck: Check = async (ctx): Promise<CheckResult> => {
  const sn = ctx.secretNames;
  if (!sn || !sn.ok) {
    return {
      id: "secret.codexReviewToken",
      status: "unknown",
      summary: "cannot verify CODEX_REVIEW_REQUEST_TOKEN",
      details: sn ? sn.reason : "secret names were not gathered.",
    };
  }
  if (sn.value.includes(CODEX_TOKEN)) {
    return { id: "secret.codexReviewToken", status: "ok", summary: `${CODEX_TOKEN} is set` };
  }
  return {
    id: "secret.codexReviewToken",
    status: "warning",
    summary: `${CODEX_TOKEN} is not set`,
    details: "Without it, `@codex review` is posted as github-actions[bot], which may not reliably start Codex. Recommended in production.",
    nextSteps: ["Add CODEX_REVIEW_REQUEST_TOKEN — a fine-grained PAT from a Codex-connected user (Pull requests: write)."],
  };
};

/** Required checks / auto-merge ⇒ LOOPPILOT_PUSH_TOKEN needed (the #3 silent failure). */
export const pushTokenCheck: Check = async (ctx): Promise<CheckResult> => {
  const sn = ctx.secretNames;
  const rc = ctx.requiredChecks;
  if (!sn || !sn.ok) {
    return {
      id: "secret.loopPilotPushToken",
      status: "unknown",
      summary: "cannot verify LOOPPILOT_PUSH_TOKEN",
      details: sn ? sn.reason : "secret names were not gathered.",
    };
  }
  const hasToken = sn.value.includes(PUSH_TOKEN);
  const requiredKnown = rc?.ok === true;
  const requiredActive = (requiredKnown && rc!.value.length > 0) || ctx.autoMerge === true;

  if (!hasToken && rc && !rc.ok && ctx.autoMerge !== true) {
    return {
      id: "secret.loopPilotPushToken",
      status: "unknown",
      summary: "cannot determine whether LOOPPILOT_PUSH_TOKEN is required",
      details: `Branch protection is unreadable (${rc.reason}); if required checks are enforced, a missing push token means GITHUB_TOKEN-pushed fixes won't re-trigger them.`,
      nextSteps: ["If the default branch enforces required checks, set LOOPPILOT_PUSH_TOKEN (machine-user PAT / GitHub App token, Contents: write)."],
    };
  }
  if (requiredActive && !hasToken) {
    const why = ctx.autoMerge === true ? "LOOPPILOT_AUTO_MERGE is on" : "the default branch enforces required checks";
    return {
      id: "secret.loopPilotPushToken",
      status: "warning",
      summary: `LOOPPILOT_PUSH_TOKEN is missing while ${why}`,
      details: "Commits pushed with GITHUB_TOKEN do NOT re-trigger required checks, so a repair commit can land drift that only fails on main. Strongly recommended here.",
      nextSteps: ["Set LOOPPILOT_PUSH_TOKEN — a machine-user fine-grained PAT or GitHub App token (Contents: Read and write)."],
    };
  }
  if (hasToken) {
    return { id: "secret.loopPilotPushToken", status: "ok", summary: `${PUSH_TOKEN} is set` };
  }
  return {
    id: "secret.loopPilotPushToken",
    status: "ok",
    summary: "LOOPPILOT_PUSH_TOKEN not required (no required checks / auto-merge)",
  };
};

/** Auto-merge config: repo "Allow auto-merge" must be on when LOOPPILOT_AUTO_MERGE=true. */
export const autoMergeCheck: Check = async (ctx): Promise<CheckResult> => {
  if (ctx.autoMerge !== true) {
    return { id: "autoMerge.config", status: "ok", summary: "auto-merge not enabled (LOOPPILOT_AUTO_MERGE != true)" };
  }
  const ri = ctx.repoInfo;
  if (!ri || !ri.ok) {
    return {
      id: "autoMerge.config",
      status: "unknown",
      summary: "cannot read the repository auto-merge setting",
      details: ri ? ri.reason : "repo info was not gathered.",
    };
  }
  if (!ri.value.allowAutoMerge) {
    return {
      id: "autoMerge.config",
      status: "error",
      summary: "LOOPPILOT_AUTO_MERGE=true but the repo disallows auto-merge",
      details: "`gh pr merge --auto` fails when 'Allow auto-merge' is off, and the loop silently skips the merge with a warning.",
      nextSteps: [
        "Enable Settings → General → Pull Requests → Allow auto-merge.",
        "Ensure the loop caller grants `actions: read` (the auto-merge guard reads other runs' status).",
      ],
    };
  }
  return {
    id: "autoMerge.config",
    status: "ok",
    summary: "auto-merge enabled and the repo allows it",
    details: "Ensure the loop caller's permissions include `actions: read` (cannot be verified from here).",
  };
};

/** Codex connection — inferred from recent bot activity. First-class `unknown`. */
export const codexConnectionCheck: Check = async (ctx): Promise<CheckResult> => {
  const cs = ctx.codexSeen;
  const bot = ctx.codexBotLogin || "chatgpt-codex-connector[bot]";
  if (!cs || !cs.ok) {
    return {
      id: "codex.connection",
      status: "unknown",
      summary: "could not infer Codex connection",
      details: cs ? cs.reason : "Codex activity was not gathered.",
      nextSteps: ["Confirm the ChatGPT Codex GitHub App is installed on this repo; open a PR and check that `@codex review` produces a review."],
    };
  }
  if (cs.value) {
    return { id: "codex.connection", status: "ok", summary: `recent activity from ${bot} seen — Codex appears connected` };
  }
  return {
    id: "codex.connection",
    status: "unknown",
    summary: `no recent activity from ${bot}`,
    details: "Cannot confirm the Codex GitHub App is connected (inference only — connection cannot be auto-detected reliably).",
    nextSteps: [
      "Install/connect the ChatGPT Codex GitHub App for this repository.",
      "Open a PR and verify `@codex review` triggers a Codex review (then re-run doctor).",
    ],
  };
};

/** TY-346 core checks (local + label). */
export function coreChecks(): Check[] {
  return [labelCheck, toolchainCheck];
}

/** Full pre-flight: TY-346 core + TY-347 gathered-signal checks, ordered by impact. */
export function allChecks(): Check[] {
  return [
    labelCheck,
    anthropicAuthCheck,
    codexConnectionCheck,
    pushTokenCheck,
    autoMergeCheck,
    codexTokenCheck,
    toolchainCheck,
  ];
}
