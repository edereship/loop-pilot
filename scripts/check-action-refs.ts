/**
 * CLI guard run by the release workflow (TY-342). Reads the composite action
 * YAML files that hardcode `team-yubune/loop-pilot/*@v1` sub-action refs and
 * fails if any ref's major differs from the tag being released.
 *
 * Usage: node --import tsx scripts/check-action-refs.ts <tag>
 *   e.g. node --import tsx scripts/check-action-refs.ts v1.2.3
 */
import { readFileSync } from "node:fs";
import { findMismatchedActionRefs } from "../src/action-ref-check.js";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: check-action-refs <tag>  (e.g. v1.2.3)");
  process.exit(2);
}

// Files that pin team-yubune/loop-pilot sub-actions by published path@ref.
const FILES = ["loop/action.yml", "init/action.yml"];

let failed = false;
for (const file of FILES) {
  const yaml = readFileSync(file, "utf8");
  const mismatches = findMismatchedActionRefs(yaml, tag);
  for (const m of mismatches) {
    failed = true;
    console.error(
      `::error file=${file}::${m.ref}@${m.found} does not match release major ${m.expected} (tag ${tag})`,
    );
  }
}

if (failed) {
  console.error(
    "Sub-action refs are out of sync with the release tag. Update the @<major> refs and retag.",
  );
  process.exit(1);
}
console.log(`OK: all team-yubune/loop-pilot action refs match ${tag}`);
