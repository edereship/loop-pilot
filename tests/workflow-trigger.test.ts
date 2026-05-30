import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TY-345: the gate logic, Codex-marker detection, and action wiring now live in
// the REUSABLE workflows (`init.yml` / `loop.yml`, `on: workflow_call`). The
// dogfooding files (`looppilot-init.yml` / `looppilot-loop.yml`) are thin
// callers that keep only the `on:` triggers and forward to the reusable
// workflow. Trigger assertions target the callers; gate/wiring assertions
// target the reusable workflows.
const initReusable = readFileSync(".github/workflows/init.yml", "utf8");
const loopReusable = readFileSync(".github/workflows/loop.yml", "utf8");
const initCaller = readFileSync(".github/workflows/looppilot-init.yml", "utf8");
const loopCaller = readFileSync(".github/workflows/looppilot-loop.yml", "utf8");
const loopAction = readFileSync("loop/action.yml", "utf8");
const postFixAction = readFileSync("loop/post-fix/action.yml", "utf8");

describe("Workflow A trigger guard", () => {
  it("does not start LoopPilot for fork PRs", () => {
    expect(initReusable).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("passes the optional Codex review request token to init", () => {
    expect(initReusable).toContain("codex-review-request-token:");
    expect(initReusable).toContain("secrets.CODEX_REVIEW_REQUEST_TOKEN");
  });

  it("plumbs vars.MAX_REVIEW_ITERATIONS into init so the initial status comment shows the operator cap (TY-309)", () => {
    // Without this the init step falls back to the default 20 and the first
    // status comment shows a cap that diverges from vars.MAX_REVIEW_ITERATIONS
    // until the first post-fix iteration overwrites it. Must use the same
    // expression as loop.yml so both workflows agree on the cap.
    expect(initReusable).toContain(
      "max-review-iterations: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}",
    );
    expect(loopReusable).toContain(
      "max-review-iterations: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}",
    );
  });

  it("listens for the labeled event so adding the gate label can start LoopPilot", () => {
    // The trigger lives in the thin caller's `on:` (workflow_call runs on the
    // caller's events).
    expect(initCaller).toContain("types: [opened, ready_for_review, labeled]");
  });

  it("requires the gate label by default and falls back to 'loop-pilot'", () => {
    expect(initReusable).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot')",
    );
  });

  it("opts out of the label gate only when LOOPPILOT_FULL_AUTO is exactly 'true'", () => {
    expect(initReusable).toContain("vars.LOOPPILOT_FULL_AUTO == 'true'");
    expect(initReusable).toContain("vars.LOOPPILOT_FULL_AUTO != 'true'");
  });

  it("ignores labeled events under full-auto mode (no double-init on label edits)", () => {
    expect(initReusable).toContain(
      "vars.LOOPPILOT_FULL_AUTO == 'true' && github.event.action != 'labeled'",
    );
  });

  it("ignores `labeled` events for unrelated labels when the gate is enabled", () => {
    expect(initReusable).toContain(
      "github.event.label.name == (vars.LOOPPILOT_LABEL || 'loop-pilot')",
    );
  });

  it("serializes init runs per PR without canceling the queued duplicate", () => {
    expect(initReusable).toContain("concurrency:");
    expect(initReusable).toContain("  init:\n    concurrency:");
    expect(initReusable).toContain(
      "group: looppilot-init-${{ github.repository }}-${{ github.event.pull_request.number }}",
    );
    expect(initReusable).toContain("cancel-in-progress: false");
  });
});

describe("Workflow B trigger guard", () => {
  it("starts from Codex pull request review submissions", () => {
    // Trigger in the caller; gate detection in the reusable workflow.
    expect(loopCaller).toContain("pull_request_review:");
    expect(loopCaller).toContain("types: [submitted]");
    expect(loopReusable).toContain("github.event_name == 'pull_request_review'");
    expect(loopReusable).toContain("github.event.review.user.login == 'chatgpt-codex-connector[bot]'");
    expect(loopReusable).toContain("contains(github.event.review.body, 'Codex Review')");
  });

  it("uses the PR number from either issue_comment or pull_request_review events", () => {
    expect(loopReusable).toContain("github.event.issue.number || github.event.pull_request.number");
  });

  it("passes the optional Codex review request token to loop", () => {
    expect(loopReusable).toContain("codex-review-request-token:");
    expect(loopReusable).toContain("secrets.CODEX_REVIEW_REQUEST_TOKEN");
  });

  it("passes the optional LoopPilot push token to loop", () => {
    expect(loopReusable).toContain("looppilot-push-token:");
    expect(loopReusable).toContain("secrets.LOOPPILOT_PUSH_TOKEN");
    expect(loopAction).toContain("looppilot-push-token:");
    expect(loopAction).toContain("looppilot-push-token: ${{ inputs.looppilot-push-token }}");
    expect(postFixAction).toContain("looppilot-push-token:");
  });

  it("TY-281: wires build-command from vars.BUILD_COMMAND through loop → post-fix", () => {
    // Reusable workflow reads the repo variable (empty default keeps the
    // step a no-op for downstream repos that do not commit build artifacts).
    expect(loopReusable).toContain("build-command: ${{ vars.BUILD_COMMAND || '' }}");
    // Composite action declares the input and forwards it to post-fix.
    expect(loopAction).toContain("build-command:");
    expect(loopAction).toContain("build-command: ${{ inputs.build-command }}");
    // Post-fix sub-action declares the input.
    expect(postFixAction).toContain("build-command:");
  });

  it("does not compare CODEX_BOT_LOGIN unless the variable is non-empty", () => {
    expect(loopReusable).toContain("vars.CODEX_BOT_LOGIN != ''");
    expect(loopReusable).toContain("github.event.comment.user.login == vars.CODEX_BOT_LOGIN");
    expect(loopReusable).toContain("github.event.review.user.login == vars.CODEX_BOT_LOGIN");
  });

  it("does not call contains() with CODEX_REVIEW_MARKER unless the variable is non-empty", () => {
    expect(loopReusable).toContain("vars.CODEX_REVIEW_MARKER != ''");
    expect(loopReusable).toContain("contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER)");
    expect(loopReusable).toContain("contains(github.event.review.body, vars.CODEX_REVIEW_MARKER)");
  });

  it("keeps explicit fallback checks for the default Codex bot and review marker", () => {
    expect(loopReusable).toContain("github.event.comment.user.login == 'chatgpt-codex-connector[bot]'");
    expect(loopReusable).toContain("contains(github.event.comment.body, 'Codex Review')");
  });

  it("requires the gate label by default with 'loop-pilot' fallback for both event types", () => {
    expect(loopReusable).toContain(
      "contains(github.event.issue.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot')",
    );
    expect(loopReusable).toContain(
      "contains(github.event.pull_request.labels.*.name, vars.LOOPPILOT_LABEL || 'loop-pilot')",
    );
  });

  it("opts out of the label gate via LOOPPILOT_FULL_AUTO=true", () => {
    expect(loopReusable).toContain("vars.LOOPPILOT_FULL_AUTO == 'true'");
  });

  it("forwards both LOOPPILOT_LABEL and LOOPPILOT_FULL_AUTO to the loop action", () => {
    expect(loopReusable).toContain("looppilot-label:");
    expect(loopReusable).toContain("vars.LOOPPILOT_LABEL || ''");
    expect(loopReusable).toContain("looppilot-full-auto:");
    expect(loopReusable).toContain("vars.LOOPPILOT_FULL_AUTO || 'false'");
  });

  it("starts from human recovery issue comments without requiring Codex bot markers", () => {
    const removedCommand = "/reset" + "-review";
    const removedInput = "looppilot-reset" + "-roles:";
    const removedEnv = "LOOPPILOT_RESET" + "_ROLES";

    expect(loopReusable).toContain("github.event.comment.body == '/restart-review'");
    expect(loopReusable).toContain("startsWith(github.event.comment.body, '/restart-review ')");
    expect(loopReusable).not.toContain(`github.event.comment.body == '${removedCommand}'`);
    expect(loopReusable).not.toContain(`startsWith(github.event.comment.body, '${removedCommand} ')`);
    expect(loopReusable).toContain("trigger-user-login:");
    expect(loopReusable).toContain("github.event.comment.user.login || github.event.review.user.login");
    expect(loopReusable).toContain("looppilot-restart-roles:");
    expect(loopReusable).toContain("vars.LOOPPILOT_RESTART_ROLES || 'author,write,maintain,admin'");
    expect(loopReusable).not.toContain(removedInput);
    expect(loopReusable).not.toContain(removedEnv);
  });

  it("places recovery triggers ahead of the label gate so commands bypass the gate", () => {
    // Recovery commands must work even after the gate label has been removed.
    // Structurally the if: should be: (COMMANDS) || (LABEL_GATE && (CODEX_TRIGGERS)).
    // We measure positions inside the `if:` expression itself (skipping YAML
    // comments above it that mention the same identifiers).
    const ifStart = loopReusable.indexOf("if: >");
    expect(ifStart).toBeGreaterThan(0);
    const commandTriggerIdx = loopReusable.indexOf(
      "startsWith(github.event.comment.body, '/restart-review ')",
      ifStart,
    );
    const labelGateIdx = loopReusable.indexOf("vars.LOOPPILOT_FULL_AUTO == 'true'", ifStart);
    expect(commandTriggerIdx).toBeGreaterThan(ifStart);
    expect(labelGateIdx).toBeGreaterThan(commandTriggerIdx);
  });
});
