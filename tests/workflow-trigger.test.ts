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

  it("requires the gate label by default and falls back to 'auto-review-fix'", () => {
    expect(initWorkflow).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix')",
    );
  });

  it("opts out of the label gate only when AUTO_REVIEW_FULL_AUTO is exactly 'true'", () => {
    expect(initWorkflow).toContain("vars.AUTO_REVIEW_FULL_AUTO == 'true'");
    expect(initWorkflow).toContain("vars.AUTO_REVIEW_FULL_AUTO != 'true'");
  });

  it("ignores labeled events under full-auto mode (no double-init on label edits)", () => {
    expect(initWorkflow).toContain(
      "vars.AUTO_REVIEW_FULL_AUTO == 'true' && github.event.action != 'labeled'",
    );
  });

  it("ignores `labeled` events for unrelated labels when the gate is enabled", () => {
    expect(initWorkflow).toContain(
      "github.event.label.name == (vars.AUTO_REVIEW_LABEL || 'auto-review-fix')",
    );
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

  it("requires the gate label by default with 'auto-review-fix' fallback for both event types", () => {
    expect(loopWorkflow).toContain(
      "contains(github.event.issue.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix')",
    );
    expect(loopWorkflow).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.AUTO_REVIEW_LABEL || 'auto-review-fix')",
    );
  });

  it("opts out of the label gate via AUTO_REVIEW_FULL_AUTO=true", () => {
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_FULL_AUTO == 'true'");
  });

  it("forwards both AUTO_REVIEW_LABEL and AUTO_REVIEW_FULL_AUTO to the loop action", () => {
    expect(loopWorkflow).toContain("auto-review-label:");
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_LABEL || ''");
    expect(loopWorkflow).toContain("auto-review-full-auto:");
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_FULL_AUTO || 'false'");
  });

  it("starts from human recovery issue comments without requiring Codex bot markers", () => {
    const removedCommand = "/reset" + "-review";
    const removedInput = "auto-review-reset" + "-roles:";
    const removedEnv = "AUTO_REVIEW_RESET" + "_ROLES";

    expect(loopWorkflow).toContain("github.event.comment.body == '/restart-review'");
    expect(loopWorkflow).toContain("startsWith(github.event.comment.body, '/restart-review ')");
    expect(loopWorkflow).not.toContain(`github.event.comment.body == '${removedCommand}'`);
    expect(loopWorkflow).not.toContain(`startsWith(github.event.comment.body, '${removedCommand} ')`);
    expect(loopWorkflow).toContain("trigger-user-login:");
    expect(loopWorkflow).toContain("github.event.comment.user.login || github.event.review.user.login");
    expect(loopWorkflow).toContain("auto-review-restart-roles:");
    expect(loopWorkflow).toContain("vars.AUTO_REVIEW_RESTART_ROLES || 'author,write,maintain,admin'");
    expect(loopWorkflow).not.toContain(removedInput);
    expect(loopWorkflow).not.toContain(removedEnv);
  });

  it("places recovery triggers ahead of the label gate so commands bypass the gate", () => {
    // Recovery commands must work even after the gate label has been removed.
    // Structurally the if: should be: (COMMANDS) || (LABEL_GATE && (CODEX_TRIGGERS)).
    // We measure positions inside the `if:` expression itself (skipping YAML
    // comments above it that mention the same identifiers).
    const ifStart = loopWorkflow.indexOf("if: >");
    expect(ifStart).toBeGreaterThan(0);
    const commandTriggerIdx = loopWorkflow.indexOf(
      "startsWith(github.event.comment.body, '/restart-review ')",
      ifStart,
    );
    const labelGateIdx = loopWorkflow.indexOf("vars.AUTO_REVIEW_FULL_AUTO == 'true'", ifStart);
    expect(commandTriggerIdx).toBeGreaterThan(ifStart);
    expect(labelGateIdx).toBeGreaterThan(commandTriggerIdx);
  });
});
