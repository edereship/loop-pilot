/**
 * Toolchain auto-detection for `gh looppilot init` (TY-346).
 *
 * Pure functions over a directory's filenames (and optionally the parsed
 * package.json) so they are trivially fixture-testable. The init command reads
 * the filesystem and feeds the results here.
 */

export type Ecosystem = "node" | "python" | "go" | "rust" | "make";

/** The reusable-workflow `language:` input value (ADR/TY-345). */
export type WorkflowLanguage = "node" | "python" | "go" | "rust" | "none";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageJsonLike {
  scripts?: Record<string, string>;
}

export interface ToolchainDetection {
  /** Detected primary ecosystem, or null if none recognized. */
  ecosystem: Ecosystem | null;
  /** The reusable-workflow `language:` input value (make/none → "none"). */
  language: WorkflowLanguage;
  /** Suggested CHECK_COMMAND, or "" when unknown (user must set). */
  checkCommand: string;
  /** Marker files / signals that drove the primary detection. */
  evidence: string[];
  /** Other recognized ecosystems beyond the primary (ambiguity signal). */
  alsoDetected: Ecosystem[];
  /** node package manager when detectable. */
  packageManager?: PackageManager;
}

// Priority order: a Makefile is usually a wrapper over a real toolchain, so it
// ranks last; a polyglot repo's "primary" is the highest-priority match.
const PRIORITY: Ecosystem[] = ["node", "python", "go", "rust", "make"];

const MARKERS: Record<Ecosystem, string[]> = {
  node: ["package.json"],
  python: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  make: ["Makefile", "makefile", "GNUmakefile"],
};

/** Map an ecosystem (or null) to the reusable-workflow `language:` input. */
export function toWorkflowLanguage(ecosystem: Ecosystem | null): WorkflowLanguage {
  switch (ecosystem) {
    case "node":
    case "python":
    case "go":
    case "rust":
      return ecosystem;
    default:
      // make and "nothing recognized" both rely on preinstalled runner tools.
      return "none";
  }
}

function detectPackageManager(fileSet: Set<string>): PackageManager {
  if (fileSet.has("pnpm-lock.yaml")) return "pnpm";
  if (fileSet.has("yarn.lock")) return "yarn";
  if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) return "bun";
  return "npm"; // package-lock.json or no lockfile
}

function nodeCheckCommand(pm: PackageManager, pkg?: PackageJsonLike): string {
  const scripts = pkg?.scripts ?? {};
  const script = scripts.check ? "check" : scripts.test ? "test" : "check";
  // `<pm> run <script>` works for npm/pnpm/yarn/bun uniformly (npm/yarn also
  // accept the bare alias, but `run` avoids colliding with builtins like
  // `yarn check` / `bun test`).
  return `${pm} run ${script}`;
}

function suggestCheckCommand(
  ecosystem: Ecosystem | null,
  pm: PackageManager,
  pkg?: PackageJsonLike,
): string {
  switch (ecosystem) {
    case "node":
      return nodeCheckCommand(pm, pkg);
    case "python":
      return "pytest";
    case "go":
      return "go test ./...";
    case "rust":
      return "cargo test";
    case "make":
      return "make check";
    default:
      return "";
  }
}

/**
 * Detect the primary toolchain from a repo's root filenames.
 *
 * @param files   filenames present at the repo root (e.g. from fs.readdirSync)
 * @param pkg     parsed package.json (optional; sharpens the Node CHECK_COMMAND)
 */
export function detectToolchain(files: string[], pkg?: PackageJsonLike): ToolchainDetection {
  const fileSet = new Set(files);

  const present: Ecosystem[] = PRIORITY.filter((eco) =>
    MARKERS[eco].some((m) => fileSet.has(m)),
  );

  const ecosystem = present[0] ?? null;
  const alsoDetected = present.slice(1);
  const packageManager = ecosystem === "node" ? detectPackageManager(fileSet) : undefined;

  const evidence = ecosystem
    ? MARKERS[ecosystem].filter((m) => fileSet.has(m))
    : [];
  if (ecosystem === "node" && packageManager) {
    const lockfile = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lockb" }[packageManager];
    if (fileSet.has(lockfile)) evidence.push(lockfile);
  }

  return {
    ecosystem,
    language: toWorkflowLanguage(ecosystem),
    checkCommand: suggestCheckCommand(ecosystem, packageManager ?? "npm", pkg),
    evidence,
    alsoDetected,
    packageManager,
  };
}
