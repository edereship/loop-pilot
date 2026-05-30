import { describe, expect, it } from "vitest";
import {
  anthropicAuthCheck,
  autoMergeCheck,
  codexConnectionCheck,
  codexTokenCheck,
  pushTokenCheck,
} from "../src/checks.js";
import type { PreflightContext } from "../src/preflight.js";
import { fakeGh } from "./helpers.js";

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return { repository: "acme/widgets", gh: fakeGh(), ...over };
}

describe("anthropicAuthCheck", () => {
  it("errors when both credentials are set (config fail-fast)", async () => {
    const r = await anthropicAuthCheck(
      ctx({ secretNames: { ok: true, value: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] } }),
    );
    expect(r.status).toBe("error");
    expect(r.summary).toContain("both");
  });

  it("errors when neither credential is set", async () => {
    const r = await anthropicAuthCheck(ctx({ secretNames: { ok: true, value: [] } }));
    expect(r.status).toBe("error");
    expect(r.summary).toContain("no Anthropic credential");
  });

  it("ok when exactly one is set", async () => {
    const r = await anthropicAuthCheck(ctx({ secretNames: { ok: true, value: ["ANTHROPIC_API_KEY"] } }));
    expect(r.status).toBe("ok");
  });

  it("unknown when secrets cannot be read (403) — never a silent pass", async () => {
    const r = await anthropicAuthCheck(ctx({ secretNames: { ok: false, reason: "insufficient permission (HTTP 403)" } }));
    expect(r.status).toBe("unknown");
    expect(r.details).toContain("403");
  });
});

describe("codexTokenCheck", () => {
  it("ok when CODEX_REVIEW_REQUEST_TOKEN is set", async () => {
    const r = await codexTokenCheck(ctx({ secretNames: { ok: true, value: ["CODEX_REVIEW_REQUEST_TOKEN"] } }));
    expect(r.status).toBe("ok");
  });
  it("warns when missing", async () => {
    const r = await codexTokenCheck(ctx({ secretNames: { ok: true, value: [] } }));
    expect(r.status).toBe("warning");
  });
  it("unknown when secrets unreadable", async () => {
    const r = await codexTokenCheck(ctx({ secretNames: { ok: false, reason: "403" } }));
    expect(r.status).toBe("unknown");
  });
});

describe("pushTokenCheck", () => {
  it("warns when required checks are enforced but the push token is missing", async () => {
    const r = await pushTokenCheck(
      ctx({ secretNames: { ok: true, value: [] }, requiredChecks: { ok: true, value: ["ci"] } }),
    );
    expect(r.status).toBe("warning");
    expect(r.details).toContain("re-trigger required checks");
  });

  it("warns when auto-merge is on but the push token is missing", async () => {
    const r = await pushTokenCheck(
      ctx({ secretNames: { ok: true, value: [] }, requiredChecks: { ok: true, value: [] }, autoMerge: true }),
    );
    expect(r.status).toBe("warning");
  });

  it("ok when the push token is present", async () => {
    const r = await pushTokenCheck(
      ctx({ secretNames: { ok: true, value: ["LOOPPILOT_PUSH_TOKEN"] }, requiredChecks: { ok: true, value: ["ci"] } }),
    );
    expect(r.status).toBe("ok");
  });

  it("ok when there are no required checks and no auto-merge", async () => {
    const r = await pushTokenCheck(
      ctx({ secretNames: { ok: true, value: [] }, requiredChecks: { ok: true, value: [] } }),
    );
    expect(r.status).toBe("ok");
  });

  it("unknown when branch protection is unreadable and the token is missing", async () => {
    const r = await pushTokenCheck(
      ctx({ secretNames: { ok: true, value: [] }, requiredChecks: { ok: false, reason: "HTTP 403" } }),
    );
    expect(r.status).toBe("unknown");
  });

  it("unknown when secrets are unreadable", async () => {
    const r = await pushTokenCheck(ctx({ secretNames: { ok: false, reason: "403" } }));
    expect(r.status).toBe("unknown");
  });
});

describe("autoMergeCheck", () => {
  it("ok (not applicable) when auto-merge is off", async () => {
    const r = await autoMergeCheck(ctx({ autoMerge: false }));
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not enabled");
  });

  it("errors when auto-merge is on but the repo disallows it", async () => {
    const r = await autoMergeCheck(
      ctx({ autoMerge: true, repoInfo: { ok: true, value: { defaultBranch: "main", allowAutoMerge: false } } }),
    );
    expect(r.status).toBe("error");
    expect(r.nextSteps?.join("\n")).toContain("Allow auto-merge");
  });

  it("ok when auto-merge is on and the repo allows it", async () => {
    const r = await autoMergeCheck(
      ctx({ autoMerge: true, repoInfo: { ok: true, value: { defaultBranch: "main", allowAutoMerge: true } } }),
    );
    expect(r.status).toBe("ok");
  });

  it("unknown when the repo setting cannot be read", async () => {
    const r = await autoMergeCheck(ctx({ autoMerge: true, repoInfo: { ok: false, reason: "403" } }));
    expect(r.status).toBe("unknown");
  });
});

describe("codexConnectionCheck", () => {
  it("ok when recent Codex bot activity is seen", async () => {
    const r = await codexConnectionCheck(ctx({ codexSeen: { ok: true, value: true }, codexBotLogin: "chatgpt-codex-connector[bot]" }));
    expect(r.status).toBe("ok");
  });

  it("unknown (not error) when no Codex activity is seen — inference only", async () => {
    const r = await codexConnectionCheck(ctx({ codexSeen: { ok: true, value: false } }));
    expect(r.status).toBe("unknown");
    expect(r.nextSteps?.join("\n")).toContain("Codex GitHub App");
  });

  it("unknown when the inference probe failed", async () => {
    const r = await codexConnectionCheck(ctx({ codexSeen: { ok: false, reason: "rate limited" } }));
    expect(r.status).toBe("unknown");
  });
});
