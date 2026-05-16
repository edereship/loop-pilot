import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadInitConfig } from "../src/config.js";

/**
 * `loadConfig` reads from `core.getInput()` (INPUT_<NAME>) first and falls
 * back to `process.env[<NAME>]`. The tests below drive it via plain env vars
 * — vitest does not seed `INPUT_<NAME>`, so `getInput` returns "" and the
 * fallback path is exercised.
 */

const REQUIRED_ENV: Record<string, string> = {
  GITHUB_REPOSITORY: "team-yubune/test-auto-ai-review",
  GITHUB_TOKEN: "github-token",
  PR_NUMBER: "99",
};

function withEnv(extra: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(extra)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

describe("loadConfig — Claude authentication (TY-260)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("accepts ANTHROPIC_API_KEY alone and leaves the OAuth slot empty", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("sk-ant-test");
    expect(config.claudeCodeOauthToken).toBe("");
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN alone and leaves the API key slot empty", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("");
    expect(config.claudeCodeOauthToken).toBe("oauth-test");
  });

  it("fails fast when neither credential is set (cost-mistake guard)", () => {
    expect(() => loadConfig()).toThrow(
      /Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it("fails fast when both credentials are set (cost-mistake guard)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";

    expect(() => loadConfig()).toThrow(
      /Set exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, not both/,
    );
  });

  it("loadInitConfig leaves both credential slots empty (init has no Claude call)", () => {
    const config = loadInitConfig();

    expect(config.anthropicApiKey).toBe("");
    expect(config.claudeCodeOauthToken).toBe("");
  });
});

describe("loadInitConfig — hard-block override (TY-255)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      AUTO_REVIEW_HARD_BLOCK_OVERRIDE: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("defaults to an empty list when the variable is unset", () => {
    expect(loadInitConfig().hardBlockOverride).toEqual([]);
  });

  it("treats an empty string as no override (variable defined but blank)", () => {
    process.env.AUTO_REVIEW_HARD_BLOCK_OVERRIDE = "";
    expect(loadInitConfig().hardBlockOverride).toEqual([]);
  });

  it("parses comma-separated paths and trims surrounding whitespace", () => {
    process.env.AUTO_REVIEW_HARD_BLOCK_OVERRIDE = " package.json , tsconfig.json ";
    expect(loadInitConfig().hardBlockOverride).toEqual([
      "package.json",
      "tsconfig.json",
    ]);
  });

  it("discards empty entries from stray separators", () => {
    process.env.AUTO_REVIEW_HARD_BLOCK_OVERRIDE = "package.json,,tsconfig.json,";
    expect(loadInitConfig().hardBlockOverride).toEqual([
      "package.json",
      "tsconfig.json",
    ]);
  });
});
