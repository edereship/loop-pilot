import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TY-343: the repository-root action.yml is a GitHub Marketplace DISCOVERABILITY
// FACADE only — a "front door" so LoopPilot is findable on the Marketplace. It is
// NOT how LoopPilot runs: LoopPilot is event-driven (a PR label + `@codex review`
// fan out to the reusable workflows Edership/loop-pilot/.github/workflows/
// {init,loop}.yml@v1, wired up by the `gh looppilot` CLI). GitHub Marketplace
// lists only Actions/Apps, never `gh` CLI extensions or reusable workflows, so the
// listed artifact has to be a real root action — but it must stay an inert signpost.
//
// These guards lock two invariants:
//   1. The facade meets Marketplace listing requirements (name / description /
//      branding with a valid Feather icon + an allowed color). A typo here only
//      fails at publish time in GitHub's UI, never at merge — so we catch it in CI.
//   2. The facade never silently grows into a SECOND functional code path: it must
//      stay exit-0 and must reference no LoopPilot sub-action / local ./ action.
//
// Companion to reusable-workflows.test.ts / config-wiring.test.ts.

const rootActionPath = "action.yml";
// Read lazily so the RED run fails on clean assertions ("" has no branding block)
// rather than erroring out on a missing-file throw at module load.
const rootAction = existsSync(rootActionPath)
  ? readFileSync(rootActionPath, "utf8")
  : "";
// Executable YAML only: drop full-line `#` comments so guards that assert on the
// action's *behavior* (e.g. "no non-zero exit") aren't tripped by prose that
// merely mentions `exit 1`. The facade's run: banner uses no `#`-prefixed lines.
const rootActionCode = rootAction
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");
const readmeEn = readFileSync("README.md", "utf8");
const readmeJa = readFileSync("README.ja.md", "utf8");

// GitHub Marketplace branding constraints (docs: metadata-syntax):
//   - color MUST be one of these nine values.
//   - icon MUST be a Feather v4.28.0 icon, and must NOT be one of the 13 omitted.
const ALLOWED_BRANDING_COLORS = [
  "white",
  "black",
  "yellow",
  "blue",
  "green",
  "orange",
  "red",
  "purple",
  "gray-dark",
];
const OMITTED_FEATHER_ICONS = [
  "coffee",
  "columns",
  "divide-circle",
  "divide-square",
  "divide",
  "frown",
  "hexagon",
  "key",
  "meh",
  "mouse-pointer",
  "smile",
  "tool",
  "x-octagon",
];

describe("marketplace facade: root action.yml meets listing requirements", () => {
  it("declares a LoopPilot-branded, publishable name (not the bare 'LoopPilot') + a non-empty description", () => {
    const nameMatch = rootAction.match(/^name:\s*"?([^"\n]+?)"?\s*$/m);
    expect(nameMatch).not.toBeNull();
    const name = nameMatch![1].trim();
    expect(name).toContain("LoopPilot");
    // GitHub Marketplace forbids an action name that matches an existing GitHub
    // user/org you don't own. A `looppilot` user exists, so the bare brand name
    // "LoopPilot" would be REJECTED at publish — the name must be more specific.
    expect(name.toLowerCase()).not.toBe("looppilot");
    expect(rootAction).toMatch(/^description:\s*\S/m);
  });

  it("keeps the description under GitHub Marketplace's 125-character limit", () => {
    // Marketplace rejects a description >= 125 chars — but only at publish time in
    // the Releases UI, never at merge. Guard it here so it fails in CI instead.
    const descMatch = rootAction.match(/^description:\s*"([^"\n]*)"\s*$/m);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeLessThan(125);
  });

  it("is a composite action (no published image / no dist entrypoint)", () => {
    expect(rootAction).toContain('using: "composite"');
  });

  it("carries a branding block with an allowed color and a valid Feather icon", () => {
    expect(rootAction).toMatch(/^branding:/m);

    const colorMatch = rootAction.match(/^\s+color:\s*["']?([a-z-]+)["']?\s*$/m);
    expect(colorMatch).not.toBeNull();
    expect(ALLOWED_BRANDING_COLORS).toContain(colorMatch![1]);

    const iconMatch = rootAction.match(/^\s+icon:\s*["']?([a-z-]+)["']?\s*$/m);
    expect(iconMatch).not.toBeNull();
    expect(iconMatch![1].length).toBeGreaterThan(0);
    expect(OMITTED_FEATHER_ICONS).not.toContain(iconMatch![1]);
  });
});

describe("marketplace facade: stays an inert signpost (never a 2nd code path)", () => {
  it("never fails the job — exit 0 only, no exit 1 / non-zero", () => {
    // A misuse (someone pastes the Marketplace `uses:` snippet into a job) should
    // print guidance and succeed, not turn into a red CI failure on first contact.
    expect(rootActionCode).not.toMatch(/exit\s+[1-9]/);
  });

  it("references no LoopPilot sub-action or local ./ action, so it cannot run the loop", () => {
    expect(rootActionCode).not.toContain("uses: ./");
    expect(rootActionCode).not.toMatch(/uses:\s*["']?Edership\/loop-pilot/);
  });

  it("points users at the real install paths (gh looppilot CLI)", () => {
    expect(rootAction).toContain("gh extension install Edership/gh-looppilot");
  });
});

describe("marketplace facade: README documents the listing as a non-consumption front door (TY-343 AC #3/#4)", () => {
  it("both READMEs link to the GitHub Marketplace listing", () => {
    expect(readmeEn).toContain("github.com/marketplace/actions/");
    expect(readmeJa).toContain("github.com/marketplace/actions/");
  });

  it("both READMEs warn that the bare root ref is not the way to run LoopPilot", () => {
    // The recommended path is the gh looppilot CLI / reusable workflows — NOT
    // `uses: Edership/loop-pilot@v1` (bare root ref), which only prints guidance.
    // (The workflow refs are `Edership/loop-pilot/.github/...@v1`; the bare
    // `Edership/loop-pilot@v1` substring appears only in this warning.)
    expect(readmeEn).toContain("Edership/loop-pilot@v1");
    expect(readmeJa).toContain("Edership/loop-pilot@v1");
  });
});
