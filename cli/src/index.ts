/**
 * `gh looppilot` CLI core (TY-346). Side-effect-free: exports `main` /
 * `parseArgs` for tests. The executable entry is `cli-entry.ts`.
 *
 * Subcommands:
 *   init    — generate thin callers, create the gate label, suggest CHECK_COMMAND,
 *             print manual steps, then run pre-flight.
 *   doctor  — run pre-flight only (= `init --preflight-only`). Read-only.
 *
 * Exit codes (doctor / preflight): 0 = no errors, 1 = an error to fix before the
 * first PR, 2 = the check run itself could not proceed (auth / repo resolution).
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { allChecks } from "./checks.js";
import { gatherSignals } from "./gather.js";
import { buildInitPlan, executeInitPlan, type InitIO } from "./init.js";
import { GhAuthError, RealGhClient, type GhClient } from "./gh.js";
import {
  buildReport,
  exitCodeForReport,
  formatJson,
  formatTable,
  runPreflight,
  type PreflightContext,
} from "./preflight.js";
import { detectToolchain, type PackageJsonLike, type ToolchainDetection } from "./toolchain.js";

export const CLI_VERSION = "0.1.0";

export interface ParsedArgs {
  command: "init" | "doctor" | "help" | "version";
  json: boolean;
  dryRun: boolean;
  fullAuto: boolean;
  sameRepo: boolean;
  preflightOnly: boolean;
  noPreflight: boolean;
  force: boolean;
  label?: string;
  checkCommand?: string;
  ref?: string;
  actionRepo?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "help",
    json: false,
    dryRun: false,
    fullAuto: false,
    sameRepo: false,
    preflightOnly: false,
    noPreflight: false,
    force: false,
  };
  let sawCommand = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => argv[++i];
    switch (a) {
      case "init":
      case "doctor":
        if (!sawCommand) {
          args.command = a;
          sawCommand = true;
        }
        break;
      case "help":
      case "--help":
      case "-h":
        args.command = "help";
        sawCommand = true;
        break;
      case "version":
      case "--version":
      case "-v":
        args.command = "version";
        sawCommand = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--full-auto":
        args.fullAuto = true;
        break;
      case "--same-repo":
        args.sameRepo = true;
        break;
      case "--preflight-only":
        args.preflightOnly = true;
        break;
      case "--no-preflight":
        args.noPreflight = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--label":
        args.label = takeValue();
        break;
      case "--check-command":
        args.checkCommand = takeValue();
        break;
      case "--ref":
        args.ref = takeValue();
        break;
      case "--repo":
        args.actionRepo = takeValue();
        break;
      default:
        // ignore unknown tokens (kept simple; gh forwards extension args)
        break;
    }
  }
  // `init --preflight-only` is an alias for doctor.
  if (args.command === "init" && args.preflightOnly) args.command = "doctor";
  return args;
}

const HELP = `gh looppilot — set up and verify LoopPilot in a repository

Usage:
  gh looppilot init [flags]      Generate thin caller workflows, create the gate
                                 label, suggest CHECK_COMMAND, print manual steps,
                                 then run pre-flight.
  gh looppilot doctor [flags]    Run pre-flight only (read-only).

Flags:
  --full-auto         Don't require/create the gate label (runs on every non-fork PR).
  --same-repo         Emit \`secrets: inherit\` instead of enumerating (same-org only).
  --label <name>      Override the gate label (default: loop-pilot).
  --check-command <c> Override the suggested/effective CHECK_COMMAND.
  --ref <ref>         Pin a ref instead of the moving major (default: v1).
  --repo <owner/repo> Reusable-workflow source repo (default: team-yubune/loop-pilot).
  --dry-run           (init) Print actions without writing files or creating labels.
  --force             (init) Overwrite existing caller files.
  --no-preflight      (init) Skip the trailing pre-flight.
  --preflight-only    (init) Alias for \`doctor\`.
  --json              (doctor) Emit the machine-readable report.
  -h, --help          Show this help.
  -v, --version       Show the CLI version.`;

function readToolchain(cwd: string): ToolchainDetection {
  let files: string[] = [];
  try {
    files = readdirSync(cwd);
  } catch {
    files = [];
  }
  let pkg: PackageJsonLike | undefined;
  if (files.includes("package.json")) {
    try {
      pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as PackageJsonLike;
    } catch {
      pkg = undefined;
    }
  }
  return detectToolchain(files, pkg);
}

function realInitIO(gh: GhClient, cwd: string): InitIO {
  return {
    fileExists: (p) => existsSync(join(cwd, p)),
    writeFile: (p, content) => {
      const abs = join(cwd, p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
    log: (msg) => console.log(msg),
    createLabel: (name, color, description) => gh.createLabel(repoCache, name, color, description),
  };
}

// currentRepo is resolved once and reused by the IO closure.
let repoCache = "";

async function runInitCommand(args: ParsedArgs, gh: GhClient, cwd: string): Promise<number> {
  repoCache = await gh.currentRepo();
  const detection = readToolchain(cwd);
  const plan = buildInitPlan(detection, {
    fullAuto: args.fullAuto,
    sameRepo: args.sameRepo,
    ref: args.ref,
    actionRepo: args.actionRepo,
    labelName: args.label,
    checkCommand: args.checkCommand,
  });
  await executeInitPlan(plan, realInitIO(gh, cwd), { dryRun: args.dryRun, force: args.force });

  if (args.noPreflight || args.dryRun) return 0;

  console.log("\n— pre-flight —");
  return runDoctor(args, gh, cwd, detection, plan.checkCommand);
}

async function runDoctor(
  args: ParsedArgs,
  gh: GhClient,
  cwd: string,
  detection?: ToolchainDetection,
  checkCommand?: string,
): Promise<number> {
  if (!repoCache) repoCache = await gh.currentRepo();
  const tc = detection ?? readToolchain(cwd);
  // Read the repo's own LOOPPILOT_* / CHECK_COMMAND variables, secrets, branch
  // protection, auto-merge setting, and recent Codex activity (TY-347). Each
  // probe degrades independently to `unknown` on 403.
  const signals = await gatherSignals(gh, repoCache);
  const ctx: PreflightContext = {
    repository: repoCache,
    gh,
    toolchain: tc,
    // CHECK_COMMAND precedence: explicit flag > repo variable > init suggestion > detection.
    checkCommand: args.checkCommand ?? signals.checkCommand ?? checkCommand ?? tc.checkCommand,
    label: args.label ?? signals.label,
    fullAuto: args.fullAuto || signals.fullAuto,
    defaultBranch: signals.defaultBranch,
    autoMerge: signals.autoMerge,
    codexBotLogin: signals.codexBotLogin,
    secretNames: signals.secretNames,
    requiredChecks: signals.requiredChecks,
    repoInfo: signals.repoInfo,
    codexSeen: signals.codexSeen,
  };
  const results = await runPreflight(allChecks(), ctx);
  const report = buildReport(repoCache, results);
  console.log(args.json ? formatJson(report) : formatTable(report));
  return exitCodeForReport(report);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.command === "version") {
    console.log(CLI_VERSION);
    return 0;
  }

  const gh = new RealGhClient();
  try {
    await gh.ensureAvailable();
    const cwd = process.cwd();
    if (args.command === "init") return await runInitCommand(args, gh, cwd);
    return await runDoctor(args, gh, cwd);
  } catch (e) {
    if (e instanceof GhAuthError) {
      console.error(`gh-looppilot: ${e.message}`);
      return 2;
    }
    console.error(`gh-looppilot: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
