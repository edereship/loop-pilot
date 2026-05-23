import * as core from "@actions/core";
import { isSeverity } from "./severity-parser.js";
import { validateCheckCommand } from "./check-command-allowlist.js";
import type { Severity } from "./types.js";

/**
 * Subset of `Config` shared by init / pre-fix / post-fix. Anthropic credentials
 * are intentionally excluded so that the type system can prevent post-fix /
 * init from reading `anthropicApiKey` or `claudeCodeOauthToken` — both are
 * empty strings under `loadInitConfig` and meaningless outside pre-fix
 * (TY-267 #10).
 */
export interface BaseConfig {
  maxReviewIterations: number;
  debounceSeconds: number;
  checkCommand: string;
  /**
   * Optional shell command run by post-fix after CHECK_COMMAND succeeds and
   * before the auto-fix commit is staged (TY-281). Intended for repos that
   * commit build artifacts (e.g. `dist/`) so the auto-fix commit cannot drift
   * out of sync with `src/`. Empty default = skip, preserving prior behavior
   * for downstream repos without committed build outputs. The configured
   * command may chain multiple steps via shell `&&` or wrap them in an npm
   * script — multi-command native support is intentionally not provided
   * (see TY-281 spec).
   */
  buildCommand: string;
  codexBotLogin: string;
  stabilizeIntervalSeconds: number;
  stabilizeCount: number;
  codexReviewMarker: string;
  codexReviewRequestToken: string;
  autoReviewPushToken: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  // New: moved from inline process.env reads in main-loop.ts
  triggerCommentId: number;
  triggerCommentBody: string;
  triggerUserLogin: string;
  /**
   * GitHub event name that fired the trigger (`issue_comment` /
   * `pull_request_review`). Used by pre-fix to disambiguate the
   * `lastProcessedReviewId` namespace (TY-301 #2) — issue_comment.id and
   * pull_request_review.id are drawn from separate ID spaces and can collide
   * in theory, silently skipping a legitimate trigger as "already processed".
   * Empty string indicates a legacy workflow YAML that does not yet pass
   * `trigger-event-name`; dedup falls back to id-only comparison in that case.
   */
  triggerEventName: string;
  prHeadRef: string;
  prTitle: string;
  // Label-based opt-in (default-strict: PR must carry the label unless full-auto is on).
  // - autoReviewLabel: required label name. Empty string falls back to DEFAULT_AUTO_REVIEW_LABEL.
  // - autoReviewFullAuto: true disables the label gate (every non-fork ready PR triggers).
  autoReviewLabel: string;
  autoReviewFullAuto: boolean;
  autoReviewRestartRoles: string;
  // claude-code-action model selection (TY-241, simplified in TY-242).
  // - claudeCodeModelBase: tier-1 model used when no escalation signal fires.
  // - claudeCodeModelEscalated: tier-2 model used on P0 finding, repeated
  //   finding, or after a previous-iteration CHECK_COMMAND failure. Set both
  //   variables to the same value to operate without tiering.
  claudeCodeModelBase: string;
  claudeCodeModelEscalated: string;
  // Opt-in PR auto-merge (TY-245, hardened in TY-277). When true, the loop
  // calls `mergeIfChecksPass` after a `done / no_findings` transition: it
  // polls HEAD's workflow runs (excluding the loop's own run) and merges
  // with `gh pr merge --squash` only when every other run has a non-failed
  // conclusion. Other stop reasons never enable auto-merge.
  autoMergeOnClean: boolean;
  /**
   * Poll interval (seconds) between workflow-run status reads while waiting
   * for CI to settle before auto-merge. Default 15. Lower bound 1 to keep
   * the loop from spinning.
   */
  autoMergePollSeconds: number;
  /**
   * Hard timeout (minutes) on the CI wait before `mergeIfChecksPass` skips
   * with a warning. Default 10. Lower bound 1.
   */
  autoMergeTimeoutMinutes: number;
  // Severity threshold (TY-256). Findings whose severity is strictly below the
  // threshold (numerically larger; e.g., P3 when threshold is P2) are excluded
  // from the auto-fix pipeline and counted under `belowThreshold` in observability
  // logs. Default `P2` preserves prior behavior. Invalid values fall back to `P2`
  // with a warning.
  severityThreshold: Severity;
  // Block-list spec (TY-271). `.gitignore`-style syntax forwarded raw to
  // `parseBlockPathsSpec` in scope-checker.ts. Empty default keeps the
  // built-in `DEFAULT_BLOCK_PATTERNS` intact.
  //   AUTO_REVIEW_BLOCK_PATHS = "secrets/,infra/,!Makefile,!package.json"
  //   - trailing `/` → directory prefix block
  //   - no trailing `/` → exact file block
  //   - leading `!`    → remove the matching default
  //   - `!.github/...` is silently ignored (locked)
  autoReviewBlockPaths: string;
  scopeMaxFiles: number;
  scopeMaxLines: number;
  /**
   * @deprecated TY-271. Folded into the block-list as removals (legacy
   * `!path` shape). Emit a warning when set and migrate the operator to
   * `AUTO_REVIEW_BLOCK_PATHS`. Removed in the next minor.
   */
  hardBlockOverride: readonly string[];
  /**
   * @deprecated TY-271. The allow-list concept is gone; values are accepted
   * but ignored with a warning. Removed in the next minor.
   */
  scopeAllowedPathPrefixes: readonly string[];
  /**
   * @deprecated TY-271. Folded into the block-list as additions. Removed
   * in the next minor.
   */
  scopeAdditionalHardBlockPrefixes: readonly string[];
}

/**
 * Claude authentication credentials (TY-260). Exactly one of the two is set
 * after input validation: `anthropicApiKey` for direct Anthropic API billing,
 * or `claudeCodeOauthToken` for a Pro / Max subscription via OAuth. Both
 * values are forwarded to `anthropics/claude-code-action@v1` (the upstream SDK
 * ignores the empty one). Setting neither or both at the same time is
 * rejected at startup in `loadConfig` so the caller can never be ambiguous
 * about which credential the loop is billing against. Only pre-fix consumes
 * these; init / post-fix use `BaseConfig` so the type system blocks
 * accidental reads (TY-267 #10).
 */
export interface ClaudeAuthConfig {
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
}

/**
 * Full pre-fix config: shared base + Claude credentials.
 */
export type Config = BaseConfig & ClaudeAuthConfig;

export const DEFAULT_SEVERITY_THRESHOLD: Severity = "P3";

const DEFAULT_CLAUDE_CODE_MODEL_BASE = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_CODE_MODEL_ESCALATED = "claude-opus-4-7";

/**
 * Fallback label name used when the user has not configured AUTO_REVIEW_LABEL.
 * "auto-review-fix" reflects that the label triggers the full Codex review +
 * Claude auto-fix loop, not just a review.
 */
export const DEFAULT_AUTO_REVIEW_LABEL = "auto-review-fix";

export function loadConfig(): Config {
  // TY-260: accept either Anthropic API key OR Claude Code OAuth token, but
  // never both. Fail-fast at startup so cost mistakes ("subscribed to Claude
  // Code but forgot to clear ANTHROPIC_API_KEY → still billed per token")
  // surface in the workflow log instead of running silently against the
  // unintended credential.
  const anthropicApiKey = input("anthropic-api-key", "ANTHROPIC_API_KEY", "");
  const claudeCodeOauthToken = input(
    "claude-code-oauth-token",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "",
  );
  if (anthropicApiKey === "" && claudeCodeOauthToken === "") {
    throw new Error(
      "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (at least one is required).",
    );
  }
  if (anthropicApiKey !== "" && claudeCodeOauthToken !== "") {
    throw new Error(
      "Set exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, not both. Remove one to disambiguate which credential is billed.",
    );
  }
  return {
    ...loadBaseConfig(),
    anthropicApiKey,
    claudeCodeOauthToken,
  };
}

export function loadInitConfig(): BaseConfig {
  // Init / post-fix do not call Claude directly. They receive `BaseConfig`,
  // which has no Anthropic credential fields at all, so accidental reads
  // (`config.anthropicApiKey`) are rejected at compile time (TY-267 #10).
  return loadBaseConfig();
}

function loadBaseConfig(): BaseConfig {
  const repoFullName = requireInput("github-repository", "GITHUB_REPOSITORY");
  const [repoOwner, repoName] = repoFullName.split("/");
  const validRepoSegment = /^[a-zA-Z0-9._-]+$/;
  if (!repoOwner || !repoName || !validRepoSegment.test(repoOwner) || !validRepoSegment.test(repoName)) {
    throw new Error(
      `github-repository must be in "owner/name" format with valid characters, got: "${repoFullName}"`
    );
  }

  const githubToken = requireInput("github-token", "GITHUB_TOKEN");

  // TY-274 #2: validate CHECK_COMMAND at config load so an unsafe value
  // (shell metacharacters, an off-allowlist binary like `bash` / `eval`)
  // fails fast — before claude-code-action runs and burns Actions minutes /
  // Claude API tokens. The same validator powers the Bash allowlist
  // derivation (`deriveAllowedBashTools`); rejecting it here keeps the two
  // entry points symmetric. Operators must migrate non-allowlist commands
  // (see docs/operations/security.md — CHECK_COMMAND validation).
  const checkCommand = input("check-command", "CHECK_COMMAND", "npm run check");
  const checkCommandValidation = validateCheckCommand(checkCommand);
  if (!checkCommandValidation.ok) {
    throw new Error(
      `CHECK_COMMAND ${JSON.stringify(checkCommand)} was rejected by check-command-allowlist: ${checkCommandValidation.reason}. See docs/operations/security.md (CHECK_COMMAND validation) for the allowlist and migration steps.`,
    );
  }

  const codexReviewRequestToken = input(
    "codex-review-request-token",
    "CODEX_REVIEW_REQUEST_TOKEN",
    githubToken
  );

  // TY-275 #1 (refined per Codex review on PR #95):
  //   - r3257188567 (first pass): the originally-proposed whitelist
  //     `[A-Za-z0-9._\-]+` rejected legitimate provider-form identifiers
  //     used in the wild — Bedrock ARNs
  //     (`bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0`), Vertex AI
  //     (`claude-3-5-sonnet@20240620`), context-window variants
  //     (`claude-opus-4-7:1m`, `claude-opus-4-7[1m]`).
  //   - r3257717904 (this pass): the relaxed forbidden-char regex still
  //     accepted leading-`-` strings like `--allowedTools`. Workflow
  //     templates the value as `--model <value>`, so a `--`-prefixed
  //     "model name" would be re-interpreted as another CLI flag and
  //     achieve argv injection without using whitespace.
  //
  // Final rule:
  //   - Reject whitespace, quotes (`'`, `"`, backtick), backslash, control
  //     chars, shell metas (`;`, `|`, `&`, `<`, `>`, `$`).
  //   - **Reject any leading `-`** so a value cannot start a new flag in
  //     `claude_args`. No legitimate model identifier starts with `-`.
  //   - Accept everything else (provider-form `:`, `/`, `@`, `[`, `]`,
  //     `.`, alphanumerics) so Bedrock ARN / Vertex AI / context variants
  //     continue to load.
  const MODEL_NAME_FORBIDDEN_RE = /[\s'"`\\;|&<>$]|[\x00-\x1f\x7f]/;
  function isValidModelName(value: string): boolean {
    if (value.length === 0) return false;
    if (value.startsWith("-")) return false; // argv-flag injection guard
    return !MODEL_NAME_FORBIDDEN_RE.test(value);
  }
  const claudeCodeModelBase = input(
    "claude-code-model-base",
    "CLAUDE_CODE_MODEL_BASE",
    DEFAULT_CLAUDE_CODE_MODEL_BASE,
  );
  if (!isValidModelName(claudeCodeModelBase)) {
    throw new Error(
      `CLAUDE_CODE_MODEL_BASE ${JSON.stringify(claudeCodeModelBase)} is rejected: model identifiers must not start with \`-\` (argv-flag injection guard) and must not contain whitespace, quotes, or shell metacharacters. Provider-form identifiers (Bedrock ARN, Vertex AI, context variants like \`claude-opus-4-7:1m\`) are supported.`,
    );
  }
  const claudeCodeModelEscalated = input(
    "claude-code-model-escalated",
    "CLAUDE_CODE_MODEL_ESCALATED",
    DEFAULT_CLAUDE_CODE_MODEL_ESCALATED,
  );
  if (!isValidModelName(claudeCodeModelEscalated)) {
    throw new Error(
      `CLAUDE_CODE_MODEL_ESCALATED ${JSON.stringify(claudeCodeModelEscalated)} is rejected: model identifiers must not start with \`-\` (argv-flag injection guard) and must not contain whitespace, quotes, or shell metacharacters. Provider-form identifiers (Bedrock ARN, Vertex AI, context variants like \`claude-opus-4-7:1m\`) are supported.`,
    );
  }
  const autoReviewPushToken = input("auto-review-push-token", "AUTO_REVIEW_PUSH_TOKEN", "");

  // TY-289 #2: BUILD_COMMAND runs through the same `execAsync` shell path as
  // CHECK_COMMAND (`src/build-runner.ts`), so the same allowlist must gate
  // it at config load. Empty default means "skip BUILD_COMMAND" (TY-281
  // baseline behavior) and is intentionally not validated — only non-empty
  // values are checked. Failing here keeps init / pre-fix / post-fix
  // symmetric with the CHECK_COMMAND validation immediately above.
  const buildCommand = input("build-command", "BUILD_COMMAND", "");
  if (buildCommand !== "") {
    const buildCommandValidation = validateCheckCommand(buildCommand);
    if (!buildCommandValidation.ok) {
      throw new Error(
        `BUILD_COMMAND ${JSON.stringify(buildCommand)} was rejected by check-command-allowlist: ${buildCommandValidation.reason}. See docs/operations/security.md (CHECK_COMMAND validation) for the allowlist; multi-step builds should be wrapped in a package.json script or Makefile target rather than chained with shell operators.`,
      );
    }
  }

  return {
    maxReviewIterations: intInput("max-review-iterations", "MAX_REVIEW_ITERATIONS", 20, 1),
    debounceSeconds: intInput("debounce-seconds", "DEBOUNCE_SECONDS", 90, 0),
    checkCommand,
    buildCommand,
    codexBotLogin: input("codex-bot-login", "CODEX_BOT_LOGIN", "chatgpt-codex-connector[bot]"),
    stabilizeIntervalSeconds: intInput(
      "stabilize-interval-seconds",
      "STABILIZE_INTERVAL_SECONDS",
      10,
      1,
    ),
    stabilizeCount: intInput("stabilize-count", "STABILIZE_COUNT", 3, 1),
    codexReviewMarker: input("codex-review-marker", "CODEX_REVIEW_MARKER", "Codex Review"),
    githubToken,
    codexReviewRequestToken,
    autoReviewPushToken,
    repoOwner,
    repoName,
    prNumber: requirePositiveInt("pr-number", "PR_NUMBER"),
    triggerCommentId: intInput("trigger-comment-id", "TRIGGER_COMMENT_ID", 0),
    triggerCommentBody: input("trigger-comment-body", "TRIGGER_COMMENT_BODY", ""),
    triggerUserLogin: input("trigger-user-login", "TRIGGER_USER_LOGIN", ""),
    triggerEventName: input("trigger-event-name", "TRIGGER_EVENT_NAME", ""),
    prHeadRef: input("pr-head-ref", "PR_HEAD_REF", ""),
    prTitle: input("pr-title", "PR_TITLE", ""),
    autoReviewLabel: input("auto-review-label", "AUTO_REVIEW_LABEL", ""),
    autoReviewFullAuto: boolInput("auto-review-full-auto", "AUTO_REVIEW_FULL_AUTO", false),
    autoReviewRestartRoles: input(
      "auto-review-restart-roles",
      "AUTO_REVIEW_RESTART_ROLES",
      "author,write,maintain,admin",
    ),
    claudeCodeModelBase,
    claudeCodeModelEscalated,
    autoMergeOnClean: boolInput("auto-merge-on-clean", "AUTO_REVIEW_AUTO_MERGE", false),
    autoMergePollSeconds: intInput(
      "auto-merge-poll-seconds",
      "AUTO_REVIEW_AUTO_MERGE_POLL_SECONDS",
      15,
      1,
    ),
    autoMergeTimeoutMinutes: intInput(
      "auto-merge-timeout-minutes",
      "AUTO_REVIEW_AUTO_MERGE_TIMEOUT_MINUTES",
      10,
      1,
    ),
    severityThreshold: severityThresholdInput(
      "severity-threshold",
      "AUTO_REVIEW_SEVERITY_THRESHOLD",
      DEFAULT_SEVERITY_THRESHOLD,
    ),
    autoReviewBlockPaths: input(
      "auto-review-block-paths",
      "AUTO_REVIEW_BLOCK_PATHS",
      "",
    ),
    scopeMaxFiles: intInput("scope-max-files", "AUTO_REVIEW_SCOPE_MAX_FILES", 0),
    scopeMaxLines: intInput("scope-max-lines", "AUTO_REVIEW_SCOPE_MAX_LINES", 0),
    hardBlockOverride: stringListInput(
      "auto-review-hard-block-override",
      "AUTO_REVIEW_HARD_BLOCK_OVERRIDE",
    ),
    scopeAllowedPathPrefixes: stringListInput(
      "scope-allowed-path-prefixes",
      "AUTO_REVIEW_SCOPE_ALLOWED_PATH_PREFIXES",
    ),
    scopeAdditionalHardBlockPrefixes: stringListInput(
      "scope-additional-hard-block-prefixes",
      "AUTO_REVIEW_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES",
    ),
  };
}

/**
 * カンマ区切りのパスリストを読み出す。前後の空白はトリムし、空エントリは捨てる。
 * 未設定 / 空文字は空配列を返す。
 */
function stringListInput(inputName: string, envName: string): readonly string[] {
  const raw = input(inputName, envName, "");
  if (raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 入力値を `Severity` として解釈する。空文字や未設定はデフォルトに、認識できない値は
 * warning ログを出した上でデフォルトにフォールバックする。
 */
function severityThresholdInput(
  inputName: string,
  envName: string,
  defaultValue: Severity,
): Severity {
  const raw = input(inputName, envName, "").trim().toUpperCase();
  if (raw === "") return defaultValue;
  if (isSeverity(raw)) return raw;
  core.warning(
    `[config] Unknown severity threshold "${raw}" for ${inputName} / ${envName}; falling back to ${defaultValue}.`,
  );
  return defaultValue;
}

/**
 * Read a value from @actions/core input first, then process.env fallback.
 * Outside GitHub Actions, core.getInput() returns "" (reads INPUT_* env vars which are absent).
 */
function input(inputName: string, envName: string, defaultValue: string): string {
  const fromInput = core.getInput(inputName);
  if (fromInput !== "") return fromInput;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return defaultValue;
}

/**
 * Read a boolean input. Accepts case-insensitive 'true' / 'false'.
 * Empty string returns the default (mirrors GitHub Actions semantics where
 * an unset Repository variable yields '').
 */
function boolInput(inputName: string, envName: string, defaultValue: boolean): boolean {
  const raw = input(inputName, envName, "").trim().toLowerCase();
  if (raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Input ${inputName} / env ${envName} must be 'true' or 'false', got: ${raw}`);
}

/**
 * Read an integer input with an optional minimum-value guard (TY-267 #15).
 *
 * Without `min`, behaves like the legacy reader (accepts any integer incl.
 * 0 / negative). With `min`, rejects values below the threshold at startup so
 * obvious misconfigurations like `MAX_REVIEW_ITERATIONS=0` cannot silently
 * disable the loop.
 */
function intInput(
  inputName: string,
  envName: string,
  defaultValue: number,
  min?: number,
): number {
  const raw = input(inputName, envName, "");
  if (raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Input ${inputName} / env ${envName} must be an integer, got: ${raw}`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(
      `Input ${inputName} / env ${envName} must be >= ${min}, got: ${parsed}`,
    );
  }
  return parsed;
}

function requirePositiveInt(inputName: string, envName: string): number {
  const value = intInput(inputName, envName, 0);
  if (value <= 0) {
    throw new Error(`Required input "${inputName}" or env "${envName}" must be a positive integer, got: ${value}`);
  }
  return value;
}

function requireInput(inputName: string, envName: string): string {
  const value = input(inputName, envName, "");
  if (value === "") {
    throw new Error(`Required input "${inputName}" or env "${envName}" is not set`);
  }
  return value;
}
