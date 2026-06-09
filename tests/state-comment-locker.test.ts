import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLockedStateUpdater,
  type LockedStateUpdaterArgs,
} from "../src/state-comment-locker.js";
import {
  StateUpdateConflictError,
  createInitialState,
} from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

function makeArgs(
  overrides: Partial<LockedStateUpdaterArgs> = {},
): LockedStateUpdaterArgs {
  return {
    owner: "Edership",
    repo: "loop-pilot",
    commentId: 555,
    token: "github-token",
    initialExpectedUpdatedAt: "2026-05-15T00:00:00.000Z",
    label: "pre-fix",
    updateStateComment: vi
      .fn()
      .mockResolvedValue({ updatedAt: "2026-05-15T00:00:01.000Z" }),
    warning: vi.fn(),
    onConflict: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFixingState(): ReviewState {
  return { ...createInitialState(), status: "fixing" };
}

describe("createLockedStateUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards owner/repo/commentId/token to updateStateComment with initial expectedUpdatedAt", async () => {
    const args = makeArgs();
    const tryUpdate = createLockedStateUpdater(args);
    const next = makeFixingState();

    const ok = await tryUpdate(next, "detail");

    expect(ok).toBe(true);
    expect(args.updateStateComment).toHaveBeenCalledTimes(1);
    expect(args.updateStateComment).toHaveBeenCalledWith(
      "Edership",
      "loop-pilot",
      555,
      next,
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:00.000Z" },
    );
    expect(args.warning).not.toHaveBeenCalled();
    expect(args.onConflict).not.toHaveBeenCalled();
  });

  it("threads the returned updatedAt into the next call's expectedUpdatedAt", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ updatedAt: "2026-05-15T00:00:01.000Z" })
      .mockResolvedValueOnce({ updatedAt: "2026-05-15T00:00:02.000Z" });
    const args = makeArgs({ updateStateComment: update });
    const tryUpdate = createLockedStateUpdater(args);

    await tryUpdate(makeFixingState(), "first");
    await tryUpdate(makeFixingState(), "second");

    expect(update.mock.calls[1][5]).toEqual({
      expectedUpdatedAt: "2026-05-15T00:00:01.000Z",
    });
  });

  it("omits the expectedUpdatedAt option when no initial value is given", async () => {
    const args = makeArgs({ initialExpectedUpdatedAt: undefined });
    const tryUpdate = createLockedStateUpdater(args);

    await tryUpdate(makeFixingState(), "first");

    expect(args.updateStateComment).toHaveBeenCalledWith(
      "Edership",
      "loop-pilot",
      555,
      expect.any(Object),
      "github-token",
      undefined,
    );
  });

  it("warns with the configured label and invokes onConflict on StateUpdateConflictError", async () => {
    const conflict = new StateUpdateConflictError(
      "Hidden comment updated_at changed before PATCH",
    );
    const args = makeArgs({
      updateStateComment: vi.fn().mockRejectedValue(conflict),
      label: "post-fix",
    });
    const tryUpdate = createLockedStateUpdater(args);

    const ok = await tryUpdate(makeFixingState(), "could not persist");

    expect(ok).toBe(false);
    expect(args.warning).toHaveBeenCalledWith(
      `[post-fix] Hidden comment state conflict. ${conflict.message}`,
    );
    expect(args.onConflict).toHaveBeenCalledWith("could not persist");
  });

  it("re-throws non-conflict errors and skips onConflict", async () => {
    const args = makeArgs({
      updateStateComment: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const tryUpdate = createLockedStateUpdater(args);

    await expect(tryUpdate(makeFixingState(), "detail")).rejects.toThrow(
      "boom",
    );
    expect(args.onConflict).not.toHaveBeenCalled();
    expect(args.warning).not.toHaveBeenCalled();
  });

  it("TY-286: per-call onConflict override takes precedence over the default handler", async () => {
    const defaultOnConflict = vi.fn().mockResolvedValue(undefined);
    const overrideOnConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = new StateUpdateConflictError("412 Precondition Failed");
    const args = makeArgs({
      updateStateComment: vi.fn().mockRejectedValue(conflict),
      onConflict: defaultOnConflict,
    });
    const tryUpdate = createLockedStateUpdater(args);

    const ok = await tryUpdate(makeFixingState(), "follow-up write detail", {
      onConflict: overrideOnConflict,
    });

    expect(ok).toBe(false);
    // The override fires instead of the default — callers can opt out of the
    // terminal "post a 🛑 stop comment" behaviour for non-terminal 2nd writes.
    expect(overrideOnConflict).toHaveBeenCalledWith("follow-up write detail");
    expect(defaultOnConflict).not.toHaveBeenCalled();
    // Warning is still emitted so the conflict is observable in operator logs.
    expect(args.warning).toHaveBeenCalledWith(
      `[pre-fix] Hidden comment state conflict. ${conflict.message}`,
    );
  });

  it("TY-286: falls back to the default onConflict when the call omits options.onConflict", async () => {
    const defaultOnConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = new StateUpdateConflictError("412 Precondition Failed");
    const args = makeArgs({
      updateStateComment: vi.fn().mockRejectedValue(conflict),
      onConflict: defaultOnConflict,
    });
    const tryUpdate = createLockedStateUpdater(args);

    await tryUpdate(makeFixingState(), "terminal write detail");

    expect(defaultOnConflict).toHaveBeenCalledWith("terminal write detail");
  });

  it("does not advance expectedUpdatedAt after a conflict so the next attempt re-uses the previous value", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new StateUpdateConflictError("conflict"))
      .mockResolvedValueOnce({ updatedAt: "2026-05-15T00:00:02.000Z" });
    const args = makeArgs({ updateStateComment: update });
    const tryUpdate = createLockedStateUpdater(args);

    await tryUpdate(makeFixingState(), "first");
    await tryUpdate(makeFixingState(), "second");

    expect(update.mock.calls[0][5]).toEqual({
      expectedUpdatedAt: "2026-05-15T00:00:00.000Z",
    });
    expect(update.mock.calls[1][5]).toEqual({
      expectedUpdatedAt: "2026-05-15T00:00:00.000Z",
    });
  });
});
