/**
 * Thin wrapper around the authenticated `gh` CLI (TY-346/347).
 *
 * The CLI runs read-only checks (and a couple of idempotent writes like label
 * creation) through the developer's existing `gh` session. The `GhClient`
 * interface is what the pre-flight checks depend on, so tests inject a fake and
 * never shell out. `RealGhClient` is the production implementation.
 */
import { execFile } from "node:child_process";

/** Error from a `gh api` call, carrying the HTTP status when parseable. */
export class GhError extends Error {
  constructor(
    message: string,
    /** HTTP status (e.g. 403, 404) when the failure was an API response, else undefined. */
    readonly status: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

/** Thrown when `gh` is missing or the user is not authenticated (→ exit 2). */
export class GhAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhAuthError";
  }
}

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Outcome of a permission-sensitive probe. `ok:false` means the value could not
 * be determined (e.g. 403) — checks must surface that as `unknown`, never a
 * silent pass (TY-347).
 */
export type Probe<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface RepoInfo {
  defaultBranch: string;
  allowAutoMerge: boolean;
}

export interface GhClient {
  /** `owner/repo` of the repo `gh` resolves in the cwd. */
  currentRepo(): Promise<string>;
  /** `gh api <path>` returning parsed JSON. Throws {@link GhError} on HTTP error. */
  api<T = unknown>(path: string, opts?: { method?: string; fields?: Record<string, string> }): Promise<T>;
  /** True if a label exists; false on 404. Re-throws other errors (e.g. 403). */
  labelExists(repo: string, name: string): Promise<boolean>;
  /** Idempotent label creation. Returns "exists" if it already existed. */
  createLabel(
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<"created" | "exists">;

  // ── TY-347 read-only probes ───────────────────────────────────────────────
  /** Secret NAMES (values are never readable). Throws {@link GhError} on 403. */
  listSecretNames(repo: string): Promise<string[]>;
  /** Repository Actions variable value, or null when unset (404). */
  getVariable(repo: string, name: string): Promise<string | null>;
  /** Default branch + Allow-auto-merge setting. */
  getRepoInfo(repo: string): Promise<RepoInfo>;
  /**
   * Required status-check contexts on a branch. Returns null when the branch is
   * not protected / has no required checks (404). Throws {@link GhError} on 403.
   */
  getRequiredStatusCheckContexts(repo: string, branch: string): Promise<string[] | null>;
  /** Logins seen on recent issue/PR comments (for Codex-connection inference). */
  listRecentActorLogins(repo: string): Promise<string[]>;
}

function run(cmd: string, args: string[]): Promise<GhExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

function parseHttpStatus(stderr: string): number | undefined {
  const m = stderr.match(/\(HTTP (\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

export class RealGhClient implements GhClient {
  async ensureAvailable(): Promise<void> {
    const { code } = await run("gh", ["--version"]);
    if (code !== 0) {
      throw new GhAuthError("the GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com/.");
    }
    const auth = await run("gh", ["auth", "status"]);
    if (auth.code !== 0) {
      throw new GhAuthError("not authenticated with `gh`. Run `gh auth login` and retry.");
    }
  }

  async currentRepo(): Promise<string> {
    const { stdout, stderr, code } = await run("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner",
    ]);
    if (code !== 0 || !stdout.trim()) {
      throw new GhAuthError(
        `could not resolve the current repository via \`gh\`. Run inside a repo with a GitHub remote. (${stderr.trim()})`,
      );
    }
    return stdout.trim();
  }

  async api<T = unknown>(
    path: string,
    opts: { method?: string; fields?: Record<string, string> } = {},
  ): Promise<T> {
    const args = ["api", path];
    if (opts.method) args.push("--method", opts.method);
    for (const [k, v] of Object.entries(opts.fields ?? {})) {
      args.push("-f", `${k}=${v}`);
    }
    const { stdout, stderr, code } = await run("gh", args);
    if (code !== 0) {
      throw new GhError(
        `gh api ${path} failed: ${stderr.trim() || "unknown error"}`,
        parseHttpStatus(stderr),
        stderr,
      );
    }
    return (stdout.trim() ? JSON.parse(stdout) : null) as T;
  }

  async labelExists(repo: string, name: string): Promise<boolean> {
    try {
      await this.api(`repos/${repo}/labels/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return false;
      throw e;
    }
  }

  async createLabel(
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<"created" | "exists"> {
    if (await this.labelExists(repo, name)) return "exists";
    const { stderr, code } = await run("gh", [
      "label",
      "create",
      name,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description,
    ]);
    if (code !== 0) {
      // `gh label create` exits non-zero if the label already exists (race).
      if (/already exists/i.test(stderr)) return "exists";
      throw new GhError(`gh label create failed: ${stderr.trim()}`, parseHttpStatus(stderr), stderr);
    }
    return "created";
  }

  async listSecretNames(repo: string): Promise<string[]> {
    // Repository secrets. A 403 here propagates → the check reports `unknown`.
    const r = await this.api<{ secrets?: { name: string }[] }>(
      `repos/${repo}/actions/secrets?per_page=100`,
    );
    const names = new Set((r?.secrets ?? []).map((s) => s.name));
    // Also union the ORG secrets visible to this repo — the workflow can use
    // them too, so omitting them would false-positive "secret missing". Best
    // effort: skip silently if the repo is not in an org / org secrets are
    // unreadable. (Environment secrets are intentionally not checked: the
    // LoopPilot workflows declare no `environment:`, so they can't use them.)
    try {
      const org = await this.api<{ secrets?: { name: string }[] }>(
        `repos/${repo}/actions/organization-secrets?per_page=100`,
      );
      for (const s of org?.secrets ?? []) names.add(s.name);
    } catch {
      /* repo not in an org / no org-secret visibility — repo secrets suffice */
    }
    return [...names];
  }

  async getVariable(repo: string, name: string): Promise<string | null> {
    try {
      const r = await this.api<{ value?: string }>(
        `repos/${repo}/actions/variables/${encodeURIComponent(name)}`,
      );
      return r?.value ?? null;
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }

  async getRepoInfo(repo: string): Promise<RepoInfo> {
    const r = await this.api<{ default_branch: string; allow_auto_merge?: boolean }>(`repos/${repo}`);
    return { defaultBranch: r.default_branch, allowAutoMerge: Boolean(r.allow_auto_merge) };
  }

  async getRequiredStatusCheckContexts(repo: string, branch: string): Promise<string[] | null> {
    try {
      const r = await this.api<{ contexts?: string[]; checks?: { context: string }[] }>(
        `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      );
      const ctxs = new Set<string>([
        ...(r.contexts ?? []),
        ...((r.checks ?? []).map((c) => c.context)),
      ]);
      return [...ctxs];
    } catch (e) {
      // 404 = branch not protected or no required checks → treat as "none".
      if (e instanceof GhError && e.status === 404) return null;
      throw e; // 403 etc. bubble up so the check can report `unknown`.
    }
  }

  async listRecentActorLogins(repo: string): Promise<string[]> {
    const r = await this.api<Array<{ user?: { login?: string } }>>(
      `repos/${repo}/issues/comments?per_page=100&sort=created&direction=desc`,
    );
    if (!Array.isArray(r)) return [];
    return r.map((c) => c.user?.login).filter((x): x is string => typeof x === "string");
  }
}
