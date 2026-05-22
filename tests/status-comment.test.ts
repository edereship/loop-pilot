import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStatusUpdate,
  createInitialStatusSnapshot,
  findStatusComment,
  parseStatusCommentBody,
  renderStatusCommentBody,
  upsertStatusComment,
  type StatusEntry,
  type StatusSnapshot,
  type UpsertStatusCommentDeps,
} from "../src/status-comment.js";
import { ghApi } from "../src/gh.js";

vi.mock("../src/gh.js", () => ({
  ghApi: vi.fn(),
}));

const mockedGhApi = vi.mocked(ghApi);

function entry(overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    timestamp: "2026-05-16T01:00:00Z",
    kind: "auto_fix_applied",
    title: "Iteration 1 — Auto-fix applied",
    body: "- `src/foo.ts`",
    ...overrides,
  };
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    current: "Fixing — iteration 1 applied",
    lastCommit: "abc1234",
    openFindings: 0,
    nextAction: "Awaiting next Codex review.",
    iterationCount: null,
    maxIterations: null,
    lastModelTier: null,
    entries: [entry()],
    ...overrides,
  };
}

describe("renderStatusCommentBody / parseStatusCommentBody round-trip", () => {
  it("renders the visible header and embeds the JSON data block", () => {
    const body = renderStatusCommentBody(snapshot());
    expect(body).toContain("<!-- auto-review-status -->");
    expect(body).toContain("## Auto-review status");
    expect(body).toContain("**Current**: Fixing — iteration 1 applied");
    expect(body).toContain("**Last commit**: abc1234");
    expect(body).toContain("**Open findings**: 0");
    expect(body).toContain("**Next action**: Awaiting next Codex review.");
    expect(body).toContain("<details>");
    expect(body).toContain("History (1 entry)");
    expect(body).toContain("Iteration 1 — Auto-fix applied");
    expect(body).toContain("<!-- auto-review-status-data");
  });

  it("renders dashes for null lastCommit and openFindings", () => {
    const body = renderStatusCommentBody(
      snapshot({ lastCommit: null, openFindings: null }),
    );
    expect(body).toContain("**Last commit**: —");
    expect(body).toContain("**Open findings**: —");
  });

  it("renders 'no entries yet' when entries is empty", () => {
    const body = renderStatusCommentBody(snapshot({ entries: [] }));
    expect(body).toContain("_(no entries yet)_");
    expect(body).toContain("History (0 entries)");
  });

  it("renders Last model tier as '—' when iteration fields are set but lastModelTier is null (Finding 3)", () => {
    const body = renderStatusCommentBody(
      snapshot({ iterationCount: 0, maxIterations: 20, lastModelTier: null }),
    );
    expect(body).toContain("**Iterations**: 0 / 20");
    expect(body).toContain("**Last model tier**: —");
  });

  it("omits Last model tier row for legacy snapshots with no iteration fields and null tier", () => {
    const body = renderStatusCommentBody(
      snapshot({ iterationCount: null, maxIterations: null, lastModelTier: null }),
    );
    expect(body).not.toContain("**Iterations**");
    expect(body).not.toContain("**Last model tier**");
  });

  it("renders Last model tier when iteration fields are set and tier is non-null", () => {
    const body = renderStatusCommentBody(
      snapshot({ iterationCount: 1, maxIterations: 20, lastModelTier: "escalated" }),
    );
    expect(body).toContain("**Iterations**: 1 / 20");
    expect(body).toContain("**Last model tier**: escalated");
  });

  it("parses the data JSON block back to the same snapshot", () => {
    const original = snapshot({
      entries: [
        entry({ title: "B", timestamp: "2026-05-16T01:00:00Z" }),
        entry({ title: "A", timestamp: "2026-05-15T00:00:00Z" }),
      ],
    });
    const body = renderStatusCommentBody(original);
    const parsed = parseStatusCommentBody(body);
    expect(parsed).toEqual(original);
  });

  it("round-trips correctly when entry body contains -->", () => {
    const original = snapshot({
      entries: [entry({ body: "output: <!-- foo --> end" })],
    });
    const body = renderStatusCommentBody(original);
    // The raw comment body must not contain --> inside the data block (it
    // would close the HTML comment prematurely).
    const dataStart = body.indexOf("<!-- auto-review-status-data");
    const closingIdx = body.indexOf("-->", dataStart + 1);
    // Confirm the --> that closes the block is the real delimiter, not an
    // escaped one embedded in the JSON.
    expect(body.slice(dataStart, closingIdx)).not.toContain("-->");
    const parsed = parseStatusCommentBody(body);
    expect(parsed).toEqual(original);
  });

  it("parses correctly when an entry body contains the data marker string", () => {
    // If indexOf were used, parsing would begin inside the visible history
    // section and produce garbage JSON instead of the hidden data block.
    const original = snapshot({
      entries: [
        entry({ body: "output contained <!-- auto-review-status-data verbatim" }),
      ],
    });
    const body = renderStatusCommentBody(original);
    const parsed = parseStatusCommentBody(body);
    expect(parsed).toEqual(original);
  });

  it("parses correctly when an entry body contains </details>", () => {
    // An entry body with </details> causes that literal to appear inside the
    // serialised JSON payload.  Using lastIndexOf("</details>") as a search
    // anchor then points into the data block, so indexOf(DATA_OPEN) fails and
    // parseStatusCommentBody incorrectly returns null.
    const original = snapshot({
      entries: [
        entry({ body: "cmd output:\n</details>\nsome more text" }),
      ],
    });
    const body = renderStatusCommentBody(original);
    const parsed = parseStatusCommentBody(body);
    expect(parsed).toEqual(original);
  });

  it("returns null when the body has no data marker", () => {
    expect(parseStatusCommentBody("some unrelated comment")).toBeNull();
  });

  it("returns null when the data block is malformed JSON", () => {
    const body = `<!-- auto-review-status -->\n<!-- auto-review-status-data\nnot json\n-->`;
    expect(parseStatusCommentBody(body)).toBeNull();
  });

  it("returns null when the JSON shape is wrong", () => {
    const body = `<!-- auto-review-status -->\n<!-- auto-review-status-data\n${JSON.stringify(
      { current: 1, lastCommit: null, openFindings: null, nextAction: "x", entries: [] },
    )}\n-->`;
    expect(parseStatusCommentBody(body)).toBeNull();
  });

  it("rejects entries with unknown kind", () => {
    const bad = {
      current: "a",
      lastCommit: null,
      openFindings: null,
      nextAction: "b",
      entries: [
        { timestamp: "t", title: "T", body: "B", kind: "evil_kind" },
      ],
    };
    const body = `<!-- auto-review-status -->\n<!-- auto-review-status-data\n${JSON.stringify(bad)}\n-->`;
    expect(parseStatusCommentBody(body)).toBeNull();
  });
});

describe("applyStatusUpdate", () => {
  it("merges header fields, preserving fields not specified in the update", () => {
    const next = applyStatusUpdate(snapshot(), {
      current: "Stopped — boom",
    });
    expect(next.current).toBe("Stopped — boom");
    expect(next.lastCommit).toBe("abc1234");
    expect(next.openFindings).toBe(0);
    expect(next.nextAction).toBe("Awaiting next Codex review.");
  });

  it("prepends newEntry to keep newest-first order", () => {
    const base = snapshot({ entries: [entry({ title: "old" })] });
    const next = applyStatusUpdate(base, {
      newEntry: entry({ title: "new" }),
    });
    expect(next.entries.map((e) => e.title)).toEqual(["new", "old"]);
  });

  it("treats undefined fields as 'preserve' and null lastCommit as explicit clear", () => {
    const base = snapshot();
    const cleared = applyStatusUpdate(base, { lastCommit: null });
    expect(cleared.lastCommit).toBeNull();
    const preserved = applyStatusUpdate(base, {});
    expect(preserved.lastCommit).toBe("abc1234");
  });

  it("caps history at 30 entries", () => {
    const many: StatusEntry[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(entry({ title: `entry-${i}` }));
    }
    const base = snapshot({ entries: many });
    const next = applyStatusUpdate(base, {
      newEntry: entry({ title: "new" }),
    });
    expect(next.entries.length).toBe(30);
    expect(next.entries[0].title).toBe("new");
    // The oldest entry should have been dropped.
    expect(next.entries.map((e) => e.title)).not.toContain("entry-29");
  });

  it("truncates entry body that exceeds MAX_ENTRY_BODY_LENGTH", () => {
    const largeBody = "x".repeat(70_000);
    const next = applyStatusUpdate(createInitialStatusSnapshot(), {
      newEntry: entry({ body: largeBody }),
    });
    expect(next.entries[0].body.length).toBeLessThan(70_000);
    expect(next.entries[0].body).toContain("_(output truncated");
  });

  it("keeps entry body intact when it is within MAX_ENTRY_BODY_LENGTH", () => {
    const smallBody = "x".repeat(100);
    const next = applyStatusUpdate(createInitialStatusSnapshot(), {
      newEntry: entry({ body: smallBody }),
    });
    expect(next.entries[0].body).toBe(smallBody);
  });

  it("rendered comment body stays within GitHub limit when entry has 60k-char output", () => {
    const largeOutput = "x".repeat(60_000);
    const next = applyStatusUpdate(createInitialStatusSnapshot(), {
      newEntry: entry({ kind: "test_failure", body: largeOutput }),
    });
    const body = renderStatusCommentBody(next);
    // GitHub's issue-comment body limit is 65 536 bytes.
    expect(body.length).toBeLessThanOrEqual(65_536);
  });

  it("rendered comment body stays within GitHub limit even with many large entries", () => {
    // Each entry body appears twice in the rendered comment (visible history +
    // hidden JSON).  Without total-size enforcement, 10 entries × 16 000 chars
    // × 2 ≈ 320 000 chars — far beyond GitHub's 65 536-character limit.
    let snap = createInitialStatusSnapshot();
    for (let i = 0; i < 10; i++) {
      snap = applyStatusUpdate(snap, {
        newEntry: entry({ kind: "test_failure", body: "x".repeat(16_000) }),
      });
    }
    const body = renderStatusCommentBody(snap);
    expect(body.length).toBeLessThanOrEqual(65_536);
  });
});

describe("upsertStatusComment", () => {
  let deps: UpsertStatusCommentDeps;
  let findSpy: ReturnType<typeof vi.fn>;
  let createSpy: ReturnType<typeof vi.fn>;
  let updateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findSpy = vi.fn();
    createSpy = vi.fn();
    updateSpy = vi.fn();
    deps = {
      findStatusComment: findSpy as unknown as UpsertStatusCommentDeps["findStatusComment"],
      createStatusComment: createSpy as unknown as UpsertStatusCommentDeps["createStatusComment"],
      updateStatusComment: updateSpy as unknown as UpsertStatusCommentDeps["updateStatusComment"],
    };
  });

  it("creates a new status comment when none exists", async () => {
    findSpy.mockResolvedValue(null);
    createSpy.mockResolvedValue(999);
    const id = await upsertStatusComment(
      "o",
      "r",
      42,
      {
        current: "Fixing — iteration 1 applied",
        nextAction: "Awaiting next Codex review.",
        newEntry: entry({ title: "Iteration 1 — Auto-fix applied" }),
      },
      "tok",
      deps,
    );
    expect(id).toBe(999);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    const [owner, name, pr, body] = createSpy.mock.calls[0];
    expect(owner).toBe("o");
    expect(name).toBe("r");
    expect(pr).toBe(42);
    expect(body).toContain("<!-- auto-review-status -->");
    expect(body).toContain("Iteration 1 — Auto-fix applied");
  });

  it("updates the existing comment and merges the previous snapshot", async () => {
    const previous = snapshot({
      current: "Fixing — iteration 1 applied",
      entries: [entry({ title: "old" })],
    });
    findSpy.mockResolvedValue({ id: 555, body: renderStatusCommentBody(previous) });
    updateSpy.mockResolvedValue(undefined);

    const id = await upsertStatusComment(
      "o",
      "r",
      42,
      {
        current: "Stopped — test_failure",
        nextAction: "Manual intervention required.",
        newEntry: entry({ title: "Auto-fix stopped: CHECK_COMMAND failed" }),
      },
      "tok",
      deps,
    );

    expect(id).toBe(555);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [, , commentId, body] = updateSpy.mock.calls[0];
    expect(commentId).toBe(555);
    expect(body).toContain("**Current**: Stopped — test_failure");
    expect(body).toContain("Auto-fix stopped: CHECK_COMMAND failed");
    expect(body).toContain("History (2 entries)");
    // The previous lastCommit is preserved when not specified.
    expect(body).toContain("**Last commit**: abc1234");
    // Order: newest first.
    const newIdx = body.indexOf("Auto-fix stopped: CHECK_COMMAND failed");
    const oldIdx = body.indexOf("### old");
    expect(newIdx).toBeGreaterThan(0);
    expect(oldIdx).toBeGreaterThan(newIdx);
  });

  it("recovers gracefully if the existing comment body is corrupted", async () => {
    findSpy.mockResolvedValue({ id: 555, body: "<!-- auto-review-status -->\nNo data block" });
    updateSpy.mockResolvedValue(undefined);

    const id = await upsertStatusComment(
      "o",
      "r",
      42,
      {
        current: "Fixing — iteration 1 applied",
        newEntry: entry({ title: "Iteration 1 — Auto-fix applied" }),
      },
      "tok",
      deps,
    );

    expect(id).toBe(555);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const body = updateSpy.mock.calls[0][3];
    expect(body).toContain("Iteration 1 — Auto-fix applied");
    expect(body).toContain("History (1 entry)");
  });
});

describe("findStatusComment", () => {
  beforeEach(() => {
    mockedGhApi.mockReset();
  });

  it("returns null when gh output is empty", async () => {
    mockedGhApi.mockResolvedValueOnce("");
    const result = await findStatusComment("owner", "repo", 1, "token");
    expect(result).toBeNull();
  });

  it("parses a plain JSON object line (raw object, not @json-encoded)", async () => {
    const record = { id: 42, body: "<!-- auto-review-status -->\nhello" };
    mockedGhApi.mockResolvedValueOnce(JSON.stringify(record));
    const result = await findStatusComment("owner", "repo", 1, "token");
    expect(result).toEqual(record);
  });

  it("decodes @json-encoded output where each line is a JSON-encoded string", async () => {
    // `@json` in jq wraps each object as a JSON string literal.
    // JSON.parse on such a line returns a string, not an object.
    const record = { id: 42, body: "<!-- auto-review-status -->\nhello" };
    const atJsonLine = JSON.stringify(JSON.stringify(record));
    mockedGhApi.mockResolvedValueOnce(atJsonLine);
    const result = await findStatusComment("owner", "repo", 1, "token");
    expect(result).toEqual(record);
  });

  it("returns the last (newest) record when multiple @json-encoded lines are present", async () => {
    const first = { id: 1, body: "<!-- auto-review-status -->\nfirst" };
    const last = { id: 2, body: "<!-- auto-review-status -->\nlast" };
    const output = [
      JSON.stringify(JSON.stringify(first)),
      JSON.stringify(JSON.stringify(last)),
    ].join("\n");
    mockedGhApi.mockResolvedValueOnce(output);
    const result = await findStatusComment("owner", "repo", 1, "token");
    expect(result).toEqual(last);
  });

  it("skips lines that are not valid JSON and continues to the next", async () => {
    const valid = { id: 7, body: "<!-- auto-review-status -->\nok" };
    const output = ["not-json", JSON.stringify(JSON.stringify(valid))].join(
      "\n",
    );
    mockedGhApi.mockResolvedValueOnce(output);
    const result = await findStatusComment("owner", "repo", 1, "token");
    expect(result).toEqual(valid);
  });
});

describe("createInitialStatusSnapshot", () => {
  it("yields an empty snapshot with placeholder values", () => {
    const s = createInitialStatusSnapshot();
    expect(s.entries).toEqual([]);
    expect(s.lastCommit).toBeNull();
    expect(s.openFindings).toBeNull();
    expect(s.current).toBe("—");
    expect(s.nextAction).toBe("—");
  });
});

describe("status-comment delimiter robustness (TY-269 #14)", () => {
  it("survives entry bodies that contain the legacy escape sequence `--\\>`", () => {
    // Before TY-269 the parser blindly converted `--\>` back to `-->`. If an
    // entry body genuinely contained `--\>` (e.g., a stack trace or log line),
    // the round-trip would corrupt it. Base64 encoding eliminates the
    // ambiguity entirely.
    const original = snapshot({
      entries: [entry({ body: "noise --\\> more noise --\\>" })],
    });
    const body = renderStatusCommentBody(original);
    const parsed = parseStatusCommentBody(body);
    expect(parsed).toEqual(original);
  });

  it("base64-encoded payload contains neither `-->` nor the data-block marker", () => {
    const original = snapshot({
      entries: [
        entry({
          body: "raw output with --> and <!-- auto-review-status-data inline",
        }),
      ],
    });
    const body = renderStatusCommentBody(original);
    // Slice out the data block content (between the open marker and the
    // closing `-->`) to verify the encoded payload is collision-free.
    const dataStart =
      body.indexOf("<!-- auto-review-status-data") +
      "<!-- auto-review-status-data".length;
    const dataEnd = body.indexOf("-->", dataStart);
    const dataBlock = body.slice(dataStart, dataEnd);
    expect(dataBlock).not.toContain("-->");
    // The base64 payload starts with `b64:` followed by [A-Za-z0-9+/=] — no
    // hyphens or angle brackets, so neither delimiter can ever appear inside
    // the payload itself, regardless of the entry contents.
    expect(dataBlock).toMatch(/b64:[A-Za-z0-9+/=]+/);
  });

  it("still parses legacy `--\\>` format for backward compatibility", () => {
    // Comments authored before this rollout used the inline `--\>` escape.
    // Verify the parser can still load them so in-flight PRs keep their
    // history across the rollout commit.
    const original = snapshot({
      entries: [entry({ body: "legacy payload" })],
    });
    const json = JSON.stringify(original).replace(/-->/g, "--\\>");
    const legacyBody = [
      "<!-- auto-review-status -->",
      "## Auto-review status",
      "",
      "<!-- auto-review-status-data",
      json,
      "-->",
      "",
    ].join("\n");
    const parsed = parseStatusCommentBody(legacyBody);
    expect(parsed).toEqual(original);
  });

  it("returns null on a body whose payload is neither base64 nor valid JSON", () => {
    const corruptBody = [
      "<!-- auto-review-status -->",
      "<!-- auto-review-status-data",
      "{not valid json and not base64",
      "-->",
    ].join("\n");
    expect(parseStatusCommentBody(corruptBody)).toBeNull();
  });
});
