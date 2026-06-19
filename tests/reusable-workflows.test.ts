import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMismatchedActionRefs } from "../src/action-ref-check.js";

// TY-345: reusable `workflow_call` workflows + thin callers.
const initReusable = readFileSync(".github/workflows/init.yml", "utf8");
const loopReusable = readFileSync(".github/workflows/loop.yml", "utf8");
const initCaller = readFileSync(".github/workflows/looppilot-init.yml", "utf8");
const loopCaller = readFileSync(".github/workflows/looppilot-loop.yml", "utf8");
const readme = readFileSync("README.md", "utf8");
const loopComposite = readFileSync("loop/action.yml", "utf8");
const preFixAction = readFileSync("loop/pre-fix/action.yml", "utf8");
const readmeJa = readFileSync("README.ja.md", "utf8");

describe("reusable workflows: workflow_call surface", () => {
  it("both reusable workflows are workflow_call entrypoints", () => {
    expect(initReusable).toContain("on:\n  workflow_call:");
    expect(loopReusable).toContain("on:\n  workflow_call:");
  });

  it("reusable init enumerates the optional Codex token secret (cross-org callers cannot inherit)", () => {
    // GITHUB_TOKEN is provided automatically and must NOT be declared.
    expect(initReusable).toContain("secrets:");
    expect(initReusable).toContain("CODEX_REVIEW_REQUEST_TOKEN:");
    expect(initReusable).not.toContain("GITHUB_TOKEN:\n        required");
  });

  it("reusable loop enumerates all four custom secrets (GITHUB_TOKEN stays implicit)", () => {
    for (const s of [
      "CODEX_REVIEW_REQUEST_TOKEN:",
      "LOOPPILOT_PUSH_TOKEN:",
      "ANTHROPIC_API_KEY:",
      "CLAUDE_CODE_OAUTH_TOKEN:",
    ]) {
      expect(loopReusable).toContain(s);
    }
  });
});

describe("reusable workflows: sub-action refs use the published tag, never ./", () => {
  it("reusable loop calls the composite action by published path@v1, not a local ./ ref", () => {
    expect(loopReusable).toContain("uses: team-yubune/loop-pilot/loop@v1");
    expect(loopReusable).not.toContain("uses: ./loop");
  });

  it("reusable init calls the composite action by published path@v1, not a local ./ ref", () => {
    expect(initReusable).toContain("uses: team-yubune/loop-pilot/init@v1");
    expect(initReusable).not.toContain("uses: ./init");
  });

  it("the action-ref release guard (TY-342) sees a consistent @v1 major in the reusable workflows", () => {
    expect(findMismatchedActionRefs(loopReusable, "v1")).toEqual([]);
    expect(findMismatchedActionRefs(initReusable, "v1")).toEqual([]);
    // A major bump must flag the reusable workflows too, so a release can't
    // ship a v2 tag while these still point at @v1.
    expect(findMismatchedActionRefs(loopReusable, "v2").length).toBeGreaterThan(0);
    expect(findMismatchedActionRefs(initReusable, "v2").length).toBeGreaterThan(0);
  });
});

describe("reusable workflows: permissions", () => {
  it("reusable loop declares the full write set plus actions: read for the auto-merge guard", () => {
    expect(loopReusable).toContain("contents: write");
    expect(loopReusable).toContain("pull-requests: write");
    expect(loopReusable).toContain("issues: write");
    expect(loopReusable).toContain("actions: read");
  });

  it("reusable init declares contents: read (init never pushes)", () => {
    expect(initReusable).toContain("contents: read");
    expect(initReusable).toContain("pull-requests: write");
    expect(initReusable).toContain("issues: write");
  });
});

describe("reusable loop: switchable toolchain via the `language` input", () => {
  it("declares a `language` input defaulting to node", () => {
    expect(loopReusable).toContain("inputs:");
    expect(loopReusable).toContain("language:");
    expect(loopReusable).toContain('default: "node"');
  });

  it("gates each toolchain setup step on inputs.language", () => {
    expect(loopReusable).toContain("if: inputs.language == 'node'");
    expect(loopReusable).toContain("if: inputs.language == 'python'");
    expect(loopReusable).toContain("if: inputs.language == 'go'");
    expect(loopReusable).toContain("if: inputs.language == 'rust'");
  });

  it("keeps the historical Node default behaviour (setup-node + npm ci)", () => {
    expect(loopReusable).toContain("uses: actions/setup-node@v5");
    expect(loopReusable).toContain(
      "if: inputs.language == 'node' && hashFiles('package-lock.json') != ''",
    );
    expect(loopReusable).toContain("run: npm ci");
  });
});

describe("thin dogfooding callers", () => {
  it("init caller forwards to the local reusable workflow with inherited secrets", () => {
    expect(initCaller).toContain("uses: ./.github/workflows/init.yml");
    expect(initCaller).toContain("secrets: inherit");
  });

  it("loop caller forwards to the local reusable workflow with inherited secrets and actions: read", () => {
    expect(loopCaller).toContain("uses: ./.github/workflows/loop.yml");
    expect(loopCaller).toContain("secrets: inherit");
    expect(loopCaller).toContain("actions: read");
  });

  it("callers carry the trigger events but none of the gate logic", () => {
    expect(initCaller).toContain("pull_request:");
    expect(loopCaller).toContain("issue_comment:");
    expect(loopCaller).toContain("pull_request_review:");
    // The 51-line Codex gate must NOT be duplicated into the callers.
    expect(initCaller).not.toContain("chatgpt-codex-connector[bot]");
    expect(loopCaller).not.toContain("chatgpt-codex-connector[bot]");
    expect(loopCaller).not.toContain("LOOPPILOT_FULL_AUTO");
  });

  it("callers stay thin (~22 lines or fewer of non-comment YAML)", () => {
    const nonComment = (s: string) =>
      s.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;
    expect(nonComment(initCaller)).toBeLessThanOrEqual(22);
    expect(nonComment(loopCaller)).toBeLessThanOrEqual(24);
  });
});

describe("reusable loop forwards operator scope-policy variables to the composite (TY-350)", () => {
  // TY-350 regression guard. The reusable loop.yml never forwarded these three
  // scope inputs, so an operator who set the documented LOOPPILOT_BLOCK_PATHS /
  // LOOPPILOT_SCOPE_MAX_FILES / LOOPPILOT_SCOPE_MAX_LINES repository variables had
  // them SILENTLY ignored: GitHub `vars.*` are not auto-exported to a step's
  // process.env, so unless loop.yml passes them as action inputs they never reach
  // the composite — which DOES declare and consume them (loop/action.yml,
  // src/config.ts). The scope-max-* vars must be passed BARE (no `|| '0'`
  // fallback) because core.getInput treats "0" as set and would shadow the
  // env-var fallback (see loop/action.yml input descriptions + scope-policy.md).

  it("loop.yml maps LOOPPILOT_BLOCK_PATHS to the looppilot-block-paths composite input", () => {
    expect(loopReusable).toContain("looppilot-block-paths: ${{ vars.LOOPPILOT_BLOCK_PATHS }}");
  });

  it("loop.yml maps LOOPPILOT_SCOPE_MAX_FILES to scope-max-files (bare, no '0' default)", () => {
    expect(loopReusable).toContain("scope-max-files: ${{ vars.LOOPPILOT_SCOPE_MAX_FILES }}");
    expect(loopReusable).not.toContain("vars.LOOPPILOT_SCOPE_MAX_FILES || '0'");
  });

  it("loop.yml maps LOOPPILOT_SCOPE_MAX_LINES to scope-max-lines (bare, no '0' default)", () => {
    expect(loopReusable).toContain("scope-max-lines: ${{ vars.LOOPPILOT_SCOPE_MAX_LINES }}");
    expect(loopReusable).not.toContain("vars.LOOPPILOT_SCOPE_MAX_LINES || '0'");
  });

  it("the composite forwards each scope input to BOTH pre-fix and post-fix", () => {
    // The repair prompt's `## Scope Policy` section is built in pre-fix from
    // these values (main-pre-fix.ts buildScopePolicy), so the composite must
    // forward them to the pre-fix step too — not only post-fix, which already
    // had them. Each line therefore appears at least twice in loop/action.yml.
    for (const input of ["looppilot-block-paths", "scope-max-files", "scope-max-lines"]) {
      const needle = `${input}: \${{ inputs.${input} }}`;
      const occurrences = loopComposite.split(needle).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });

  it("the pre-fix action declares the scope inputs so core.getInput can read them", () => {
    expect(preFixAction).toContain("looppilot-block-paths:");
    expect(preFixAction).toContain("scope-max-files:");
    expect(preFixAction).toContain("scope-max-lines:");
  });

  it("documents LOOPPILOT_SCOPE_MAX_FILES / _LINES in the README configuration table", () => {
    expect(readme).toContain("`LOOPPILOT_SCOPE_MAX_FILES`");
    expect(readme).toContain("`LOOPPILOT_SCOPE_MAX_LINES`");
  });
});

describe("reusable workflows forward the Codex ACK-poll wiring to the actions (TY-334)", () => {
  // TY-334 regression guard. The in-job @codex review ACK poll (codex-ack.ts)
  // recovers a silently-dropped review request, but only if the workflows
  // forward CODEX_ACK_* and CODEX_BOT_LOGIN to the composite/init actions and
  // the composite forwards them on to pre-fix AND post-fix. Same forwarding
  // class as TY-350 — if a future refactor drops a leg, the feature silently
  // no-ops (vars.* are not auto-exported to the action process env).

  it("loop.yml forwards the three CODEX_ACK_* vars to the loop action", () => {
    expect(loopReusable).toContain("codex-ack-timeout-seconds: ${{ vars.CODEX_ACK_TIMEOUT_SECONDS || '90' }}");
    expect(loopReusable).toContain("codex-ack-poll-interval-seconds: ${{ vars.CODEX_ACK_POLL_INTERVAL_SECONDS || '15' }}");
    expect(loopReusable).toContain("codex-ack-max-reposts: ${{ vars.CODEX_ACK_MAX_REPOSTS || '2' }}");
  });

  it("init.yml forwards codex-bot-login + the CODEX_ACK_* vars and raises the job timeout for the ACK poll", () => {
    expect(initReusable).toContain("codex-bot-login: ${{ vars.CODEX_BOT_LOGIN || 'chatgpt-codex-connector[bot]' }}");
    expect(initReusable).toContain("codex-ack-timeout-seconds: ${{ vars.CODEX_ACK_TIMEOUT_SECONDS || '90' }}");
    expect(initReusable).toContain("codex-ack-max-reposts: ${{ vars.CODEX_ACK_MAX_REPOSTS || '2' }}");
    expect(initReusable).toContain("timeout-minutes: 10");
  });

  it("the composite forwards each codex-ack input to BOTH pre-fix and post-fix", () => {
    for (const input of [
      "codex-ack-timeout-seconds",
      "codex-ack-poll-interval-seconds",
      "codex-ack-max-reposts",
    ]) {
      const needle = `${input}: \${{ inputs.${input} }}`;
      const occurrences = loopComposite.split(needle).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
    // post-fix also needs codex-bot-login to recognise the Codex bot's 👀.
    expect(loopComposite.split("codex-bot-login: ${{ inputs.codex-bot-login }}").length - 1)
      .toBeGreaterThanOrEqual(2);
  });

  it("pre-fix and post-fix actions declare the codex-ack inputs", () => {
    for (const input of [
      "codex-ack-timeout-seconds",
      "codex-ack-poll-interval-seconds",
      "codex-ack-max-reposts",
    ]) {
      expect(preFixAction).toContain(`${input}:`);
    }
  });
});

describe("agent tool hardening: block the comment tools that could forge hidden state (TY-353 / PoC #156 SEC-01)", () => {
  // The agent runs as `github-actions[bot]` — the SAME identity the hidden-state
  // trust filter (TY-272 #A, buildTrustedAuthorJqFilter in src/state-manager.ts)
  // treats as the sole authoritative writer of the `looppilot-state` comment.
  // claude-code-action's `github_comment` / `github_inline_comment` base tools
  // post / update comments under that bot identity, so an IPI-influenced or
  // compromised agent could rewrite its tracking comment to begin with the
  // looppilot-state header + marker and forge the hidden state JSON; readState
  // adopts the newest trusted match (src/state-manager.ts), so the forgery would
  // win and corrupt loop accounting (iteration count / loop detection →
  // unbounded re-review cost). The loop posts every status / `@codex review`
  // comment itself from pre-/post-fix, so the agent never needs comment tools —
  // blocking them closes the forgery vector at the source without affecting the
  // repair. Regression guard for the porting gap: these two entries were missing
  // from loop-pilot's --disallowedTools (present in PoC #156, commit 94510cd).

  it("disallows the github_comment / github_inline_comment MCP tools in loop/action.yml", () => {
    // Anchor on the literal `--disallowedTools "` arg, NOT the backtick-quoted
    // `github_comment` / `github_inline_comment` mentions in the comment block
    // above it (those reference the base-tool names, not the full MCP tool IDs).
    const disallowIdx = loopComposite.indexOf('--disallowedTools "');
    expect(disallowIdx).toBeGreaterThan(0);
    const disallowLine = loopComposite.slice(
      disallowIdx,
      loopComposite.indexOf("\n", disallowIdx),
    );
    expect(disallowLine).toContain("mcp__github_comment__update_claude_comment");
    expect(disallowLine).toContain("mcp__github_inline_comment__create_inline_comment");
  });
});

describe("README documents the cross-org adopter caller", () => {
  it("references the reusable workflows by tagged path", () => {
    expect(readme).toContain("team-yubune/loop-pilot/.github/workflows/init.yml@v1");
    expect(readme).toContain("team-yubune/loop-pilot/.github/workflows/loop.yml@v1");
  });

  it("enumerates the cross-org secrets and the actions: read permission", () => {
    expect(readme).toContain("CODEX_REVIEW_REQUEST_TOKEN: ${{ secrets.CODEX_REVIEW_REQUEST_TOKEN }}");
    expect(readme).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(readme).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(readme).toContain("actions: read");
  });

  it("documents the language input for non-Node toolchains", () => {
    expect(readme).toContain("language:");
  });
});

describe("reusable loop: 2B crash-notice healthy-state gate (TY-358 / PoC #147)", () => {
  // PoC #147 regression guard. The #2B fail-safe fires on conclusion
  // failure|cancelled, but a `cancelled` that lands AFTER the loop advanced the
  // hidden state to waiting_codex/done (long Codex-ACK poll or auto-merge wait)
  // is NOT a crash. Without the gate, 2B posts "⚠️ LoopPilot crashed →
  // /restart-review --hard" on a healthy PR, misleading the operator into wiping
  // iteration history + double-posting @codex review. The gate reads the hidden
  // state on the `cancelled` path and skips the crash notice when it is healthy.

  it("gates the crash notice on a healthy hidden state for the cancelled path only", () => {
    // Restricted to `cancelled` (a genuine crash is conclusion=failure and must
    // still post); reads the newest state comment and skips when waiting_codex/done.
    expect(loopReusable).toContain('if [ "${LOOP_CONCLUSION:-}" = "cancelled" ]; then');
    expect(loopReusable).toContain("skipping the crash notification");
    expect(loopReusable).toMatch(
      /STATE_STATUS:-\}" = "waiting_codex" \] \|\| \[ "\$\{STATE_STATUS:-\}" = "done"/,
    );
  });

  it("reads state with the same trust filter / anchors as readState (rebranded), not a hardcoded bot", () => {
    // Honors the operator's trusted-author var, anchors on the LoopPilot visible
    // header + the looppilot-state marker (NOT the PoC auto-review-* strings).
    expect(loopReusable).toContain("STATE_AUTHORS: ${{ vars.LOOPPILOT_STATE_COMMENT_AUTHORS }}");
    expect(loopReusable).toContain('startswith(\\"LoopPilot state is stored in this comment.\\")');
    expect(loopReusable).toContain('contains(\\"<!-- looppilot-state\\")');
    expect(loopReusable).not.toContain("auto-review-state");
    expect(loopReusable).not.toContain("AUTO_REVIEW_STATE_COMMENT_AUTHORS");
  });
});

describe("ES-427: credential export step prevents empty ANTHROPIC_API_KEY from winning precedence", () => {
  it("has a credential export step positioned before claude-code-action", () => {
    const exportIdx = loopComposite.indexOf("Export Claude credentials");
    // Use "uses: " prefix to match the actual step, not the file-header comment.
    const claudeIdx = loopComposite.indexOf("uses: anthropics/claude-code-action@v1");
    expect(exportIdx).toBeGreaterThan(0);
    expect(claudeIdx).toBeGreaterThan(0);
    expect(exportIdx).toBeLessThan(claudeIdx);
  });

  it("conditionally writes only non-empty credentials to GITHUB_ENV", () => {
    expect(loopComposite).toContain('if [ -n "$LP_ANTHROPIC_API_KEY" ]');
    expect(loopComposite).toContain('if [ -n "$LP_CLAUDE_CODE_OAUTH_TOKEN" ]');
    expect(loopComposite).toContain("GITHUB_ENV");
  });

  it("clears credentials from GITHUB_ENV between claude-code-action and post-fix", () => {
    const claudeIdx = loopComposite.indexOf("uses: anthropics/claude-code-action@v1");
    const cleanupIdx = loopComposite.indexOf("Clear Claude credentials from GITHUB_ENV");
    const postFixIdx = loopComposite.indexOf("Post-fix (scope check");
    expect(claudeIdx).toBeGreaterThan(0);
    expect(cleanupIdx).toBeGreaterThan(0);
    expect(postFixIdx).toBeGreaterThan(0);
    // Cleanup must sit between claude-code-action and post-fix so
    // post-fix child processes never inherit the credential.
    expect(cleanupIdx).toBeGreaterThan(claudeIdx);
    expect(cleanupIdx).toBeLessThan(postFixIdx);

    const cleanupBlock = loopComposite.slice(cleanupIdx, cleanupIdx + 300);
    expect(cleanupBlock).toContain("always()");
    expect(cleanupBlock).toContain('ANTHROPIC_API_KEY=');
    expect(cleanupBlock).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  });

  it("does NOT pass anthropic_api_key or claude_code_oauth_token through the claude-code-action with: block", () => {
    // Use "uses: " prefix to match the actual step, not the file-header comment.
    const claudeStepStart = loopComposite.indexOf("uses: anthropics/claude-code-action@v1");
    expect(claudeStepStart).toBeGreaterThan(0);
    // Slice until the next step (Post-fix) to avoid a fragile fixed-length window.
    const postFixStart = loopComposite.indexOf("Post-fix", claudeStepStart);
    expect(postFixStart).toBeGreaterThan(claudeStepStart);
    const claudeStepBlock = loopComposite.slice(claudeStepStart, postFixStart);

    expect(claudeStepBlock).not.toContain("anthropic_api_key:");
    expect(claudeStepBlock).not.toContain("claude_code_oauth_token:");
  });
});

describe("ES-428: show-full-output input wiring (loop.yml → composite → claude-code-action)", () => {
  // ES-428: OAuth token failures produced opaque errors because
  // claude-code-action's show_full_output defaults to false, hiding
  // the detailed error output. LoopPilot defaults it to true so
  // operators see the full log unless they explicitly opt out.

  it("loop.yml declares a show-full-output workflow_call input defaulting to 'true'", () => {
    expect(loopReusable).toContain("show-full-output:");
    expect(loopReusable).toContain('default: "true"');
  });

  it("loop.yml forwards show-full-output to the composite action via vars with input fallback", () => {
    expect(loopReusable).toContain("show-full-output: ${{ vars.LOOPPILOT_SHOW_FULL_OUTPUT || inputs.show-full-output || 'true' }}");
  });

  it("loop/action.yml declares a show-full-output input", () => {
    expect(loopComposite).toContain("show-full-output:");
  });

  it("loop/action.yml passes show_full_output to claude-code-action@v1 (underscore convention)", () => {
    // claude-code-action uses underscores; LoopPilot uses hyphens.
    const claudeStepStart = loopComposite.indexOf("uses: anthropics/claude-code-action@v1");
    expect(claudeStepStart).toBeGreaterThan(0);
    const postFixStart = loopComposite.indexOf("Post-fix", claudeStepStart);
    expect(postFixStart).toBeGreaterThan(claudeStepStart);
    const claudeStepBlock = loopComposite.slice(claudeStepStart, postFixStart);

    expect(claudeStepBlock).toContain("show_full_output: ${{ inputs.show-full-output }}");
  });

  it("README.md documents LOOPPILOT_SHOW_FULL_OUTPUT in the configuration table", () => {
    expect(readme).toContain("`LOOPPILOT_SHOW_FULL_OUTPUT`");
  });

  it("README.ja.md documents LOOPPILOT_SHOW_FULL_OUTPUT in the configuration table", () => {
    expect(readmeJa).toContain("`LOOPPILOT_SHOW_FULL_OUTPUT`");
  });
});
