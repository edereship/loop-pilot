import * as core from "@actions/core";

/**
 * Schedules `fn()` unless running under Vitest. Mirrors the
 * `if (process.env.VITEST !== "true") { run().catch(...) }` boilerplate that
 * each main entry would otherwise repeat.
 *
 * On rejection it always calls `core.setFailed` first so the GitHub Actions
 * step is marked failed even when `onError` itself throws.
 */
export function runIfNotVitest(
  fn: () => Promise<void>,
  onError?: (error: unknown) => Promise<void>,
): void {
  if (process.env.VITEST === "true") {
    return;
  }
  fn().catch(async (error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
    if (onError) {
      await onError(error);
    }
  });
}
