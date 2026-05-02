import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const initWorkflow = readFileSync(".github/workflows/auto-review-init.yml", "utf8");
const loopWorkflow = readFileSync(".github/workflows/auto-review-loop.yml", "utf8");

describe("Workflow A trigger guard", () => {
  it("does not start auto-review for fork PRs", () => {
    expect(initWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
});

describe("Workflow B trigger guard", () => {
  it("does not compare CODEX_BOT_LOGIN unless the variable is non-empty", () => {
    expect(loopWorkflow).toContain("vars.CODEX_BOT_LOGIN != ''");
    expect(loopWorkflow).toContain("github.event.comment.user.login == vars.CODEX_BOT_LOGIN");
  });

  it("does not call contains() with CODEX_REVIEW_MARKER unless the variable is non-empty", () => {
    expect(loopWorkflow).toContain("vars.CODEX_REVIEW_MARKER != ''");
    expect(loopWorkflow).toContain("contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER)");
  });

  it("keeps explicit fallback checks for the default Codex bot and review marker", () => {
    expect(loopWorkflow).toContain("github.event.comment.user.login == 'chatgpt-codex-connector[bot]'");
    expect(loopWorkflow).toContain("contains(github.event.comment.body, 'Codex Review')");
  });
});
