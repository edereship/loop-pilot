#!/usr/bin/env node
"use strict";

// cli/src/index.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// cli/src/gh.ts
var import_node_child_process = require("node:child_process");
var GhError = class extends Error {
  constructor(message, status, stderr) {
    super(message);
    this.status = status;
    this.stderr = stderr;
    this.name = "GhError";
  }
};
var GhAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GhAuthError";
  }
};
function run(cmd, args) {
  return new Promise((resolve) => {
    (0, import_node_child_process.execFile)(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}
function parseHttpStatus(stderr) {
  const m = stderr.match(/\(HTTP (\d{3})\)/);
  return m ? Number(m[1]) : void 0;
}
var RealGhClient = class {
  async ensureAvailable() {
    const { code } = await run("gh", ["--version"]);
    if (code !== 0) {
      throw new GhAuthError("the GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com/.");
    }
    const auth = await run("gh", ["auth", "status"]);
    if (auth.code !== 0) {
      throw new GhAuthError("not authenticated with `gh`. Run `gh auth login` and retry.");
    }
  }
  async currentRepo() {
    const { stdout, stderr, code } = await run("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner"
    ]);
    if (code !== 0 || !stdout.trim()) {
      throw new GhAuthError(
        `could not resolve the current repository via \`gh\`. Run inside a repo with a GitHub remote. (${stderr.trim()})`
      );
    }
    return stdout.trim();
  }
  async api(path, opts = {}) {
    const args = ["api", path];
    if (opts.method) args.push("--method", opts.method);
    for (const [k, v] of Object.entries(opts.fields ?? {})) {
      args.push("-f", `${k}=${v}`);
    }
    const { stdout, stderr, code } = await run("gh", args);
    if (code !== 0) {
      throw new GhError(
        `gh api ${path} failed: ${stderr.trim() || "unknown error"}`,
        parseHttpStatus(stderr),
        stderr
      );
    }
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  async labelExists(repo, name) {
    try {
      await this.api(`repos/${repo}/labels/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return false;
      throw e;
    }
  }
  async createLabel(repo, name, color, description) {
    if (await this.labelExists(repo, name)) return "exists";
    const { stderr, code } = await run("gh", [
      "label",
      "create",
      name,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description
    ]);
    if (code !== 0) {
      if (/already exists/i.test(stderr)) return "exists";
      throw new GhError(`gh label create failed: ${stderr.trim()}`, parseHttpStatus(stderr), stderr);
    }
    return "created";
  }
  async listSecretNames(repo) {
    const r = await this.api(
      `repos/${repo}/actions/secrets?per_page=100`
    );
    const names = new Set((r?.secrets ?? []).map((s) => s.name));
    try {
      const org = await this.api(
        `repos/${repo}/actions/organization-secrets?per_page=100`
      );
      for (const s of org?.secrets ?? []) names.add(s.name);
    } catch {
    }
    return [...names];
  }
  async getVariable(repo, name) {
    try {
      const r = await this.api(
        `repos/${repo}/actions/variables/${encodeURIComponent(name)}`
      );
      return r?.value ?? null;
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }
  async getRepoInfo(repo) {
    const r = await this.api(`repos/${repo}`);
    return { defaultBranch: r.default_branch, allowAutoMerge: Boolean(r.allow_auto_merge) };
  }
  async getRequiredStatusCheckContexts(repo, branch) {
    try {
      const r = await this.api(
        `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`
      );
      const ctxs = /* @__PURE__ */ new Set([
        ...r.contexts ?? [],
        ...(r.checks ?? []).map((c) => c.context)
      ]);
      return [...ctxs];
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }
  async listRecentActorLogins(repo) {
    const r = await this.api(
      `repos/${repo}/issues/comments?per_page=100&sort=created&direction=desc`
    );
    if (!Array.isArray(r)) return [];
    return r.map((c) => c.user?.login).filter((x) => typeof x === "string");
  }
};

// cli/src/check-command-allowlist.ts
var CHECK_COMMAND_BINARY_WHITELIST = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pnpx",
  "pytest",
  "python",
  "python3",
  "make",
  "cargo",
  "go",
  "mise",
  "task",
  "just"
];
var CHECK_COMMAND_SAFE_CHAR_RE = /^[A-Za-z0-9 ._/=:@+\-]+$/;
function validateCheckCommand(rawCommand) {
  const command = rawCommand.trim();
  if (command.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  if (!CHECK_COMMAND_SAFE_CHAR_RE.test(command)) {
    return {
      ok: false,
      reason: "contains characters outside the safe set (shell metacharacter or quote)"
    };
  }
  const firstToken = command.split(" ")[0] ?? "";
  if (!CHECK_COMMAND_BINARY_WHITELIST.includes(firstToken)) {
    return {
      ok: false,
      reason: `binary '${firstToken}' is not in the CHECK_COMMAND whitelist`
    };
  }
  return { ok: true };
}

// cli/src/checks.ts
var DEFAULT_LABEL = "loop-pilot";
var LABEL_COLOR = "BFD4F2";
var LABEL_DESCRIPTION = "Run LoopPilot on this PR";
var labelCheck = async (ctx) => {
  const label = ctx.label || DEFAULT_LABEL;
  if (ctx.fullAuto) {
    return {
      id: "label.gate",
      status: "ok",
      summary: `full-auto mode: gate label not required`,
      details: `LOOPPILOT_FULL_AUTO=true runs every non-fork PR; the '${label}' label is not needed.`
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
      details: "Without the gate label, the workflow `if:` evaluates false and NO Actions run is generated \u2014 the most common silent failure.",
      nextSteps: [
        `gh label create ${label} --color ${LABEL_COLOR} --description "${LABEL_DESCRIPTION}"`,
        "\u2026or set the Repository variable LOOPPILOT_FULL_AUTO=true to run on every non-fork PR."
      ]
    };
  } catch (e) {
    if (e instanceof GhError && e.status === 403) {
      return {
        id: "label.gate",
        status: "unknown",
        summary: `cannot read labels for ${ctx.repository} (HTTP 403)`,
        details: "The token lacks permission to list labels; cannot confirm the gate label.",
        nextSteps: ["Re-run with a `gh` session that has read access to the repository's issues/labels."]
      };
    }
    throw e;
  }
};
var ECOSYSTEM_BINARIES = {
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
  make: "make"
};
function ecosystemOfCommand(cmd) {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return ECOSYSTEM_BINARIES[first] ?? null;
}
var toolchainCheck = async (ctx) => {
  const cmd = (ctx.checkCommand ?? "").trim();
  if (!cmd) {
    return {
      id: "toolchain.checkCommand",
      status: "warning",
      summary: "CHECK_COMMAND is not set",
      details: "Post-fix runs CHECK_COMMAND to verify each fix; without it the default `npm run check` is used.",
      nextSteps: ["Set the Repository variable CHECK_COMMAND (e.g. `pytest`, `go test ./...`, `make check`)."]
    };
  }
  const validation = validateCheckCommand(cmd);
  if (!validation.ok) {
    return {
      id: "toolchain.checkCommand",
      status: "error",
      summary: `CHECK_COMMAND is unsafe / unsupported: ${cmd}`,
      details: `Rejected: ${validation.reason}. The action's allowlist would refuse to run it, exhausting --max-turns.`,
      nextSteps: ["Use a command whose first token is a known runner (npm/pnpm/yarn/pytest/go/cargo/make/\u2026) with no shell metacharacters."]
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
      nextSteps: [`Confirm the caller's \`language:\` input and CHECK_COMMAND both target ${detected}, or override intentionally.`]
    };
  }
  return {
    id: "toolchain.checkCommand",
    status: "ok",
    summary: `CHECK_COMMAND is allowlist-safe${detected ? ` and consistent with ${detected}` : ""}: ${cmd}`
  };
};
var ANTHROPIC_API = "ANTHROPIC_API_KEY";
var ANTHROPIC_OAUTH = "CLAUDE_CODE_OAUTH_TOKEN";
var CODEX_TOKEN = "CODEX_REVIEW_REQUEST_TOKEN";
var PUSH_TOKEN = "LOOPPILOT_PUSH_TOKEN";
var anthropicAuthCheck = async (ctx) => {
  const sn = ctx.secretNames;
  if (!sn || !sn.ok) {
    return {
      id: "secret.anthropicAuth",
      status: "unknown",
      summary: "cannot verify Anthropic credentials",
      details: sn ? sn.reason : "secret names were not gathered.",
      nextSteps: ["Re-run with an account that can read the repo's Actions secrets (admin), or verify the secrets manually in Settings \u2192 Secrets and variables \u2192 Actions."]
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
      nextSteps: ["Remove one secret so exactly one Anthropic credential remains."]
    };
  }
  if (!hasApi && !hasOauth) {
    return {
      id: "secret.anthropicAuth",
      status: "error",
      summary: "no Anthropic credential is set",
      details: "Set exactly one of ANTHROPIC_API_KEY (API billing) or CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription). pre-fix fail-fasts on neither. (Repo + org secrets were checked; the workflows can't use environment secrets.)",
      nextSteps: ["Add one as a Repository secret: Settings \u2192 Secrets and variables \u2192 Actions."]
    };
  }
  return {
    id: "secret.anthropicAuth",
    status: "ok",
    summary: `exactly one Anthropic credential set (${hasApi ? ANTHROPIC_API : ANTHROPIC_OAUTH})`
  };
};
var codexTokenCheck = async (ctx) => {
  const sn = ctx.secretNames;
  if (!sn || !sn.ok) {
    return {
      id: "secret.codexReviewToken",
      status: "unknown",
      summary: "cannot verify CODEX_REVIEW_REQUEST_TOKEN",
      details: sn ? sn.reason : "secret names were not gathered."
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
    nextSteps: ["Add CODEX_REVIEW_REQUEST_TOKEN \u2014 a fine-grained PAT from a Codex-connected user (Pull requests: write)."]
  };
};
var pushTokenCheck = async (ctx) => {
  const sn = ctx.secretNames;
  const rc = ctx.requiredChecks;
  if (!sn || !sn.ok) {
    return {
      id: "secret.loopPilotPushToken",
      status: "unknown",
      summary: "cannot verify LOOPPILOT_PUSH_TOKEN",
      details: sn ? sn.reason : "secret names were not gathered."
    };
  }
  const hasToken = sn.value.includes(PUSH_TOKEN);
  const requiredKnown = rc?.ok === true;
  const requiredActive = requiredKnown && rc.value.length > 0 || ctx.autoMerge === true;
  if (!hasToken && rc && !rc.ok && ctx.autoMerge !== true) {
    return {
      id: "secret.loopPilotPushToken",
      status: "unknown",
      summary: "cannot determine whether LOOPPILOT_PUSH_TOKEN is required",
      details: `Branch protection is unreadable (${rc.reason}); if required checks are enforced, a missing push token means GITHUB_TOKEN-pushed fixes won't re-trigger them.`,
      nextSteps: ["If the default branch enforces required checks, set LOOPPILOT_PUSH_TOKEN (machine-user PAT / GitHub App token, Contents: write)."]
    };
  }
  if (requiredActive && !hasToken) {
    const why = ctx.autoMerge === true ? "LOOPPILOT_AUTO_MERGE is on" : "the default branch enforces required checks";
    return {
      id: "secret.loopPilotPushToken",
      status: "warning",
      summary: `LOOPPILOT_PUSH_TOKEN is missing while ${why}`,
      details: "Commits pushed with GITHUB_TOKEN do NOT re-trigger required checks, so a repair commit can land drift that only fails on main. Strongly recommended here.",
      nextSteps: ["Set LOOPPILOT_PUSH_TOKEN \u2014 a machine-user fine-grained PAT or GitHub App token (Contents: Read and write)."]
    };
  }
  if (hasToken) {
    return { id: "secret.loopPilotPushToken", status: "ok", summary: `${PUSH_TOKEN} is set` };
  }
  return {
    id: "secret.loopPilotPushToken",
    status: "ok",
    summary: "LOOPPILOT_PUSH_TOKEN not required (no required checks / auto-merge)"
  };
};
var autoMergeCheck = async (ctx) => {
  if (ctx.autoMerge !== true) {
    return { id: "autoMerge.config", status: "ok", summary: "auto-merge not enabled (LOOPPILOT_AUTO_MERGE != true)" };
  }
  const ri = ctx.repoInfo;
  if (!ri || !ri.ok) {
    return {
      id: "autoMerge.config",
      status: "unknown",
      summary: "cannot read the repository auto-merge setting",
      details: ri ? ri.reason : "repo info was not gathered."
    };
  }
  if (!ri.value.allowAutoMerge) {
    return {
      id: "autoMerge.config",
      status: "error",
      summary: "LOOPPILOT_AUTO_MERGE=true but the repo disallows auto-merge",
      details: "`gh pr merge --auto` fails when 'Allow auto-merge' is off, and the loop silently skips the merge with a warning.",
      nextSteps: [
        "Enable Settings \u2192 General \u2192 Pull Requests \u2192 Allow auto-merge.",
        "Ensure the loop caller grants `actions: read` (the auto-merge guard reads other runs' status)."
      ]
    };
  }
  return {
    id: "autoMerge.config",
    status: "ok",
    summary: "auto-merge enabled and the repo allows it",
    details: "Ensure the loop caller's permissions include `actions: read` (cannot be verified from here)."
  };
};
var codexConnectionCheck = async (ctx) => {
  const cs = ctx.codexSeen;
  const bot = ctx.codexBotLogin || "chatgpt-codex-connector[bot]";
  if (!cs || !cs.ok) {
    return {
      id: "codex.connection",
      status: "unknown",
      summary: "could not infer Codex connection",
      details: cs ? cs.reason : "Codex activity was not gathered.",
      nextSteps: ["Confirm the ChatGPT Codex GitHub App is installed on this repo; open a PR and check that `@codex review` produces a review."]
    };
  }
  if (cs.value) {
    return { id: "codex.connection", status: "ok", summary: `recent activity from ${bot} seen \u2014 Codex appears connected` };
  }
  return {
    id: "codex.connection",
    status: "unknown",
    summary: `no recent activity from ${bot}`,
    details: "Cannot confirm the Codex GitHub App is connected (inference only \u2014 connection cannot be auto-detected reliably).",
    nextSteps: [
      "Install/connect the ChatGPT Codex GitHub App for this repository.",
      "Open a PR and verify `@codex review` triggers a Codex review (then re-run doctor)."
    ]
  };
};
function allChecks() {
  return [
    labelCheck,
    anthropicAuthCheck,
    codexConnectionCheck,
    pushTokenCheck,
    autoMergeCheck,
    codexTokenCheck,
    toolchainCheck
  ];
}

// cli/src/gather.ts
function reasonOf(e) {
  if (e instanceof GhError) {
    return e.status === 403 ? "insufficient permission (HTTP 403)" : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
var DEFAULT_CODEX_BOT = "chatgpt-codex-connector[bot]";
async function gatherSignals(gh, repository) {
  const getVar = async (name) => {
    try {
      return await gh.getVariable(repository, name);
    } catch {
      return null;
    }
  };
  const [fullAutoRaw, labelRaw, checkCommandRaw, autoMergeRaw, codexBotRaw] = await Promise.all([
    getVar("LOOPPILOT_FULL_AUTO"),
    getVar("LOOPPILOT_LABEL"),
    getVar("CHECK_COMMAND"),
    getVar("LOOPPILOT_AUTO_MERGE"),
    getVar("CODEX_BOT_LOGIN")
  ]);
  let repoInfo;
  let defaultBranch = "main";
  try {
    const ri = await gh.getRepoInfo(repository);
    repoInfo = { ok: true, value: ri };
    defaultBranch = ri.defaultBranch || "main";
  } catch (e) {
    repoInfo = { ok: false, reason: reasonOf(e) };
  }
  let secretNames;
  try {
    secretNames = { ok: true, value: await gh.listSecretNames(repository) };
  } catch (e) {
    secretNames = { ok: false, reason: reasonOf(e) };
  }
  let requiredChecks;
  try {
    const rc = await gh.getRequiredStatusCheckContexts(repository, defaultBranch);
    requiredChecks = { ok: true, value: rc ?? [] };
  } catch (e) {
    requiredChecks = { ok: false, reason: reasonOf(e) };
  }
  const codexBotLogin = (codexBotRaw ?? "").trim() || DEFAULT_CODEX_BOT;
  let codexSeen;
  try {
    const logins = await gh.listRecentActorLogins(repository);
    codexSeen = { ok: true, value: logins.includes(codexBotLogin) };
  } catch (e) {
    codexSeen = { ok: false, reason: reasonOf(e) };
  }
  return {
    defaultBranch,
    autoMerge: (autoMergeRaw ?? "").trim() === "true",
    label: labelRaw?.trim() || void 0,
    fullAuto: (fullAutoRaw ?? "").trim() === "true",
    checkCommand: checkCommandRaw?.trim() || void 0,
    codexBotLogin,
    secretNames,
    requiredChecks,
    repoInfo,
    codexSeen
  };
}

// cli/src/caller-templates.ts
var DEFAULT_REPO = "team-yubune/loop-pilot";
function resolved(opts) {
  return {
    language: opts.language ?? "node",
    ref: opts.ref ?? "v1",
    actionRepo: opts.actionRepo ?? DEFAULT_REPO,
    sameRepo: opts.sameRepo ?? false
  };
}
var S = "${{ secrets.";
var E = " }}";
function initSecretsBlock(sameRepo) {
  if (sameRepo) return ["    secrets: inherit"];
  return [
    "    secrets:",
    `      CODEX_REVIEW_REQUEST_TOKEN: ${S}CODEX_REVIEW_REQUEST_TOKEN${E}`
  ];
}
function loopSecretsBlock(sameRepo) {
  if (sameRepo) return ["    secrets: inherit"];
  return [
    "    secrets:",
    `      CODEX_REVIEW_REQUEST_TOKEN: ${S}CODEX_REVIEW_REQUEST_TOKEN${E}`,
    `      LOOPPILOT_PUSH_TOKEN: ${S}LOOPPILOT_PUSH_TOKEN${E}`,
    "      # Set exactly one of ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.",
    `      ANTHROPIC_API_KEY: ${S}ANTHROPIC_API_KEY${E}`,
    `      CLAUDE_CODE_OAUTH_TOKEN: ${S}CLAUDE_CODE_OAUTH_TOKEN${E}`
  ];
}
function renderInitCaller(opts = {}) {
  const { ref, actionRepo, sameRepo } = resolved(opts);
  return [
    "# .github/workflows/looppilot-init.yml",
    "# Generated by `gh looppilot init`. Thin caller \u2014 implementation lives in",
    `# the reusable workflow ${actionRepo}/.github/workflows/init.yml@${ref}.`,
    "name: LoopPilot Init",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, ready_for_review, labeled]",
    "",
    "jobs:",
    "  init:",
    "    permissions:",
    "      contents: read",
    "      pull-requests: write",
    "      issues: write",
    `    uses: ${actionRepo}/.github/workflows/init.yml@${ref}`,
    ...initSecretsBlock(sameRepo)
  ].join("\n") + "\n";
}
function renderLoopCaller(opts = {}) {
  const { language, ref, actionRepo, sameRepo } = resolved(opts);
  return [
    "# .github/workflows/looppilot-loop.yml",
    "# Generated by `gh looppilot init`. Thin caller \u2014 implementation lives in",
    `# the reusable workflow ${actionRepo}/.github/workflows/loop.yml@${ref}.`,
    "name: LoopPilot Loop",
    "",
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review:",
    "    types: [submitted]",
    "",
    "jobs:",
    "  loop:",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "      issues: write",
    "      actions: read",
    `    uses: ${actionRepo}/.github/workflows/loop.yml@${ref}`,
    ...loopSecretsBlock(sameRepo),
    "    with:",
    `      language: ${language}`
  ].join("\n") + "\n";
}
function renderCallers(opts = {}) {
  return [
    { path: ".github/workflows/looppilot-init.yml", content: renderInitCaller(opts) },
    { path: ".github/workflows/looppilot-loop.yml", content: renderLoopCaller(opts) }
  ];
}

// cli/src/init.ts
var MANUAL_STEPS = [
  "Connect the ChatGPT Codex GitHub App to this repository (platform step \u2014 cannot be automated). LoopPilot is triggered by `@codex review`.",
  "Add the required Repository secrets (values cannot be set via this CLI): exactly one of ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN; optionally CODEX_REVIEW_REQUEST_TOKEN (recommended) and LOOPPILOT_PUSH_TOKEN.",
  "If branch protection enforces required checks (or you enable LOOPPILOT_AUTO_MERGE), set LOOPPILOT_PUSH_TOKEN \u2014 a machine-user PAT or GitHub App token. GITHUB_TOKEN-pushed commits do not re-trigger required checks.",
  "Open a PR (add the gate label unless full-auto). Expected: an init status comment + `@codex review`; after Codex reviews, the loop fixes findings, runs CHECK_COMMAND, pushes, and re-requests review until `done/no_findings` or a stop notice.",
  "Run `gh looppilot doctor` after configuring secrets/labels to verify the setup before the first PR."
];
function buildInitPlan(detection, opts = {}) {
  const language = detection.language;
  const checkCommand = (opts.checkCommand ?? detection.checkCommand).trim();
  const callers = renderCallers({
    language,
    ref: opts.ref,
    actionRepo: opts.actionRepo,
    sameRepo: opts.sameRepo
  });
  const label = opts.fullAuto ? null : { name: opts.labelName ?? DEFAULT_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION };
  const notes = [];
  if (detection.ecosystem === null) {
    notes.push(
      "Could not auto-detect a toolchain. Set CHECK_COMMAND and the caller's `language:` input manually."
    );
  } else {
    notes.push(
      `Detected ${detection.ecosystem}${detection.packageManager ? ` (${detection.packageManager})` : ""} from ${detection.evidence.join(", ")}.`
    );
  }
  if (detection.alsoDetected.length > 0) {
    notes.push(
      `Also detected: ${detection.alsoDetected.join(", ")}. Chose ${detection.ecosystem} as primary \u2014 override \`language:\` / CHECK_COMMAND if that's wrong.`
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
    notes.push("No CHECK_COMMAND suggestion \u2014 set the Repository variable CHECK_COMMAND for your toolchain.");
  }
  return { language, checkCommand, callers, label, manualSteps: MANUAL_STEPS, notes };
}
async function executeInitPlan(plan, io, opts = {}) {
  const written = [];
  const skipped = [];
  io.log(`LoopPilot init \u2014 language: ${plan.language}`);
  for (const note of plan.notes) io.log(`  \u2022 ${note}`);
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

// cli/src/preflight.ts
async function runPreflight(checks, ctx) {
  const out = [];
  for (const check of checks) {
    try {
      out.push(await check(ctx));
    } catch (e) {
      out.push({
        id: "check.error",
        status: "unknown",
        summary: "a check could not run",
        details: e instanceof Error ? e.message : String(e),
        nextSteps: ["Re-run `gh looppilot doctor`; if it persists, check `gh auth status` and repo permissions."]
      });
    }
  }
  return out;
}
function buildReport(repository, checks) {
  const ok = !checks.some((c) => c.status === "error");
  return { ok, repository, checks };
}
function exitCodeForReport(report) {
  return report.ok ? 0 : 1;
}
function formatJson(report) {
  return JSON.stringify(
    {
      ok: report.ok,
      repository: report.repository,
      checks: report.checks.map((c) => ({
        id: c.id,
        status: c.status,
        summary: c.summary,
        details: c.details ?? null,
        nextSteps: c.nextSteps ?? []
      }))
    },
    null,
    2
  );
}
var STATUS_GLYPH = {
  ok: "\u2713 OK   ",
  warning: "! WARN ",
  error: "\u2717 ERROR",
  unknown: "? UNKWN"
};
function formatTable(report) {
  const lines = [];
  lines.push(`LoopPilot pre-flight \u2014 ${report.repository}`);
  lines.push("");
  for (const c of report.checks) {
    lines.push(`${STATUS_GLYPH[c.status]}  ${c.id}  \u2014  ${c.summary}`);
    if (c.details) lines.push(`           ${c.details}`);
    for (const step of c.nextSteps ?? []) {
      lines.push(`           \u2192 ${step}`);
    }
  }
  lines.push("");
  const counts = countByStatus(report.checks);
  lines.push(
    `Summary: ${counts.ok} ok, ${counts.warning} warning, ${counts.error} error, ${counts.unknown} unknown \u2014 ${report.ok ? "no blocking errors" : "fix the errors above before the first PR"}`
  );
  return lines.join("\n");
}
function countByStatus(checks) {
  const counts = { ok: 0, warning: 0, error: 0, unknown: 0 };
  for (const c of checks) counts[c.status]++;
  return counts;
}

// cli/src/toolchain.ts
var PRIORITY = ["node", "python", "go", "rust", "make"];
var MARKERS = {
  node: ["package.json"],
  python: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  make: ["Makefile", "makefile", "GNUmakefile"]
};
function toWorkflowLanguage(ecosystem) {
  switch (ecosystem) {
    case "node":
    case "python":
    case "go":
    case "rust":
      return ecosystem;
    default:
      return "none";
  }
}
function detectPackageManager(fileSet) {
  if (fileSet.has("pnpm-lock.yaml")) return "pnpm";
  if (fileSet.has("yarn.lock")) return "yarn";
  if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) return "bun";
  return "npm";
}
function nodeCheckCommand(pm, pkg) {
  const scripts = pkg?.scripts ?? {};
  const script = scripts.check ? "check" : scripts.test ? "test" : "check";
  return `${pm} run ${script}`;
}
function suggestCheckCommand(ecosystem, pm, pkg) {
  switch (ecosystem) {
    case "node":
      return nodeCheckCommand(pm, pkg);
    case "python":
      return "pytest";
    case "go":
      return "go test ./...";
    case "rust":
      return "cargo test";
    case "make":
      return "make check";
    default:
      return "";
  }
}
function detectToolchain(files, pkg) {
  const fileSet = new Set(files);
  const present = PRIORITY.filter(
    (eco) => MARKERS[eco].some((m) => fileSet.has(m))
  );
  const ecosystem = present[0] ?? null;
  const alsoDetected = present.slice(1);
  const packageManager = ecosystem === "node" ? detectPackageManager(fileSet) : void 0;
  const evidence = ecosystem ? MARKERS[ecosystem].filter((m) => fileSet.has(m)) : [];
  if (ecosystem === "node" && packageManager) {
    const lockfile = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lockb" }[packageManager];
    if (fileSet.has(lockfile)) evidence.push(lockfile);
  }
  return {
    ecosystem,
    language: toWorkflowLanguage(ecosystem),
    checkCommand: suggestCheckCommand(ecosystem, packageManager ?? "npm", pkg),
    evidence,
    alsoDetected,
    packageManager
  };
}

// cli/src/index.ts
var CLI_VERSION = "0.1.0";
function parseArgs(argv) {
  const args = {
    command: "help",
    json: false,
    dryRun: false,
    fullAuto: false,
    sameRepo: false,
    preflightOnly: false,
    noPreflight: false,
    force: false
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
        break;
    }
  }
  if (args.command === "init" && args.preflightOnly) args.command = "doctor";
  return args;
}
var HELP = `gh looppilot \u2014 set up and verify LoopPilot in a repository

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
function readToolchain(cwd) {
  let files = [];
  try {
    files = (0, import_node_fs.readdirSync)(cwd);
  } catch {
    files = [];
  }
  let pkg;
  if (files.includes("package.json")) {
    try {
      pkg = JSON.parse((0, import_node_fs.readFileSync)((0, import_node_path.join)(cwd, "package.json"), "utf8"));
    } catch {
      pkg = void 0;
    }
  }
  return detectToolchain(files, pkg);
}
function realInitIO(gh, cwd) {
  return {
    fileExists: (p) => (0, import_node_fs.existsSync)((0, import_node_path.join)(cwd, p)),
    writeFile: (p, content) => {
      const abs = (0, import_node_path.join)(cwd, p);
      (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(abs), { recursive: true });
      (0, import_node_fs.writeFileSync)(abs, content, "utf8");
    },
    log: (msg) => console.log(msg),
    createLabel: (name, color, description) => gh.createLabel(repoCache, name, color, description)
  };
}
var repoCache = "";
async function runInitCommand(args, gh, cwd) {
  repoCache = await gh.currentRepo();
  const detection = readToolchain(cwd);
  const plan = buildInitPlan(detection, {
    fullAuto: args.fullAuto,
    sameRepo: args.sameRepo,
    ref: args.ref,
    actionRepo: args.actionRepo,
    labelName: args.label,
    checkCommand: args.checkCommand
  });
  await executeInitPlan(plan, realInitIO(gh, cwd), { dryRun: args.dryRun, force: args.force });
  if (args.noPreflight || args.dryRun) return 0;
  console.log("\n\u2014 pre-flight \u2014");
  return runDoctor(args, gh, cwd, detection, plan.checkCommand);
}
async function runDoctor(args, gh, cwd, detection, checkCommand) {
  if (!repoCache) repoCache = await gh.currentRepo();
  const tc = detection ?? readToolchain(cwd);
  const signals = await gatherSignals(gh, repoCache);
  const ctx = {
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
    codexSeen: signals.codexSeen
  };
  const results = await runPreflight(allChecks(), ctx);
  const report = buildReport(repoCache, results);
  console.log(args.json ? formatJson(report) : formatTable(report));
  return exitCodeForReport(report);
}
async function main(argv) {
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

// cli/src/cli-entry.ts
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
