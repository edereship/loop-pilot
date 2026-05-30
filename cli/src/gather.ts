/**
 * Gather the read-only signals the pre-flight checks interpret (TY-347).
 *
 * Each permission-sensitive probe is isolated so a 403 on one (e.g. listing
 * secrets without admin) degrades only that signal to a failed `Probe` — the
 * rest still resolve. Checks then surface a failed probe as `unknown`, never a
 * silent pass.
 */
import { GhError, type GhClient, type Probe, type RepoInfo } from "./gh.js";

export interface GatheredSignals {
  defaultBranch: string;
  autoMerge: boolean;
  /** vars.LOOPPILOT_LABEL (undefined → check uses the default). */
  label?: string;
  fullAuto: boolean;
  /** vars.CHECK_COMMAND (undefined → fall back to detection). */
  checkCommand?: string;
  codexBotLogin: string;
  secretNames: Probe<string[]>;
  /** value [] = no required checks / not protected; ok:false = unreadable (403). */
  requiredChecks: Probe<string[]>;
  repoInfo: Probe<RepoInfo>;
  codexSeen: Probe<boolean>;
}

function reasonOf(e: unknown): string {
  if (e instanceof GhError) {
    return e.status === 403 ? "insufficient permission (HTTP 403)" : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const DEFAULT_CODEX_BOT = "chatgpt-codex-connector[bot]";

export async function gatherSignals(gh: GhClient, repository: string): Promise<GatheredSignals> {
  const getVar = async (name: string): Promise<string | null> => {
    try {
      return await gh.getVariable(repository, name);
    } catch {
      // Variables drive context defaults; an unreadable variable falls back to
      // the default rather than blocking the whole pre-flight.
      return null;
    }
  };

  const [fullAutoRaw, labelRaw, checkCommandRaw, autoMergeRaw, codexBotRaw] = await Promise.all([
    getVar("LOOPPILOT_FULL_AUTO"),
    getVar("LOOPPILOT_LABEL"),
    getVar("CHECK_COMMAND"),
    getVar("LOOPPILOT_AUTO_MERGE"),
    getVar("CODEX_BOT_LOGIN"),
  ]);

  let repoInfo: Probe<RepoInfo>;
  let defaultBranch = "main";
  try {
    const ri = await gh.getRepoInfo(repository);
    repoInfo = { ok: true, value: ri };
    defaultBranch = ri.defaultBranch || "main";
  } catch (e) {
    repoInfo = { ok: false, reason: reasonOf(e) };
  }

  let secretNames: Probe<string[]>;
  try {
    secretNames = { ok: true, value: await gh.listSecretNames(repository) };
  } catch (e) {
    secretNames = { ok: false, reason: reasonOf(e) };
  }

  let requiredChecks: Probe<string[]>;
  try {
    const rc = await gh.getRequiredStatusCheckContexts(repository, defaultBranch);
    requiredChecks = { ok: true, value: rc ?? [] };
  } catch (e) {
    requiredChecks = { ok: false, reason: reasonOf(e) };
  }

  const codexBotLogin = (codexBotRaw ?? "").trim() || DEFAULT_CODEX_BOT;
  let codexSeen: Probe<boolean>;
  try {
    const logins = await gh.listRecentActorLogins(repository);
    codexSeen = { ok: true, value: logins.includes(codexBotLogin) };
  } catch (e) {
    codexSeen = { ok: false, reason: reasonOf(e) };
  }

  return {
    defaultBranch,
    autoMerge: (autoMergeRaw ?? "").trim() === "true",
    label: labelRaw?.trim() || undefined,
    fullAuto: (fullAutoRaw ?? "").trim() === "true",
    checkCommand: checkCommandRaw?.trim() || undefined,
    codexBotLogin,
    secretNames,
    requiredChecks,
    repoInfo,
    codexSeen,
  };
}
