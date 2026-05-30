import type { GhClient } from "../src/gh.js";

/** A GhClient stub with benign defaults; override per test. */
export function fakeGh(over: Partial<GhClient> = {}): GhClient {
  return {
    currentRepo: async () => "acme/widgets",
    api: (async () => ({})) as GhClient["api"],
    labelExists: async () => true,
    createLabel: async () => "created",
    listSecretNames: async () => [],
    getVariable: async () => null,
    getRepoInfo: async () => ({ defaultBranch: "main", allowAutoMerge: false }),
    getRequiredStatusCheckContexts: async () => null,
    listRecentActorLogins: async () => [],
    ...over,
  };
}
