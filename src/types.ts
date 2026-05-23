/** Severity ラベル。urgency 順 (P0 が最も緊急、P3 が最低)。 */
export type Severity = "P0" | "P1" | "P2" | "P3";

/** Codex インラインコメントから抽出した指摘 */
export interface Finding {
  severity: Severity;
  path: string;
  /**
   * 1-based line number where Codex anchored the comment, or `null` for
   * file-level / outdated comments that Codex emits without a line anchor
   * (TY-280). Consumers must format `null` as "file-level" rather than as
   * `path:0`, which would imply a real first-line anchor.
   */
  line: number | null;
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
  /**
   * Trigger event source of `lastProcessedReviewId` (TY-301 #2). issue_comment
   * と pull_request_review は別 ID 名前空間を持つため、id だけで dedup すると
   * 稀にだが (review id, comment id) 衝突で正当な trigger を silently skip
   * しうる。Legacy state では `null`(= 未収集) として現行ロジックと互換になり、
   * id のみでの dedup にフォールバックする。Pre-fix が trigger event を識別
   * できないとき (legacy workflow YAML, `triggerEventName === ""`) も `null`。
   */
  lastProcessedTriggerSource: "comment" | "review" | null;
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
  /**
   * Timestamp at which pre-fix transitioned into `fixing` for the current
   * iteration (TY-273 #B4). Pre-fix sets it to `now()` whenever Phase 3
   * claims the `fixing` status; post-fix clears it back to null on every
   * terminal transition (`waiting_codex` / `done` / `stopped`). Used by the
   * `fixing` stale-detection in pre-fix instead of `lastCodexReviewReceivedAt`,
   * which is preserved across `/restart-review` and would falsely trip the
   * stale threshold on restart-recovered fixing states.
   *
   * Legacy state comments written before this field was added are normalized
   * to null by `deserializeState`. The stale detector treats null as "not
   * stale" so existing in-flight PRs do not regress to `state_corrupted`.
   */
  fixingStartedAt: string | null;
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
  no_findings: "no findings at or above the severity threshold — done",
  max_iterations: "max iterations reached — `/restart-review --hard` to retry",
  loop_detected:
    "same findings repeated at escalated tier — review the finding manually",
  test_failure:
    "CHECK_COMMAND failed after the repair — fix the failure and `/restart-review`",
  state_corrupted:
    "hidden state JSON corrupted — see docs/operations/stop-and-recovery.md",
  state_conflict:
    "hidden state changed concurrently — wait, then `/restart-review`",
  workflow_crashed: "auto-fix workflow crashed — `/restart-review` to resume",
  action_timeout: "Claude Code Action timed out — `/restart-review` to retry",
  action_failure:
    "Claude Code Action exited non-zero — check the workflow run",
  scope_violation:
    "repair touched blocked paths — adjust `AUTO_REVIEW_BLOCK_PATHS` or revert",
  max_turns_exceeded:
    "Claude Code Action hit `--max-turns` — `/restart-review` escalates tier",
  codex_usage_limit:
    "Codex quota exhausted — wait for reset, then `/restart-review`",
  codex_request_failed:
    "could not re-post `@codex review` — fix Codex auth, then `/restart-review`",
  secret_leak_suspected:
    "auto-fix output looks like a secret — review, then `/restart-review --hard`",
  action_no_op:
    "Claude Code Action made no file changes — review the findings manually",
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
