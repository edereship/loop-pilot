import { describe, expect, it } from "vitest";
import { gatherSignals } from "../src/gather.js";
import { GhError } from "../src/gh.js";
import { fakeGh } from "./helpers.js";

const vars = (m: Record<string, string>) => async (_repo: string, name: string) => m[name] ?? null;

describe("gatherSignals", () => {
  it("parses variables, secrets, protection, repo info, and Codex activity", async () => {
    const s = await gatherSignals(
      fakeGh({
        getVariable: vars({
          LOOPPILOT_FULL_AUTO: "true",
          LOOPPILOT_LABEL: "ai-fix",
          CHECK_COMMAND: "pytest",
          LOOPPILOT_AUTO_MERGE: "true",
          CODEX_BOT_LOGIN: "custom-bot",
        }),
        listSecretNames: async () => ["ANTHROPIC_API_KEY", "LOOPPILOT_PUSH_TOKEN"],
        getRepoInfo: async () => ({ defaultBranch: "trunk", allowAutoMerge: true }),
        getRequiredStatusCheckContexts: async () => ["ci"],
        listRecentActorLogins: async () => ["alice", "custom-bot"],
      }),
      "acme/widgets",
    );
    expect(s.fullAuto).toBe(true);
    expect(s.autoMerge).toBe(true);
    expect(s.label).toBe("ai-fix");
    expect(s.checkCommand).toBe("pytest");
    expect(s.defaultBranch).toBe("trunk");
    expect(s.codexBotLogin).toBe("custom-bot");
    expect(s.secretNames).toEqual({ ok: true, value: ["ANTHROPIC_API_KEY", "LOOPPILOT_PUSH_TOKEN"] });
    expect(s.requiredChecks).toEqual({ ok: true, value: ["ci"] });
    expect(s.repoInfo).toEqual({ ok: true, value: { defaultBranch: "trunk", allowAutoMerge: true } });
    expect(s.codexSeen).toEqual({ ok: true, value: true });
  });

  it("defaults the Codex bot login and reports codexSeen=false when absent", async () => {
    const s = await gatherSignals(
      fakeGh({ listRecentActorLogins: async () => ["alice", "bob"] }),
      "acme/widgets",
    );
    expect(s.codexBotLogin).toBe("chatgpt-codex-connector[bot]");
    expect(s.codexSeen).toEqual({ ok: true, value: false });
  });

  it("degrades each probe independently on 403 (secrets/protection/repo)", async () => {
    const forbidden = () => {
      throw new GhError("forbidden", 403, "(HTTP 403)");
    };
    const s = await gatherSignals(
      fakeGh({
        listSecretNames: async () => forbidden(),
        getRequiredStatusCheckContexts: async () => forbidden(),
        getRepoInfo: async () => forbidden(),
      }),
      "acme/widgets",
    );
    expect(s.secretNames.ok).toBe(false);
    expect(s.requiredChecks.ok).toBe(false);
    expect(s.repoInfo.ok).toBe(false);
    // Falls back to "main" when repo info is unreadable.
    expect(s.defaultBranch).toBe("main");
    // A failed repo-info probe does not abort the others.
    expect(s.codexSeen.ok).toBe(true);
  });

  it("treats an unreadable variable as unset (falls back to defaults, no crash)", async () => {
    const s = await gatherSignals(
      fakeGh({
        getVariable: async () => {
          throw new GhError("forbidden", 403, "(HTTP 403)");
        },
      }),
      "acme/widgets",
    );
    expect(s.fullAuto).toBe(false);
    expect(s.autoMerge).toBe(false);
    expect(s.label).toBeUndefined();
    expect(s.checkCommand).toBeUndefined();
  });

  it("maps no required checks (null) to an empty list", async () => {
    const s = await gatherSignals(
      fakeGh({ getRequiredStatusCheckContexts: async () => null }),
      "acme/widgets",
    );
    expect(s.requiredChecks).toEqual({ ok: true, value: [] });
  });
});
