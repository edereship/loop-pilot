/**
 * Verify that every reference to a `team-yubune/loop-pilot/*` action inside a
 * workflow / composite-action YAML pins the SAME major as the release tag.
 *
 * TY-342: each release re-points the moving `v1` tag, so the composite action's
 * hardcoded sub-action refs (`loop/action.yml:176,260`) must match the major
 * being released. A drift here ships an action that loads a sibling sub-action
 * from a different (possibly nonexistent) tag, silently breaking adopters.
 */
const OWNER = "team-yubune/loop-pilot";
// Matches `uses: team-yubune/loop-pilot[/subpath]@<ref>` (quotes optional).
const USES_RE = new RegExp(
  String.raw`uses:\s*["']?(${OWNER}(?:/[^@"'\s]+)?)@([^\s"']+)`,
  "g",
);

export interface ActionRefMismatch {
  ref: string;
  found: string;
  expected: string;
}

/** Reduce a tag like `v1.2.3` (or already-major `v1`) to its major `v1`. */
export function majorOf(tag: string): string {
  return tag.split(".")[0];
}

export function findMismatchedActionRefs(
  yaml: string,
  expectedTagOrMajor: string,
): ActionRefMismatch[] {
  const expected = majorOf(expectedTagOrMajor);
  const out: ActionRefMismatch[] = [];
  for (const m of yaml.matchAll(USES_RE)) {
    const [, ref, found] = m;
    if (found !== expected) out.push({ ref, found, expected });
  }
  return out;
}
