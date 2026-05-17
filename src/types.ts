/** Severity ラベル。urgency 順 (P0 が最も緊急、P3 が最低)。 */
export type Severity = "P0" | "P1" | "P2" | "P3";

/** Codex インラインコメントから抽出した指摘 */
export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  title: string;
  body: string;
}

/** Severity パーサーの結果。`null` は severity を認識できなかったコメントを表す。 */
export interface ParsedComment {
  severity: Severity | null;
  title: string;
  body: string;
}

/** PR の hidden comment に保存する状態 */
export interface ReviewState {
  iterationCount: number;
  lastProcessedReviewId: number | null;
  lastClaudeCommitSha: string | null;
  lastCodexRequestCommentId: number | null;
  lastCodexReviewReceivedAt: string | null;
  lastFindingsHash: string | null;
  findingsHashHistory: FindingsHashEntry[];
  status: ReviewStatus;
  stopReason: StopReason | null;
  /**
   * Tail of the previous iteration's CHECK_COMMAND failure output.
   * Used as additional context for the next claude-code-action repair
   * prompt. Null when the previous iteration did not run CHECK_COMMAND
   * or succeeded.
   */
  previousCheckFailure: string | null;
}

export interface FindingsHashEntry {
  iteration: number;
  hash: string;
  /**
   * Model tier used to attempt repair for this iteration's findings.
   * Optional for backward compatibility with state comments written before
   * TY-243; missing values are treated as "escalated" so legacy state still
   * stops on hash repetition instead of silently bypassing loop detection.
   */
  modelTier?: "base" | "escalated";
}

export type ReviewStatus =
  | "initialized"
  | "waiting_codex"
  | "fixing"
  | "done"
  | "stopped";

/**
 * Each entry pairs the canonical `StopReason` key with the human-readable label
 * surfaced in status / stop comments. The single object is the source of truth
 * for both the type union and the display text (TY-267 #24) so adding a new
 * reason requires one edit here instead of three locations across `types.ts`,
 * `comment-poster.ts`, and tests.
 */
export const STOP_REASON_LABELS = {
  no_findings: "no findings at or above the configured severity threshold",
  max_iterations: "reached max iterations (MAX_REVIEW_ITERATIONS)",
  loop_detected: "same findings detected in loop",
  claude_api_error: "Claude API error",
  test_failure: "CHECK_COMMAND failed after fix",
  manual_stop: "manual stop requested",
  state_corrupted: "hidden comment state corrupted",
  state_conflict: "hidden comment state changed concurrently",
  action_timeout: "Claude Code Action workflow timeout",
  action_failure: "Claude Code Action exited with a non-zero status",
  scope_violation: "repair touched paths or exceeded the size budget allowed for auto-fix",
  max_turns_exceeded: "Claude Code Action exhausted the configured --max-turns budget",
  codex_usage_limit: "Codex reported usage / quota limits; no review was performed",
} as const satisfies Record<string, string>;

export type StopReason = keyof typeof STOP_REASON_LABELS;

/** Claude API に渡す PR コンテキスト */
export interface PrContext {
  number: number;
  title: string;
  branch: string;
}

/** GitHub API から取得した review comment の生データ */
export interface RawReviewComment {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
}

export type FetchReviewCommentsFn = () => Promise<RawReviewComment[]>;
export type SleepFn = (ms: number) => Promise<void>;
