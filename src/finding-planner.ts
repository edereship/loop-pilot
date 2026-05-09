import type { Finding } from "./types.js";

export interface FindingsPlan {
  selectedFindings: Finding[];
  deferredFiles: string[];
}

function severityRank(severity: Finding["severity"]): number {
  switch (severity) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
  }
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.path);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(finding.path, [finding]);
    }
  }
  return groups;
}

function bestSeverityRank(findings: Finding[]): number {
  return Math.min(...findings.map((finding) => severityRank(finding.severity)));
}

export function planFindingsForIteration(
  findings: Finding[],
  maxFiles: number,
): FindingsPlan {
  const fileGroups = groupByFile(findings);
  const orderedFiles = Array.from(fileGroups.entries()).sort((a, b) => {
    const severityDelta = bestSeverityRank(a[1]) - bestSeverityRank(b[1]);
    if (severityDelta !== 0) return severityDelta;
    return b[1].length - a[1].length;
  });

  const selectedFiles = orderedFiles.slice(0, maxFiles);
  const deferredFiles = orderedFiles.slice(maxFiles).map(([filePath]) => filePath);

  const selectedFindings = selectedFiles
    .flatMap(([, fileFindings]) => fileFindings)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  return {
    selectedFindings,
    deferredFiles,
  };
}
