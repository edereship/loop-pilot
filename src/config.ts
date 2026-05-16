import * as core from "@actions/core";
import { isSeverity } from "./severity-parser.js";
import type { Severity } from "./types.js";

export interface Config {
  maxReviewIterations: number;
  debounceSeconds: number;
  checkCommand: string;
  codexBotLogin: string;
  stabilizeIntervalSeconds: number;
  stabilizeCount: number;
  codexReviewMarker: string;
  codexReviewRequestToken: string;
  autoReviewPushToken: string;
  anthropicApiKey: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  // New: moved from inline process.env reads in main-loop.ts
  triggerCommentId: number;
  triggerCommentBody: string;
  triggerUserLogin: string;
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
  // Opt-in PR auto-merge (TY-245). When true, the loop calls
  // `gh pr merge --auto --squash` after a `done / no_findings` transition.
  // Other stop reasons never enable auto-merge.
  autoMergeOnClean: boolean;
  // Severity threshold (TY-256). Findings whose severity is strictly below the
  // threshold (numerically larger; e.g., P3 when threshold is P2) are excluded
  // from the auto-fix pipeline and counted under `belowThreshold` in observability
  // logs. Default `P2` preserves prior behavior. Invalid values fall back to `P2`
  // with a warning.
  severityThreshold: Severity;
}

export const DEFAULT_SEVERITY_THRESHOLD: Severity = "P2";

const DEFAULT_CLAUDE_CODE_MODEL_BASE = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_CODE_MODEL_ESCALATED = "claude-opus-4-7";

/**
 * Fallback label name used when the user has not configured AUTO_REVIEW_LABEL.
 * "auto-review-fix" reflects that the label triggers the full Codex review +
 * Claude auto-fix loop, not just a review.
 */
export const DEFAULT_AUTO_REVIEW_LABEL = "auto-review-fix";

export function loadConfig(): Config {
  return {
    ...loadBaseConfig(),
    anthropicApiKey: requireInput("anthropic-api-key", "ANTHROPIC_API_KEY"),
  };
}

export function loadInitConfig(): Config {
  return {
    ...loadBaseConfig(),
    anthropicApiKey: "",
  };
}

function loadBaseConfig(): Omit<Config, "anthropicApiKey"> {
  const repoFullName = requireInput("github-repository", "GITHUB_REPOSITORY");
  const [repoOwner, repoName] = repoFullName.split("/");
  const validRepoSegment = /^[a-zA-Z0-9._-]+$/;
  if (!repoOwner || !repoName || !validRepoSegment.test(repoOwner) || !validRepoSegment.test(repoName)) {
    throw new Error(
      `github-repository must be in "owner/name" format with valid characters, got: "${repoFullName}"`
    );
  }

  const githubToken = requireInput("github-token", "GITHUB_TOKEN");
  const codexReviewRequestToken = input(
    "codex-review-request-token",
    "CODEX_REVIEW_REQUEST_TOKEN",
    githubToken
  );
  const autoReviewPushToken = input("auto-review-push-token", "AUTO_REVIEW_PUSH_TOKEN", "");

  return {
    maxReviewIterations: intInput("max-review-iterations", "MAX_REVIEW_ITERATIONS", 20),
    debounceSeconds: intInput("debounce-seconds", "DEBOUNCE_SECONDS", 90),
    checkCommand: input("check-command", "CHECK_COMMAND", "npm run check"),
    codexBotLogin: input("codex-bot-login", "CODEX_BOT_LOGIN", "chatgpt-codex-connector[bot]"),
    stabilizeIntervalSeconds: intInput("stabilize-interval-seconds", "STABILIZE_INTERVAL_SECONDS", 10),
    stabilizeCount: intInput("stabilize-count", "STABILIZE_COUNT", 3),
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
    prHeadRef: input("pr-head-ref", "PR_HEAD_REF", ""),
    prTitle: input("pr-title", "PR_TITLE", ""),
    autoReviewLabel: input("auto-review-label", "AUTO_REVIEW_LABEL", ""),
    autoReviewFullAuto: boolInput("auto-review-full-auto", "AUTO_REVIEW_FULL_AUTO", false),
    autoReviewRestartRoles: input(
      "auto-review-restart-roles",
      "AUTO_REVIEW_RESTART_ROLES",
      "author,write,maintain,admin",
    ),
    claudeCodeModelBase: input(
      "claude-code-model-base",
      "CLAUDE_CODE_MODEL_BASE",
      DEFAULT_CLAUDE_CODE_MODEL_BASE,
    ),
    claudeCodeModelEscalated: input(
      "claude-code-model-escalated",
      "CLAUDE_CODE_MODEL_ESCALATED",
      DEFAULT_CLAUDE_CODE_MODEL_ESCALATED,
    ),
    autoMergeOnClean: boolInput("auto-merge-on-clean", "AUTO_REVIEW_AUTO_MERGE", false),
    severityThreshold: severityThresholdInput(
      "severity-threshold",
      "AUTO_REVIEW_SEVERITY_THRESHOLD",
      DEFAULT_SEVERITY_THRESHOLD,
    ),
  };
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

function intInput(inputName: string, envName: string, defaultValue: number): number {
  const raw = input(inputName, envName, "");
  if (raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Input ${inputName} / env ${envName} must be an integer, got: ${raw}`);
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
