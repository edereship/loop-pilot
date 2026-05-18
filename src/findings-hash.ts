import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

export function computeFindingsHash(findings: Finding[]): string {
  const normalized = findings.map(normalizeFinding);
  const uniqueSorted = [...new Set(normalized)].sort();
  return stableHash(JSON.stringify(uniqueSorted));
}

function normalizeFinding(finding: Finding): string {
  // line is intentionally excluded: it shifts when code is edited,
  // so including it would cause false "different findings" detections.
  // title is also intentionally excluded (TY-276 #7) — Codex sometimes
  // refines the title between iterations while pointing at the same issue,
  // and including it would let those cosmetic rewrites bypass loop detection.
  const bodyHash = stableHash(finding.body);
  return JSON.stringify([finding.severity, finding.path, bodyHash]);
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
