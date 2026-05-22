import * as core from "@actions/core";
import { loadInitConfig } from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import {
  createInitialState,
  createStateComment,
  updateStateComment,
  readState,
} from "./state-manager.js";
import {
  postCodexReviewRequest,
  postInitialStatusComment,
} from "./comment-poster.js";
import type { BaseConfig } from "./config.js";
import { registerAllSecrets } from "./secrets.js";

type ReadState = typeof readState;
type CreateStateComment = typeof createStateComment;
type UpdateStateComment = typeof updateStateComment;
type PostCodexReviewRequest = typeof postCodexReviewRequest;
type PostInitialStatusComment = typeof postInitialStatusComment;

export interface InitDeps {
  readState: ReadState;
  createStateComment: CreateStateComment;
  updateStateComment: UpdateStateComment;
  postCodexReviewRequest: PostCodexReviewRequest;
  postInitialStatusComment: PostInitialStatusComment;
  setSecret: (secret: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  setOutput: (name: string, value: string) => void;
}

const defaultDeps: InitDeps = {
  readState,
  createStateComment,
  updateStateComment,
  postCodexReviewRequest,
  postInitialStatusComment,
  // TY-276 #4: wrap @actions/core methods in arrows for symmetry with
  // main-pre-fix / main-post-fix. The direct-reference form works today
  // because `@actions/core` does not use `this`, but a future version that
  // does would silently break.
  setSecret: (secret) => core.setSecret(secret),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  setOutput: (name, value) => core.setOutput(name, value),
};

export async function runInit(config: BaseConfig, deps: InitDeps = defaultDeps): Promise<void> {
  registerAllSecrets(config, deps.setSecret);
  deps.info(`Initializing auto-review for PR #${config.prNumber}`);

  // Check for existing hidden comment (re-run support)
  const existing = await deps.readState(
    config.repoOwner, config.repoName, config.prNumber, config.githubToken,
  );

  let commentId: number;
  let state = createInitialState();

  if (existing.found) {
    commentId = existing.commentId;
    if (existing.state.status !== "initialized") {
      deps.info(`Auto-review state is already ${existing.state.status}. Skipping init.`);
      deps.setOutput("comment-id", String(commentId));
      return;
    }
    deps.info("Found incomplete initialized state comment, continuing init");
  } else if (existing.corrupted && existing.commentId !== null) {
    deps.warning("Found corrupted state comment, overwriting with fresh state");
    commentId = existing.commentId;
    await deps.updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);
  } else {
    commentId = await deps.createStateComment(config.repoOwner, config.repoName, config.prNumber, state, config.githubToken);
    deps.info(`Created state comment: ${commentId}`);
  }

  // Post @codex review
  const reviewRequestId = await deps.postCodexReviewRequest(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.codexReviewRequestToken
  );
  deps.info(`Posted @codex review: comment ${reviewRequestId}`);

  // Update status to waiting_codex
  state = { ...state, status: "waiting_codex", lastCodexRequestCommentId: reviewRequestId };
  await deps.updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);

  // TY-291 #2 (UX-05): seed the visible status comment so the PR shows
  // "Initialized — waiting for first Codex review" during the 5-15 minute gap
  // before post-fix runs its first iteration. Best-effort: a failure here is
  // logged but does not roll back init — the next post-fix iteration's
  // `upsertStatusComment` is idempotent and will pick the snapshot back up.
  try {
    const statusCommentId = await deps.postInitialStatusComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.maxReviewIterations,
      config.githubToken,
    );
    deps.info(`Created initial status comment: ${statusCommentId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warning(`Failed to create initial status comment: ${message}`);
  }

  deps.info("Workflow A completed: status = waiting_codex");
  deps.setOutput("comment-id", String(commentId));
}

async function run(): Promise<void> {
  await runInit(loadInitConfig());
}

runIfNotVitest(run);
