/** Codex インラインコメントから抽出した指摘 */
export interface Finding {
  severity: "P0" | "P1" | "P2";
  path: string;
  line: number;
  title: string;
  body: string;
}

/** Severity パーサーの結果（P2 含む。フィルタ前） */
export interface ParsedComment {
  severity: "P0" | "P1" | "P2" | null;
  title: string;
  body: string;
}

/** Claude が返す edit_file ツール呼び出し */
export interface EditOperation {
  path: string;
  oldCode: string;
  newCode: string;
  explanation: string;
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
}

export interface FindingsHashEntry {
  iteration: number;
  hash: string;
}

export type ReviewStatus =
  | "initialized"
  | "waiting_codex"
  | "fixing"
  | "done"
  | "stopped";

export type StopReason =
  | "no_findings"
  | "max_iterations"
  | "loop_detected"
  | "claude_api_error"
  | "test_failure"
  | "manual_stop"
  | "state_corrupted";

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
