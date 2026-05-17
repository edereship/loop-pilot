import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInitConfig } from "../src/config.js";

const ENV_KEYS = [
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "PR_NUMBER",
  "CODEX_REVIEW_REQUEST_TOKEN",
  "AUTO_REVIEW_PUSH_TOKEN",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("Codex review request token config", () => {
  const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }

    process.env.GITHUB_REPOSITORY = "team-yubune/test-auto-ai-review";
    process.env.GITHUB_TOKEN = "github-token";
    process.env.PR_NUMBER = "123";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("falls back to githubToken when CODEX_REVIEW_REQUEST_TOKEN is not set", () => {
    const config = loadInitConfig();
    expect(config.codexReviewRequestToken).toBe("github-token");
  });

  it("uses CODEX_REVIEW_REQUEST_TOKEN when set", () => {
    process.env.CODEX_REVIEW_REQUEST_TOKEN = "codex-connected-user-token";
    const config = loadInitConfig();
    expect(config.codexReviewRequestToken).toBe("codex-connected-user-token");
  });

  it("leaves autoReviewPushToken empty when AUTO_REVIEW_PUSH_TOKEN is not set", () => {
    const config = loadInitConfig();
    expect(config.autoReviewPushToken).toBe("");
  });

  it("uses AUTO_REVIEW_PUSH_TOKEN when set", () => {
    process.env.AUTO_REVIEW_PUSH_TOKEN = "push-token";
    const config = loadInitConfig();
    expect(config.autoReviewPushToken).toBe("push-token");
  });
});
