import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const initWorkflow = readFileSync(".github/workflows/auto-review-init.yml", "utf8");
const loopWorkflow = readFileSync(".github/workflows/auto-review-loop.yml", "utf8");

describe("Workflow A trigger guard", () => {
  it("does not start auto-review for fork PRs", () => {
    expect(initWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("passes the optional Codex review request token to init", () => {
    expect(initWorkflow).toContain("codex-review-request-token:");
    expect(initWorkflow).toContain("secrets.CODEX_REVIEW_REQUEST_TOKEN");
  });

  it("listens for the labeled event so adding the gate label can start auto-review", () => {
    expect(initWorkflow).toContain("types: [opened, ready_for_review, labeled]");
  });

  it("disables label gating only when AUTO_REVIEW_LABEL is empty", () => {
    expect(initWorkflow).toContain("vars.AUTO_REVIEW_LABEL == ''");
    expect(initWorkflow).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL)",
    );
  });

  it("ignores `labeled` events when AUTO_REVIEW_LABEL is empty (no double-init on label edits)", () => {
    expect(initWorkflow).toContain(
      "vars.AUTO_REVIEW_LABEL == '' && github.event.action != 'labeled'",
    );
  });

  it("requires a non-empty AUTO_REVIEW_LABEL before enforcing the label-match branch", () => {
    expect(initWorkflow).toContain("vars.AUTO_REVIEW_LABEL != ''");
  });

  it("ignores `labeled` events for unrelated labels when gating is enabled", () => {
    expect(initWorkflow).toContain("github.event.action != 'labeled'");
    expect(initWorkflow).toContain("github.event.label.name == vars.AUTO_REVIEW_LABEL");
  });
});

describe("Workflow B trigger guard", () => {
  it("starts from Codex pull request review submissions", () => {
    expect(loopWorkflow).toContain("pull_request_review:");
    expect(loopWorkflow).toContain("types: [submitted]");
    expect(loopWorkflow).toContain("github.event_name == 'pull_request_review'");
    expect(loopWorkflow).toContain("github.event.review.user.login == 'chatgpt-codex-connector[bot]'");
    expect(loopWorkflow).toContain("contains(github.event.review.body, 'Codex Review')");
  });

  it("uses the PR number from either issue_comment or pull_request_review events", () => {
    expect(loopWorkflow).toContain("github.event.issue.number || github.event.pull_request.number");
  });

  it("passes the optional Codex review request token to loop", () => {
    expect(loopWorkflow).toContain("codex-review-request-token:");
    expect(loopWorkflow).toContain("secrets.CODEX_REVIEW_REQUEST_TOKEN");
  });

  it("does not compare CODEX_BOT_LOGIN unless the variable is non-empty", () => {
    expect(loopWorkflow).toContain("vars.CODEX_BOT_LOGIN != ''");
    expect(loopWorkflow).toContain("github.event.comment.user.login == vars.CODEX_BOT_LOGIN");
    expect(loopWorkflow).toContain("github.event.review.user.login == vars.CODEX_BOT_LOGIN");
  });

  it("does not call contains() with CODEX_REVIEW_MARKER unless the variable is non-empty", () => {
    expect(loopWorkflow).toContain("vars.CODEX_REVIEW_MARKER != ''");
    expect(loopWorkflow).toContain("contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER)");
    expect(loopWorkflow).toContain("contains(github.event.review.body, vars.CODEX_REVIEW_MARKER)");
  });

  it("keeps explicit fallback checks for the default Codex bot and review marker", () => {
    expect(loopWorkflow).toContain("github.event.comment.user.login == 'chatgpt-codex-connector[bot]'");
    expect(loopWorkflow).toContain("contains(github.event.comment.body, 'Codex Review')");
  });

  it("does not run auto-fix unless the PR carries AUTO_REVIEW_LABEL (when set)", () => {
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_LABEL == ''");
    expect(loopWorkflow).toContain(
      "contains(github.event.issue.labels.*.name, vars.AUTO_REVIEW_LABEL)",
    );
    expect(loopWorkflow).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL)",
    );
  });

  it("forwards AUTO_REVIEW_LABEL to the loop action for runtime re-check", () => {
    expect(loopWorkflow).toContain("auto-review-label:");
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_LABEL || ''");
  });
});
