import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("parseArgs", () => {
  it("defaults to help with no args", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("parses init and doctor", () => {
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["doctor"]).command).toBe("doctor");
  });

  it("treats `init --preflight-only` as doctor", () => {
    expect(parseArgs(["init", "--preflight-only"]).command).toBe("doctor");
  });

  it("parses boolean flags", () => {
    const a = parseArgs(["init", "--full-auto", "--same-repo", "--dry-run", "--force", "--no-preflight"]);
    expect(a).toMatchObject({
      command: "init",
      fullAuto: true,
      sameRepo: true,
      dryRun: true,
      force: true,
      noPreflight: true,
    });
  });

  it("parses value flags", () => {
    const a = parseArgs([
      "init",
      "--label",
      "ai-fix",
      "--check-command",
      "pytest -xvs",
      "--ref",
      "v1.2.3",
      "--repo",
      "acme/loop-pilot",
    ]);
    expect(a.label).toBe("ai-fix");
    expect(a.checkCommand).toBe("pytest -xvs");
    expect(a.ref).toBe("v1.2.3");
    expect(a.actionRepo).toBe("acme/loop-pilot");
  });

  it("parses --json and version/help", () => {
    expect(parseArgs(["doctor", "--json"]).json).toBe(true);
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-h"]).command).toBe("help");
  });
});
