import { loadInitConfig } from "./config.js";
import {
  createInitialState,
  createStateComment,
  updateStateComment,
  readState,
} from "./state-manager.js";
import { postCodexReviewRequest } from "./comment-poster.js";

async function main(): Promise<void> {
  const config = loadInitConfig();
  console.log(`Initializing auto-review for PR #${config.prNumber}`);

  // Check for existing hidden comment (re-run support)
  const existing = await readState(
    config.repoOwner, config.repoName, config.prNumber, config.githubToken,
  );

  let commentId: number;
  let state = createInitialState();

  if (existing) {
    console.log("Found existing state comment, resetting to initialized");
    commentId = existing.commentId;
    await updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);
  } else {
    commentId = await createStateComment(config.repoOwner, config.repoName, config.prNumber, state, config.githubToken);
    console.log(`Created state comment: ${commentId}`);
  }

  // Post @codex review
  const reviewRequestId = await postCodexReviewRequest(config.repoOwner, config.repoName, config.prNumber, config.githubToken);
  console.log(`Posted @codex review: comment ${reviewRequestId}`);

  // Update status to waiting_codex
  state = { ...state, status: "waiting_codex", lastCodexRequestCommentId: reviewRequestId };
  await updateStateComment(config.repoOwner, config.repoName, commentId, state, config.githubToken);

  console.log("Workflow A completed: status = waiting_codex");
}

main().catch((error) => {
  console.error("Workflow A failed:", error);
  process.exit(1);
});
