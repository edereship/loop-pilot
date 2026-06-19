import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCodexUsageLimitMessage } from "../src/codex-status.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("isCodexUsageLimitMessage", () => {
  it("matches the production fixture from PR #24", () => {
    const body = readFileSync(join(fixtureDir, "codex-usage-limit.txt"), "utf-8");
    expect(isCodexUsageLimitMessage(body)).toBe(true);
  });

  it("matches the exact PR #24 phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "You have reached your Codex usage limits for code reviews.",
      ),
    ).toBe(true);
  });

  it("matches a singular 'review' variant", () => {
    expect(
      isCodexUsageLimitMessage(
        "You have reached your Codex usage limit for code review.",
      ),
    ).toBe(true);
  });

  it("matches an 'exceeded' phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "Codex usage limit exceeded. Please try again later.",
      ),
    ).toBe(true);
  });

  it("matches when wrapped in surrounding noise", () => {
    expect(
      isCodexUsageLimitMessage(
        "Sorry — you have reached your Codex usage limits for code reviews. Try again tomorrow.",
      ),
    ).toBe(true);
  });

  it("does not match a regular Codex review summary", () => {
    expect(
      isCodexUsageLimitMessage(
        "Codex Review: Didn't find any major issues. P0 findings: 0.",
      ),
    ).toBe(false);
  });

  it("does not match arbitrary mentions of 'usage' or 'limit'", () => {
    expect(
      isCodexUsageLimitMessage(
        "P1 The cache eviction has no upper limit on memory usage. See `cache.ts`.",
      ),
    ).toBe(false);
  });

  it("does not match an empty string", () => {
    expect(isCodexUsageLimitMessage("")).toBe(false);
  });

  it("ES-425: matches 'rate limit' phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "You have hit the Codex rate limit. Please wait before requesting another review.",
      ),
    ).toBe(true);
  });

  it("ES-425: matches 'usage cap' phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "Your Codex usage cap has been reached for this billing period.",
      ),
    ).toBe(true);
  });

  it("ES-425: matches 'limit exceeded' standalone phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "Codex limit exceeded — no more reviews available today.",
      ),
    ).toBe(true);
  });

  it("ES-425: matches 'quota exceeded' phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "Your Codex quota has been exceeded.",
      ),
    ).toBe(true);
  });

  it("ES-425: matches 'rate limited' phrasing", () => {
    expect(
      isCodexUsageLimitMessage(
        "Codex is currently rate limited. Try again later.",
      ),
    ).toBe(true);
  });

  it("ES-425: matches noun-first 'Codex rate limit reached' phrasing", () => {
    expect(
      isCodexUsageLimitMessage("Codex rate limit reached. Try again later."),
    ).toBe(true);
    expect(
      isCodexUsageLimitMessage("Codex rate limit exceeded for this period."),
    ).toBe(true);
  });

  it("ES-425: does not match a review finding that mentions rate limiting in code context", () => {
    expect(
      isCodexUsageLimitMessage(
        "P1 The Codex rate limit handler does not back off exponentially",
      ),
    ).toBe(false);
  });
});
