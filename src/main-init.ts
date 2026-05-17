import * as core from "@actions/core";
import { loadInitConfig } from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import {
  createInitialState,
  createStateComment,
  updateStateComment,
  readState,
} from "./state-manager.js";
import { postCodexReviewRequest } from "./comment-poster.js";
import type { Config } from "./config.js";
import { registerAllSecrets } from "./secrets.js";

type ReadState = typeof readState;
type CreateStateComment = typeof createStateComment;
type UpdateStateComment = typeof updateStateComment;
type PostCodexReviewRequest = typeof postCodexReviewRequest;

export interface InitDeps {
  readState: ReadState;
  createStateComment: CreateStateComment;
  updateStateComment: UpdateStateComment;
  postCodexReviewRequest: PostCodexReviewRequest;
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
  setSecret: core.setSecret,
  info: core.info,
  warning: core.warning,
  setOutput: core.setOutput,
};

export async function runInit(config: Config, deps: InitDeps = defaultDeps): Promise<void> {
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

  deps.info("Workflow A completed: status = waiting_codex");
  deps.setOutput("comment-id", String(commentId));
}

async function run(): Promise<void> {
  await runInit(loadInitConfig());
}

runIfNotVitest(run);
