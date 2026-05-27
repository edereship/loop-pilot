import type { BaseConfig, Config } from "./config.js";

/**
 * `Config` のうち secret 扱いするフィールド。
 *
 * このリストに追加するだけで `registerAllSecrets` と `stripSecretEnv` の両方に
 * 反映されるため、init/pre-fix/post-fix のどこかで `setSecret` を呼び忘れたり、
 * CHECK_COMMAND の子プロセスへ漏らしたりする事故を防げる。
 */
export const SECRET_CONFIG_FIELDS = [
  "githubToken",
  "codexReviewRequestToken",
  "autoReviewPushToken",
  "anthropicApiKey",
  "claudeCodeOauthToken",
] as const satisfies readonly (keyof Config)[];

export type SecretConfigField = (typeof SECRET_CONFIG_FIELDS)[number];

/**
 * `SECRET_CONFIG_FIELDS` 各値に対応する素 env 名と GitHub Actions inputs env 名
 * (`INPUT_<NAME>`)。CHECK_COMMAND を実行する前に env から除外する対象。
 *
 * 末端ユーザーが `env:` ブロックで素の名前を渡してくる可能性 (`CODEX_REVIEW_REQUEST_TOKEN`
 * を直接 export してから自前の CHECK_COMMAND を走らせる、等) があるので両方を網羅する。
 */
export const SECRET_ENV_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CODEX_REVIEW_REQUEST_TOKEN",
  "LOOPPILOT_PUSH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "INPUT_GITHUB_TOKEN",
  "INPUT_CODEX_REVIEW_REQUEST_TOKEN",
  "INPUT_LOOPPILOT_PUSH_TOKEN",
  "INPUT_ANTHROPIC_API_KEY",
  "INPUT_CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Config 上の secret フィールドをまとめて `setSecret` に登録する。`setSecret` 自身は
 * 空文字を渡されても no-op なので、未設定の credential があっても安全に呼べる。
 *
 * init/pre-fix/post-fix すべての entrypoint がこの関数を通すことで、新しい secret を
 * `SECRET_CONFIG_FIELDS` に追加するだけで 3 ヶ所すべてに自動反映される。
 *
 * TY-267 で `Config` を `BaseConfig` (init / post-fix) と `ClaudeAuthConfig`
 * (pre-fix) に分割したため、ここでは `BaseConfig` を受けて Anthropic
 * credential フィールドは optional として扱う。`BaseConfig` を渡した場合は
 * 対応するキーが存在せず undefined なので、`typeof === "string"` の早期
 * skip で問題ない。
 */
export function registerAllSecrets(
  config: BaseConfig | Config,
  setSecret: (secret: string) => void,
): void {
  const lookup = config as Partial<Record<SecretConfigField, unknown>>;
  for (const field of SECRET_CONFIG_FIELDS) {
    const value = lookup[field];
    if (typeof value === "string" && value !== "") {
      setSecret(value);
    }
  }
}

/**
 * 子プロセス向けに secret を除外した env を返す。defense-in-depth:
 *
 * - `SECRET_ENV_NAMES` に列挙された既知の secret 環境変数を delete
 * - `INPUT_*` プレフィックスの環境変数をすべて delete (LoopPilot action の input が
 *   未来に追加されても、CHECK_COMMAND に渡さない安全側に倒す)
 */
export function stripSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const name of SECRET_ENV_NAMES) {
    delete safe[name];
  }
  for (const key of Object.keys(safe)) {
    if (key.startsWith("INPUT_")) {
      delete safe[key];
    }
  }
  return safe;
}
