import * as core from "@actions/core";
import { loadInitConfig } from "./config.js";
import {
  createInitialState,
  createStateComment,
  updateStateComment,
  readState,
} from "./state-manager.js";
import { postCodexReviewRequest } from "./comment-poster.js";

async function run(): Promise<void> {
  const config = loadInitConfig();
  core.info(`Initializing auto-review for PR #${config.prNumber}`);

  // Check for existing hidden comment (re-run support)
  const existing = await readState(
    config.repoOwner, config.repoName, config.prNumber, config.githubToken,
  );

  let commentId: number;
  let state = createInitialState();

  if (existing) {
    core.info("Found existing state comment, resetting to initialized");
    commentId = existing.commentId;
    await updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);
  } else {
    commentId = await createStateComment(config.repoOwner, config.repoName, config.prNumber, state, config.githubToken);
    core.info(`Created state comment: ${commentId}`);
  }

  // Post @codex review
  const reviewRequestId = await postCodexReviewRequest(config.repoOwner, config.repoName, config.prNumber, config.githubToken);
  core.info(`Posted @codex review: comment ${reviewRequestId}`);

  // Update status to waiting_codex
  state = { ...state, status: "waiting_codex", lastCodexRequestCommentId: reviewRequestId };
  await updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);

  core.info("Workflow A completed: status = waiting_codex");
  core.setOutput("comment-id", String(commentId));
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
