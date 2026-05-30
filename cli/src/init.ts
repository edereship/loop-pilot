/**
 * `gh looppilot init` orchestration (TY-346).
 *
 * `buildInitPlan` is pure (toolchain detection → caller files, gate label,
 * CHECK_COMMAND suggestion, manual-step checklist) so it is fixture-testable.
 * `executeInitPlan` performs the side effects (write files, create label, print)
 * through an injected IO so tests never touch the filesystem or `gh`.
 */
import { renderCallers, type GeneratedCaller } from "./caller-templates.js";
import { validateCheckCommand } from "./check-command-allowlist.js";
import { DEFAULT_LABEL, LABEL_COLOR, LABEL_DESCRIPTION } from "./checks.js";
import type { ToolchainDetection, WorkflowLanguage } from "./toolchain.js";

export interface InitOptions {
  /** --full-auto: don't require/create the gate label. */
  fullAuto?: boolean;
  /** --same-repo: emit `secrets: inherit` instead of enumerating (same-org only). */
  sameRepo?: boolean;
  /** Pin a specific ref instead of the moving major (default "v1"). */
  ref?: string;
  /** owner/repo hosting the reusable workflows. */
  actionRepo?: string;
  /** Override the gate label name. */
  labelName?: string;
  /** Override the suggested CHECK_COMMAND. */
  checkCommand?: string;
}

export interface InitLabel {
  name: string;
  color: string;
  description: string;
}

export interface InitPlan {
  language: WorkflowLanguage;
  checkCommand: string;
  callers: GeneratedCaller[];
  /** null under full-auto (no gate label needed). */
  label: InitLabel | null;
  /** Manual, non-automatable setup steps to print. */
  manualSteps: string[];
  /** Detection notes / warnings to surface. */
  notes: string[];
}

const MANUAL_STEPS: string[] = [
  "Connect the ChatGPT Codex GitHub App to this repository (platform step — cannot be automated). LoopPilot is triggered by `@codex review`.",
  "Add the required Repository secrets (values cannot be set via this CLI): exactly one of ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN; optionally CODEX_REVIEW_REQUEST_TOKEN (recommended) and LOOPPILOT_PUSH_TOKEN.",
  "If branch protection enforces required checks (or you enable LOOPPILOT_AUTO_MERGE), set LOOPPILOT_PUSH_TOKEN — a machine-user PAT or GitHub App token. GITHUB_TOKEN-pushed commits do not re-trigger required checks.",
  "Open a PR (add the gate label unless full-auto). Expected: an init status comment + `@codex review`; after Codex reviews, the loop fixes findings, runs CHECK_COMMAND, pushes, and re-requests review until `done/no_findings` or a stop notice.",
  "Run `gh looppilot doctor` after configuring secrets/labels to verify the setup before the first PR.",
];

export function buildInitPlan(detection: ToolchainDetection, opts: InitOptions = {}): InitPlan {
  const language = detection.language;
  const checkCommand = (opts.checkCommand ?? detection.checkCommand).trim();

  const callers = renderCallers({
    language,
    ref: opts.ref,
    actionRepo: opts.actionRepo,
    sameRepo: opts.sameRepo,
  });

  const label: InitLabel | null = opts.fullAuto
    ? null
    : { name: opts.labelName ?? DEFAULT_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION };

  const notes: string[] = [];
  if (detection.ecosystem === null) {
    notes.push(
      "Could not auto-detect a toolchain. Set CHECK_COMMAND and the caller's `language:` input manually.",
    );
  } else {
    notes.push(
      `Detected ${detection.ecosystem}${detection.packageManager ? ` (${detection.packageManager})` : ""} from ${detection.evidence.join(", ")}.`,
    );
  }
  if (detection.alsoDetected.length > 0) {
    notes.push(
      `Also detected: ${detection.alsoDetected.join(", ")}. Chose ${detection.ecosystem} as primary — override \`language:\` / CHECK_COMMAND if that's wrong.`,
    );
  }
  if (checkCommand) {
    const v = validateCheckCommand(checkCommand);
    if (!v.ok) {
      notes.push(`Warning: suggested CHECK_COMMAND '${checkCommand}' is not allowlist-safe (${v.reason}). Set a safe one.`);
    } else {
      notes.push(`Suggested CHECK_COMMAND: \`${checkCommand}\` (set it as the Repository variable CHECK_COMMAND).`);
    }
  } else {
    notes.push("No CHECK_COMMAND suggestion — set the Repository variable CHECK_COMMAND for your toolchain.");
  }

  return { language, checkCommand, callers, label, manualSteps: MANUAL_STEPS, notes };
}

export interface InitIO {
  fileExists(path: string): boolean;
  writeFile(path: string, content: string): void;
  log(msg: string): void;
  createLabel(name: string, color: string, description: string): Promise<"created" | "exists">;
}

export interface ExecuteInitOptions {
  /** Print intended actions without writing files or creating labels. */
  dryRun?: boolean;
  /** Overwrite existing caller files. */
  force?: boolean;
}

/** Apply an init plan. Returns the list of written/would-write paths. */
export async function executeInitPlan(
  plan: InitPlan,
  io: InitIO,
  opts: ExecuteInitOptions = {},
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];

  io.log(`LoopPilot init — language: ${plan.language}`);
  for (const note of plan.notes) io.log(`  • ${note}`);
  io.log("");

  for (const caller of plan.callers) {
    const exists = io.fileExists(caller.path);
    if (exists && !opts.force) {
      skipped.push(caller.path);
      io.log(`skip   ${caller.path} (already exists; pass --force to overwrite)`);
      continue;
    }
    if (opts.dryRun) {
      io.log(`would write ${caller.path}:`);
      io.log(caller.content);
    } else {
      io.writeFile(caller.path, caller.content);
      io.log(`${exists ? "overwrote" : "wrote"} ${caller.path}`);
    }
    written.push(caller.path);
  }

  io.log("");
  if (plan.label) {
    if (opts.dryRun) {
      io.log(`would ensure gate label '${plan.label.name}' exists`);
    } else {
      const result = await io.createLabel(plan.label.name, plan.label.color, plan.label.description);
      io.log(`label  '${plan.label.name}' ${result}`);
    }
  } else {
    io.log("label  skipped (full-auto: every non-fork PR runs)");
  }

  io.log("");
  io.log("Manual steps (cannot be automated):");
  plan.manualSteps.forEach((s, i) => io.log(`  ${i + 1}. ${s}`));

  return { written, skipped };
}
