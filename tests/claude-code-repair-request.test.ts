import { describe, expect, it } from "vitest";
import {
  PREVIOUS_CHECK_FAILURE_MAX_CHARS,
  buildClaudeCodeRepairPrompt,
  buildClaudeCodeRepairRequest,
  serializeClaudeCodeRepairRequest,
  truncatePreviousCheckFailure,
  type ClaudeCodeRepairRequest,
} from "../src/claude-code-repair-request.js";
import type { Finding, PrContext } from "../src/types.js";

const prContext: PrContext = {
  number: 128,
  title: "fix session expiry bug",
  branch: "fix/session-expiry",
};

const findings: Finding[] = [
  {
    severity: "P1",
    path: "src/auth/middleware.ts",
    line: 42,
    title: "Unauthenticated requests reach protected handler",
    body: "Under the else branch, requests without a valid session reach the handler.",
  },
  {
    severity: "P0",
    path: "src/auth/session.ts",
    line: 84,
    title: "Token refresh path can bypass expiry validation",
    body: "The token refresh logic skips the expiry check when the cookie is rotated.",
  },
  {
    severity: "P2",
    path: "src/auth/logger.ts",
    line: 17,
    title: "Debug log leaks request id format",
    body: "Logger prefixes request ids with an internal marker that should not be exposed.",
  },
];

function buildBaseRequest(
  overrides: Partial<Parameters<typeof buildClaudeCodeRepairRequest>[0]> = {}
): ClaudeCodeRepairRequest {
  return buildClaudeCodeRepairRequest({
    prContext,
    findings,
    iteration: 4,
    maxIterations: 20,
    checkCommand: "npm run check",
    ...overrides,
  });
}

describe("buildClaudeCodeRepairRequest", () => {
  it("includes P0/P1/P2 findings as entry points with PR and execution metadata", () => {
    const request = buildBaseRequest({ headSha: "abc123" });

    expect(request.version).toBe(1);
    expect(request.pr).toEqual({
      number: 128,
      title: "fix session expiry bug",
      branch: "fix/session-expiry",
      headSha: "abc123",
    });
    expect(request.execution).toEqual({
      iteration: 4,
      maxIterations: 20,
      checkCommand: "npm run check",
      previousCheckFailure: null,
    });

    expect(request.findings).toHaveLength(3);
    for (const f of request.findings) {
      expect(f.entryPointOnly).toBe(true);
    }

    const severities = request.findings.map((f) => f.severity);
    expect(severities).toEqual(["P0", "P1", "P2"]);
  });

  it("defaults headSha to null when not supplied", () => {
    const request = buildBaseRequest();
    expect(request.pr.headSha).toBeNull();
  });

  it("produces a deterministic payload regardless of finding input order", () => {
    const requestA = buildBaseRequest({ headSha: "deadbeef" });

    const reversedFindings = [...findings].reverse();
    const requestB = buildClaudeCodeRepairRequest({
      prContext,
      findings: reversedFindings,
      iteration: 4,
      maxIterations: 20,
      checkCommand: "npm run check",
      headSha: "deadbeef",
    });

    expect(serializeClaudeCodeRepairRequest(requestA)).toBe(
      serializeClaudeCodeRepairRequest(requestB)
    );
  });

  it("preserves the original path and line as entry points", () => {
    const request = buildBaseRequest();
    const session = request.findings.find(
      (f) => f.path === "src/auth/session.ts"
    );
    expect(session).toBeDefined();
    expect(session?.line).toBe(84);
    expect(session?.severity).toBe("P0");
  });

  it("truncates a long previousCheckFailure to the configured cap", () => {
    const huge = "x".repeat(PREVIOUS_CHECK_FAILURE_MAX_CHARS * 2);
    const request = buildBaseRequest({ previousCheckFailure: huge });

    expect(request.execution.previousCheckFailure).not.toBeNull();
    expect(request.execution.previousCheckFailure!.length).toBeLessThanOrEqual(
      PREVIOUS_CHECK_FAILURE_MAX_CHARS
    );
    expect(request.execution.previousCheckFailure).toContain(
      "truncated"
    );
  });

  it("keeps a short previousCheckFailure verbatim", () => {
    const short = "FAIL: tests/foo.test.ts > bar\n  expected 1 got 2";
    const request = buildBaseRequest({ previousCheckFailure: short });
    expect(request.execution.previousCheckFailure).toBe(short);
  });
});

describe("buildClaudeCodeRepairPrompt", () => {
  it("contains every required behavioral constraint", () => {
    const prompt = buildClaudeCodeRepairPrompt(buildBaseRequest());

    // path/line as investigation entry point + related-file exploration
    expect(prompt).toContain("investigation entry point");
    expect(prompt).toMatch(/related files/i);
    expect(prompt).toMatch(/callers/i);

    // existing tests are the specification
    expect(prompt).toMatch(/existing tests as the specification/i);

    // minimal change, no unrelated refactors
    expect(prompt).toMatch(/minimal change/i);
    expect(prompt).toMatch(/unrelated refactors/i);

    // no arbitrary shell
    expect(prompt).toMatch(/arbitrary shell/i);

    // no secrets
    expect(prompt).toMatch(/secrets/i);

    // no network access assumption
    expect(prompt).toMatch(/network access/i);

    // workflow runs final CHECK_COMMAND
    expect(prompt).toContain("CHECK_COMMAND");
    expect(prompt).toMatch(/workflow will run the final CHECK_COMMAND/i);
  });

  it("embeds the CHECK_COMMAND value and PR metadata", () => {
    const prompt = buildClaudeCodeRepairPrompt(
      buildBaseRequest({ checkCommand: "pnpm verify" })
    );
    expect(prompt).toContain("`pnpm verify`");
    expect(prompt).toContain("PR #128: fix session expiry bug");
    expect(prompt).toContain("Branch: fix/session-expiry");
    expect(prompt).toContain("Iteration: 4 / 20");
  });

  it("includes a previous-failure section only when failure output is provided", () => {
    const without = buildClaudeCodeRepairPrompt(buildBaseRequest());
    expect(without).not.toContain("Previous CHECK_COMMAND Failure");

    const withFailure = buildClaudeCodeRepairPrompt(
      buildBaseRequest({
        previousCheckFailure: "ReferenceError: foo is not defined",
      })
    );
    expect(withFailure).toContain("Previous CHECK_COMMAND Failure");
    expect(withFailure).toContain("ReferenceError: foo is not defined");
  });

  it("renders each finding as a numbered entry-point block", () => {
    const prompt = buildClaudeCodeRepairPrompt(buildBaseRequest());
    expect(prompt).toContain("Finding 1 — P0");
    expect(prompt).toContain("Finding 2 — P1");
    expect(prompt).toContain("Finding 3 — P2");
    expect(prompt).toContain("src/auth/session.ts:84");
    expect(prompt).toContain("(investigation start, not fix scope)");
  });
});

describe("serializeClaudeCodeRepairRequest", () => {
  it("round-trips through JSON.parse without loss", () => {
    const request = buildBaseRequest({
      headSha: "0123456789abcdef0123456789abcdef01234567",
      previousCheckFailure: "build failed: cannot find module 'foo'",
    });

    const parsed = JSON.parse(
      serializeClaudeCodeRepairRequest(request)
    ) as ClaudeCodeRepairRequest;

    expect(parsed).toEqual(request);
  });

  it("emits the top-level keys in a stable order", () => {
    const serialized = serializeClaudeCodeRepairRequest(buildBaseRequest());
    const expectedOrder = [
      "version",
      "pr",
      "execution",
      "findings",
      "instructions",
    ];
    const positions = expectedOrder.map((key) =>
      serialized.indexOf(`"${key}"`)
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("produces byte-identical output for two builds with the same input", () => {
    const a = serializeClaudeCodeRepairRequest(
      buildBaseRequest({ headSha: "abc" })
    );
    const b = serializeClaudeCodeRepairRequest(
      buildBaseRequest({ headSha: "abc" })
    );
    expect(a).toBe(b);
  });
});

describe("truncatePreviousCheckFailure", () => {
  it("returns the input unchanged when within the budget", () => {
    const s = "short output";
    expect(truncatePreviousCheckFailure(s, 100)).toBe(s);
  });

  it("preserves the tail and prefixes a truncation marker when truncating", () => {
    const body = "X".repeat(1000) + "TAIL-MARKER";
    const truncated = truncatePreviousCheckFailure(body, 500);
    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(truncated).toContain("TAIL-MARKER");
    expect(truncated.startsWith("[... truncated")).toBe(true);
  });

  it("never exceeds the configured budget even when the omitted count is large", () => {
    const body = "y".repeat(1_000_000);
    const truncated = truncatePreviousCheckFailure(body, 1024);
    expect(truncated.length).toBeLessThanOrEqual(1024);
  });

  it("falls back to a verbatim tail when the budget is too small for the marker", () => {
    const body = "abcdefghijklmnopqrstuvwxyz".repeat(10);
    const truncated = truncatePreviousCheckFailure(body, 20);
    expect(truncated.length).toBe(20);
    expect(truncated).toBe(body.slice(body.length - 20));
  });
});
