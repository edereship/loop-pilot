/**
 * Build a minimal environment for gh CLI subprocesses.
 *
 * Why: Spreading process.env passes all secrets (ANTHROPIC_API_KEY, etc.)
 * to child processes. gh only needs PATH, HOME, and GH_TOKEN.
 */
export function buildGhEnv(token: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_TOKEN: token,
    // gh may need these for HTTPS proxy support
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
}
