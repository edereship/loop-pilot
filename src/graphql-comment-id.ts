import type { CommentId } from "./types.js";

/**
 * Extract a numeric review-comment id from a GraphQL value.
 *
 * GitHub's `PullRequestReviewComment.databaseId` (Int) is deprecated because it
 * cannot represent 64-bit ids and is null for newer comments; `fullDatabaseId`
 * (BigInt, serialized as a numeric string over JSON) is the replacement. Callers
 * should prefer `fullDatabaseId` and fall back to `databaseId`:
 *
 *   parseGraphqlCommentId(node.fullDatabaseId) ?? parseGraphqlCommentId(node.databaseId)
 *
 * We accept either a JSON number or a numeric string and require a safe integer
 * so the id stays compatible with the REST {@link CommentId} space used for
 * matching/resolving review threads.
 */
export function parseGraphqlCommentId(value: unknown): CommentId | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
