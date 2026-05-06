import * as core from "@actions/core";

export interface Config {
  maxReviewIterations: number;
  debounceSeconds: number;
  checkCommand: string;
  maxFilesPerIteration: number;
  maxInputTokensPerFile: number;
  codexBotLogin: string;
  stabilizeIntervalSeconds: number;
  stabilizeCount: number;
  codexReviewMarker: string;
  codexReviewRequestToken: string;
  anthropicApiKey: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  // New: moved from inline process.env reads in main-loop.ts
  triggerCommentId: number;
  triggerCommentBody: string;
  prHeadRef: string;
  prTitle: string;
  // Empty string = label gating disabled (PoC compatibility); non-empty = only PRs with this label proceed.
  autoReviewLabel: string;
}

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

  return {
    maxReviewIterations: intInput("max-review-iterations", "MAX_REVIEW_ITERATIONS", 20),
    debounceSeconds: intInput("debounce-seconds", "DEBOUNCE_SECONDS", 90),
    checkCommand: input("check-command", "CHECK_COMMAND", "npm run check"),
    maxFilesPerIteration: intInput("max-files-per-iteration", "MAX_FILES_PER_ITERATION", 10),
    maxInputTokensPerFile: intInput("max-input-tokens-per-file", "MAX_INPUT_TOKENS_PER_FILE", 30000),
    codexBotLogin: input("codex-bot-login", "CODEX_BOT_LOGIN", "chatgpt-codex-connector[bot]"),
    stabilizeIntervalSeconds: intInput("stabilize-interval-seconds", "STABILIZE_INTERVAL_SECONDS", 10),
    stabilizeCount: intInput("stabilize-count", "STABILIZE_COUNT", 3),
    codexReviewMarker: input("codex-review-marker", "CODEX_REVIEW_MARKER", "Codex Review"),
    githubToken,
    codexReviewRequestToken,
    repoOwner,
    repoName,
    prNumber: requirePositiveInt("pr-number", "PR_NUMBER"),
    triggerCommentId: intInput("trigger-comment-id", "TRIGGER_COMMENT_ID", 0),
    triggerCommentBody: input("trigger-comment-body", "TRIGGER_COMMENT_BODY", ""),
    prHeadRef: input("pr-head-ref", "PR_HEAD_REF", ""),
    prTitle: input("pr-title", "PR_TITLE", ""),
    autoReviewLabel: input("auto-review-label", "AUTO_REVIEW_LABEL", ""),
  };
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
