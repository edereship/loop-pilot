# Codex Review × Claude Fix Auto-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR に対して Codex がレビューし、Claude が P0/P1 指摘を自動修正するループを GitHub Actions 上で動作させる（PoC）。

**Architecture:** GitHub Actions の 2 本の Workflow で構成する。Workflow A（`auto-review-init.yml`）は PR 作成時に hidden comment で状態を初期化し `@codex review` を投稿する。Workflow B（`auto-review-loop.yml`）は Codex の総評コメント（`issue_comment`）をトリガーに、デバウンス待機 → インラインコメント収集 → P0/P1 抽出 → Claude API で修正 → テスト → commit/push → 再レビュー依頼の一連のフローを実行する。状態は PR の hidden comment（HTML コメント内 JSON）で管理し、外部 DB は不要。

**Tech Stack:** TypeScript, Node.js 20, Vitest, Anthropic SDK (`@anthropic-ai/sdk`), GitHub Actions, `gh` CLI

**Reference Docs:**
- [System Overview](../../architecture/system-overview.md)
- [Flow and State](../../architecture/flow-and-state.md)
- [Event Design](../../architecture/event-design.md)
- [Severity Parser Spec](../../specs/severity-parser.md)
- [Claude Fix Engine Spec](../../specs/claude-fix-engine.md)
- [Loop Detection Spec](../../specs/loop-detection.md)
- [Security](../../operations/security.md)
- [Check and Rollback](../../operations/check-and-rollback.md)
- [Stop and Recovery](../../operations/stop-and-recovery.md)
- [Test Strategy](../../testing/test-strategy.md)
- [PoC Checklist](../../checklists/poc-checklist.md)

---

## File Structure

```
test-auto-ai-review/
├── .github/
│   └── workflows/
│       ├── auto-review-init.yml      # Workflow A: PR 作成時の初期化
│       └── auto-review-loop.yml      # Workflow B: Codex レビュー受信 + Claude 修正
├── src/
│   ├── types.ts                      # 共有型定義（Finding, State, EditOperation 等）
│   ├── config.ts                     # 環境変数の読み込みとバリデーション
│   ├── severity-parser.ts            # Codex コメントから severity + title + body を抽出
│   ├── findings-hash.ts              # findings セットの決定的ハッシュ計算
│   ├── loop-detector.ts              # findings_hash_history との比較でループ検知
│   ├── edit-applier.ts               # edit_file の old_code → new_code 置換ロジック
│   ├── state-manager.ts              # hidden comment の CRUD（GitHub API 経由）
│   ├── review-collector.ts           # Codex インラインコメントの収集・フィルタ・findings 生成
│   ├── claude-fix-engine.ts          # Claude API 呼び出し + edit_file tool use 処理
│   ├── check-runner.ts               # CHECK_COMMAND 実行 + 失敗時ロールバック
│   ├── comment-poster.ts             # PR コメント投稿ヘルパー（修正要約・エラー報告等）
│   ├── main-init.ts                  # Workflow A のエントリポイント
│   └── main-loop.ts                  # Workflow B のエントリポイント
├── tests/
│   ├── severity-parser.test.ts       # Severity パーサーのユニットテスト
│   ├── findings-hash.test.ts         # findings ハッシュのユニットテスト
│   ├── loop-detector.test.ts         # ループ検知のユニットテスト
│   ├── edit-applier.test.ts          # edit 適用ロジックのユニットテスト
│   ├── state-manager.test.ts         # state manager のユニットテスト（GitHub API モック）
│   ├── review-collector.test.ts      # review collector のユニットテスト（GitHub API モック）
│   └── integration/
│       └── workflow-b-phase1.test.ts  # Phase 1（レビュー受信〜findings 生成）の統合テスト
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 各ファイルの責務

| ファイル | 責務 | 依存先 |
|---------|------|--------|
| `types.ts` | 全コンポーネント共通の型定義 | なし |
| `config.ts` | 環境変数を型付きオブジェクトとして提供 | `types.ts` |
| `severity-parser.ts` | コメント本文 → `{ severity, title, body }` の抽出 | `types.ts` |
| `findings-hash.ts` | `Finding[]` → 決定的ハッシュ文字列 | `types.ts` |
| `loop-detector.ts` | 現在の findings hash と履歴の比較 | `findings-hash.ts`, `types.ts` |
| `edit-applier.ts` | `EditOperation[]` をファイルに適用（逆順・空白正規化・複数マッチ） | `types.ts` |
| `state-manager.ts` | hidden comment の読み書き・更新 | `types.ts`, `config.ts` |
| `review-collector.ts` | GitHub API からインラインコメント取得 → `Finding[]` 生成 | `severity-parser.ts`, `types.ts`, `config.ts` |
| `claude-fix-engine.ts` | Claude API 呼び出し → `EditOperation[]` 取得 | `types.ts`, `config.ts` |
| `check-runner.ts` | `CHECK_COMMAND` 実行・出力サニタイズ・ロールバック | `config.ts` |
| `comment-poster.ts` | PR コメントの投稿（修正要約・エラー・完了・停止） | `types.ts` |
| `main-init.ts` | Workflow A のオーケストレーション | `state-manager.ts`, `comment-poster.ts`, `config.ts` |
| `main-loop.ts` | Workflow B の Phase 1〜4 オーケストレーション | 全モジュール |

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "auto-review-loop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "tsc --noEmit && vitest run",
    "init": "node --import tsx src/main-init.ts",
    "loop": "node --import tsx src/main-loop.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 5: Verify setup**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, so clean exit)

Run: `npx vitest run`
Expected: "No test files found" (OK at this point)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: scaffold project with TypeScript, Vitest, and Anthropic SDK"
```

---

## Task 2: Shared Types & Config

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`

- [ ] **Step 1: Create `src/types.ts`**

全コンポーネントで使う型を定義する。設計ドキュメントの状態スキーマ（[flow-and-state.md#状態管理](../../architecture/flow-and-state.md#状態管理)）および findings 形式（[claude-fix-engine.md#claude-に渡す入力形式](../../specs/claude-fix-engine.md#claude-に渡す入力形式)）に準拠する。

```typescript
// src/types.ts

/** Codex インラインコメントから抽出した指摘 */
export interface Finding {
  severity: "P0" | "P1";
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
```

- [ ] **Step 2: Create `src/config.ts`**

環境変数を型付きで読み込む。デフォルト値は [system-overview.md#設定可能なパラメータ](../../architecture/system-overview.md#設定可能なパラメータ) に準拠する。

```typescript
// src/config.ts

export interface Config {
  maxReviewIterations: number;
  debounceSeconds: number;
  checkCommand: string;
  maxFilesPerIteration: number;
  maxInputTokensPerFile: number;
  codexBotLogin: string;
  stabilizeIntervalSeconds: number;
  stabilizeCount: number;
  codexReviewMarker: string;
  anthropicApiKey: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
}

/**
 * Workflow B 用の全設定を読み込む（ANTHROPIC_API_KEY 必須）。
 */
export function loadConfig(): Config {
  return {
    ...loadBaseConfig(),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  };
}

/**
 * Workflow A 用の設定を読み込む（ANTHROPIC_API_KEY 不要）。
 */
export function loadInitConfig(): Config {
  return {
    ...loadBaseConfig(),
    anthropicApiKey: "",
  };
}

function loadBaseConfig(): Omit<Config, "anthropicApiKey"> {
  const repoFullName = requireEnv("GITHUB_REPOSITORY");
  const [repoOwner, repoName] = repoFullName.split("/");

  return {
    maxReviewIterations: intEnv("MAX_REVIEW_ITERATIONS", 20),
    debounceSeconds: intEnv("DEBOUNCE_SECONDS", 90),
    checkCommand: env("CHECK_COMMAND", "npm run check"),
    maxFilesPerIteration: intEnv("MAX_FILES_PER_ITERATION", 10),
    maxInputTokensPerFile: intEnv("MAX_INPUT_TOKENS_PER_FILE", 30000),
    codexBotLogin: env("CODEX_BOT_LOGIN", "chatgpt-codex-connector[bot]"),
    stabilizeIntervalSeconds: intEnv("STABILIZE_INTERVAL_SECONDS", 10),
    stabilizeCount: intEnv("STABILIZE_COUNT", 3),
    codexReviewMarker: env("CODEX_REVIEW_MARKER", "Codex Review"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    repoOwner,
    repoName,
    prNumber: intEnv("PR_NUMBER", 0),
  };
}

function env(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function intEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${value}`);
  }
  return parsed;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add shared type definitions and config loader"
```

---

## Task 3: Severity Parser (TDD)

**Files:**
- Create: `src/severity-parser.ts`
- Create: `tests/severity-parser.test.ts`

**Spec reference:** [Severity パーサー仕様](../../specs/severity-parser.md), [テスト戦略 §1](../../testing/test-strategy.md#1-severity-パーサー)

このパーサーは Codex インラインコメントの `body` から severity・title・body を抽出する。段階的マッチング（Stage 1 → Stage 2 → フォールバック）で Codex のフォーマット変更にも耐える設計。

- [ ] **Step 1: Write failing tests**

テストケースは [test-strategy.md](../../testing/test-strategy.md) と [severity-parser.md](../../specs/severity-parser.md) に記載のケースを網羅する。

```typescript
// tests/severity-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseSeverity } from "../src/severity-parser.js";

describe("parseSeverity", () => {
  // Stage 1: 角括弧付き or 裸のバッジ
  it("parses bare badge: 'P0 Title'", () => {
    const result = parseSeverity("P0 Token refresh path can bypass expiry validation\n\nThe token refresh logic...");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Token refresh path can bypass expiry validation");
    expect(result.body).toBe("The token refresh logic...");
  });

  it("parses bracketed badge: '[P1] Title'", () => {
    const result = parseSeverity("[P1] Unauthenticated requests reach protected handler\n\nUnder the else branch...");
    expect(result.severity).toBe("P1");
    expect(result.title).toBe("Unauthenticated requests reach protected handler");
    expect(result.body).toBe("Under the else branch...");
  });

  it("parses badge without space: '[P0]Title'", () => {
    const result = parseSeverity("[P0]Title text here");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title text here");
  });

  // Stage 2: Markdown 太字
  it("parses bold badge: '**P0** Title'", () => {
    const result = parseSeverity("**P0** Title bold");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title bold");
  });

  it("parses bold bracketed badge: '**[P0]** Title'", () => {
    const result = parseSeverity("**[P0]** Title bold bracket");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title bold bracket");
  });

  // 前処理: 先頭空白・改行の除去
  it("strips leading whitespace and newlines", () => {
    const result = parseSeverity("\n  P0 Title after whitespace");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Title after whitespace");
  });

  // P2 は severity として認識するが修正対象外
  it("parses P2 but marks it as P2", () => {
    const result = parseSeverity("P2 Low priority style issue");
    expect(result.severity).toBe("P2");
    expect(result.title).toBe("Low priority style issue");
  });

  // フォールバック: 先頭にバッジがないがコメント内に P0/P1 が出現
  it("falls back to keyword detection in body", () => {
    const result = parseSeverity("Some text with P0 in the middle\n\nMore details here");
    expect(result.severity).toBe("P0");
    expect(result.title).toBe("Some text with P0 in the middle");
  });

  // severity なし
  it("returns null severity when no badge found", () => {
    const result = parseSeverity("No severity badge at all\n\nJust a normal comment");
    expect(result.severity).toBeNull();
  });

  // body 分離: 改行で title と body を分離
  it("separates title and body at first blank line", () => {
    const result = parseSeverity("P1 Short title\n\nDetailed explanation\nacross multiple lines");
    expect(result.title).toBe("Short title");
    expect(result.body).toBe("Detailed explanation\nacross multiple lines");
  });

  // body なしのケース
  it("handles comment with no body (title only)", () => {
    const result = parseSeverity("P0 Only a title here");
    expect(result.title).toBe("Only a title here");
    expect(result.body).toBe("");
  });

  // Useful? フッターの除去
  it("strips trailing 'Useful? React with...' footer", () => {
    const result = parseSeverity("P1 Some issue\n\nExplanation\n\nUseful? React with 👍 / 👎.");
    expect(result.body).toBe("Explanation");
    expect(result.body).not.toContain("Useful?");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/severity-parser.test.ts`
Expected: FAIL — module `../src/severity-parser.js` not found

- [ ] **Step 3: Implement `severity-parser.ts`**

```typescript
// src/severity-parser.ts
import type { ParsedComment } from "./types.js";

// Stage 1: 角括弧付き or 裸のバッジ（spec: severity-parser.md）
const STAGE1_RE = /^\s*\[?(P[0-2])\]?\s*(.*)/;
// Stage 2: Markdown 太字
const STAGE2_RE = /^\s*(?:\*{2})?\[?(P[0-2])\]?(?:\*{2})?\s*(.*)/;
// フォールバック: 本文内の P0/P1 キーワード
const FALLBACK_RE = /\b(P[01])\b/;
// Codex フッター除去
const FOOTER_RE = /\n*Useful\? React with.*$/s;

export function parseSeverity(rawBody: string): ParsedComment {
  const stripped = rawBody.trim();
  const { titleLine, body } = splitTitleAndBody(stripped);

  // Stage 1
  let match = titleLine.match(STAGE1_RE);
  if (match) {
    return buildResult(match[1] as ParsedComment["severity"], match[2].trim(), body);
  }

  // Stage 2
  match = titleLine.match(STAGE2_RE);
  if (match) {
    return buildResult(match[1] as ParsedComment["severity"], match[2].trim(), body);
  }

  // フォールバック: コメント全体から P0/P1 をキーワード検出
  const fallbackMatch = stripped.match(FALLBACK_RE);
  if (fallbackMatch) {
    return buildResult(
      fallbackMatch[1] as ParsedComment["severity"],
      titleLine,
      body,
    );
  }

  return { severity: null, title: titleLine, body };
}

function splitTitleAndBody(text: string): { titleLine: string; body: string } {
  // 最初の空行で title と body を分離
  const blankLineIndex = text.indexOf("\n\n");
  if (blankLineIndex === -1) {
    return { titleLine: text, body: "" };
  }
  const titleLine = text.slice(0, blankLineIndex);
  let body = text.slice(blankLineIndex + 2);
  // Codex フッター除去
  body = body.replace(FOOTER_RE, "").trim();
  return { titleLine, body };
}

function buildResult(
  severity: ParsedComment["severity"],
  title: string,
  body: string,
): ParsedComment {
  return { severity, title, body };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/severity-parser.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/severity-parser.ts tests/severity-parser.test.ts
git commit -m "feat: add severity parser with staged regex matching and fallback"
```

---

## Task 4: Findings Hash (TDD)

**Files:**
- Create: `src/findings-hash.ts`
- Create: `tests/findings-hash.test.ts`

**Spec reference:** [ループ検知](../../specs/loop-detection.md), [テスト戦略 §2](../../testing/test-strategy.md#2-findings-ハッシュ)

findings セット全体の決定的ハッシュを計算する。ループ検知の基盤コンポーネント。`line` はキーに含めない（修正で変動するため）。

- [ ] **Step 1: Write failing tests**

```typescript
// tests/findings-hash.test.ts
import { describe, it, expect } from "vitest";
import { computeFindingsHash } from "../src/findings-hash.js";
import type { Finding } from "../src/types.js";

const findingA: Finding = {
  severity: "P0",
  path: "src/auth/session.ts",
  line: 84,
  title: "Token refresh bypass",
  body: "The token refresh logic skips expiry check",
};

const findingB: Finding = {
  severity: "P1",
  path: "src/auth/middleware.ts",
  line: 42,
  title: "Unauthenticated requests",
  body: "Requests without a valid session reach protected handler",
};

describe("computeFindingsHash", () => {
  it("produces deterministic hash for same findings", () => {
    const hash1 = computeFindingsHash([findingA, findingB]);
    const hash2 = computeFindingsHash([findingA, findingB]);
    expect(hash1).toBe(hash2);
  });

  it("produces same hash regardless of order", () => {
    const hash1 = computeFindingsHash([findingA, findingB]);
    const hash2 = computeFindingsHash([findingB, findingA]);
    expect(hash1).toBe(hash2);
  });

  it("produces different hash when findings differ", () => {
    const findingC: Finding = { ...findingA, body: "Different issue description" };
    const hash1 = computeFindingsHash([findingA, findingB]);
    const hash2 = computeFindingsHash([findingC, findingB]);
    expect(hash1).not.toBe(hash2);
  });

  it("produces same hash when only line differs", () => {
    const findingADifferentLine: Finding = { ...findingA, line: 999 };
    const hash1 = computeFindingsHash([findingA]);
    const hash2 = computeFindingsHash([findingADifferentLine]);
    expect(hash1).toBe(hash2);
  });

  it("returns a hex string of length 16", () => {
    const hash = computeFindingsHash([findingA]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/findings-hash.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `findings-hash.ts`**

疑似コードは [loop-detection.md](../../specs/loop-detection.md) の Python 版を TypeScript に移植する。`crypto.createHash("sha256")` を使い、プロセス間で決定的なハッシュを保証する。

```typescript
// src/findings-hash.ts
import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

/**
 * findings セット全体の決定的ハッシュを計算する。
 * line はキーに含めない（修正で変動するため）。
 * Spec: docs/specs/loop-detection.md
 */
export function computeFindingsHash(findings: Finding[]): string {
  const normalized = findings.map(normalizeFinding);
  const uniqueSorted = [...new Set(normalized)].sort();
  return stableHash(JSON.stringify(uniqueSorted));
}

function normalizeFinding(finding: Finding): string {
  // (severity, path, body_hash) を JSON 配列として文字列化
  const bodyHash = stableHash(finding.body);
  return JSON.stringify([finding.severity, finding.path, bodyHash]);
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/findings-hash.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/findings-hash.ts tests/findings-hash.test.ts
git commit -m "feat: add deterministic findings hash computation for loop detection"
```

---

## Task 5: Loop Detector (TDD)

**Files:**
- Create: `src/loop-detector.ts`
- Create: `tests/loop-detector.test.ts`

**Spec reference:** [ループ検知](../../specs/loop-detection.md), [テスト戦略 §4](../../testing/test-strategy.md#4-ループ検知)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/loop-detector.test.ts
import { describe, it, expect } from "vitest";
import { isLoop } from "../src/loop-detector.js";
import type { Finding, FindingsHashEntry } from "../src/types.js";

const findingsA: Finding[] = [
  { severity: "P0", path: "a.ts", line: 1, title: "Issue A", body: "Body A" },
];

const findingsB: Finding[] = [
  { severity: "P1", path: "b.ts", line: 2, title: "Issue B", body: "Body B" },
];

describe("isLoop", () => {
  it("detects loop when current hash matches history", async () => {
    const { computeFindingsHash } = await import("../src/findings-hash.js");
    const hashA = computeFindingsHash(findingsA);
    const history: FindingsHashEntry[] = [{ iteration: 1, hash: hashA }];
    expect(isLoop(findingsA, history)).toBe(true);
  });

  it("detects oscillation pattern A → B → A", async () => {
    const { computeFindingsHash } = await import("../src/findings-hash.js");
    const hashA = computeFindingsHash(findingsA);
    const hashB = computeFindingsHash(findingsB);
    const history: FindingsHashEntry[] = [
      { iteration: 1, hash: hashA },
      { iteration: 2, hash: hashB },
    ];
    // Current findings are A again — should detect loop
    expect(isLoop(findingsA, history)).toBe(true);
  });

  it("returns false when no loop", async () => {
    const { computeFindingsHash } = await import("../src/findings-hash.js");
    const hashA = computeFindingsHash(findingsA);
    const history: FindingsHashEntry[] = [{ iteration: 1, hash: hashA }];
    expect(isLoop(findingsB, history)).toBe(false);
  });

  it("returns false when history is empty", () => {
    expect(isLoop(findingsA, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/loop-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `loop-detector.ts`**

```typescript
// src/loop-detector.ts
import { computeFindingsHash } from "./findings-hash.js";
import type { Finding, FindingsHashEntry } from "./types.js";

/**
 * 直近 N 回の findings hash 履歴と比較し、ループを検知する。
 * 振動パターン（A→B→A）も検知する。
 * Spec: docs/specs/loop-detection.md
 */
export function isLoop(
  currentFindings: Finding[],
  findingsHashHistory: FindingsHashEntry[],
): boolean {
  const currentHash = computeFindingsHash(currentFindings);
  return findingsHashHistory.some((entry) => entry.hash === currentHash);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/loop-detector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/loop-detector.ts tests/loop-detector.test.ts
git commit -m "feat: add loop detector using findings hash history comparison"
```

---

## Task 6: Edit Applier (TDD)

**Files:**
- Create: `src/edit-applier.ts`
- Create: `tests/edit-applier.test.ts`

**Spec reference:** [Claude 修正エンジン仕様 §edit 適用ロジック](../../specs/claude-fix-engine.md#edit-適用ロジック), [テスト戦略 §3](../../testing/test-strategy.md#3-edit_file-適用ロジック)

edit_file の `old_code` → `new_code` 置換ロジック。逆順適用・空白正規化マッチング・複数マッチ時の `line` 最近マッチ選択・メモリ上での一括検証を実装する。

- [ ] **Step 1: Write failing tests**

```typescript
// tests/edit-applier.test.ts
import { describe, it, expect } from "vitest";
import { applyEdits } from "../src/edit-applier.js";
import type { EditOperation } from "../src/types.js";

describe("applyEdits", () => {
  const baseContent = [
    "function hello() {",
    '  console.log("hello");',
    "}",
    "",
    "function world() {",
    '  console.log("world");',
    "}",
  ].join("\n");

  it("applies a single edit", () => {
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: '  console.log("hello");',
        newCode: '  console.log("hi");',
        explanation: "Fix greeting",
      },
    ];
    const result = applyEdits(baseContent, edits, "test.ts");
    expect(result.success).toBe(true);
    expect(result.content).toContain('"hi"');
    expect(result.content).not.toContain('"hello"');
  });

  it("applies multiple edits in reverse order (bottom-first)", () => {
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: '  console.log("hello");',
        newCode: '  console.log("hi");\n  console.log("extra");',
        explanation: "Add extra line to hello",
      },
      {
        path: "test.ts",
        oldCode: '  console.log("world");',
        newCode: '  console.log("earth");',
        explanation: "Fix world",
      },
    ];
    const result = applyEdits(baseContent, edits, "test.ts");
    expect(result.success).toBe(true);
    expect(result.content).toContain('"hi"');
    expect(result.content).toContain('"extra"');
    expect(result.content).toContain('"earth"');
  });

  it("matches with whitespace normalization (trailing spaces)", () => {
    const contentWithTrailing = '  console.log("hello");  \n}';
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: '  console.log("hello");',
        newCode: '  console.log("hi");',
        explanation: "Fix",
      },
    ];
    const result = applyEdits(contentWithTrailing, edits, "test.ts");
    expect(result.success).toBe(true);
    expect(result.content).toContain('"hi"');
  });

  it("matches with CRLF normalization", () => {
    const crlfContent = 'function a() {\r\n  return 1;\r\n}';
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: "function a() {\n  return 1;\n}",
        newCode: "function a() {\n  return 2;\n}",
        explanation: "Fix return value",
      },
    ];
    const result = applyEdits(crlfContent, edits, "test.ts");
    expect(result.success).toBe(true);
    expect(result.content).toContain("return 2");
  });

  it("selects nearest match to finding line when multiple matches exist", () => {
    const dupeContent = [
      "if (x) {",       // line 1
      "  return null;",  // line 2
      "}",               // line 3
      "if (y) {",        // line 4
      "  return null;",  // line 5
      "}",               // line 6
    ].join("\n");
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: "  return null;",
        newCode: "  return undefined;",
        explanation: "Fix second return",
      },
    ];
    // line hint = 5 → should replace the second occurrence
    const result = applyEdits(dupeContent, edits, "test.ts", [5]);
    expect(result.success).toBe(true);
    const lines = result.content!.split("\n");
    expect(lines[1]).toBe("  return null;");     // first occurrence unchanged
    expect(lines[4]).toBe("  return undefined;"); // second occurrence changed
  });

  it("returns failure when old_code not found", () => {
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: "nonexistent code",
        newCode: "replacement",
        explanation: "Fix",
      },
    ];
    const result = applyEdits(baseContent, edits, "test.ts");
    expect(result.success).toBe(false);
    expect(result.failedEdits).toHaveLength(1);
  });

  it("does not write partial edits on failure (all-or-nothing)", () => {
    const edits: EditOperation[] = [
      {
        path: "test.ts",
        oldCode: '  console.log("hello");',
        newCode: '  console.log("hi");',
        explanation: "Fix hello - should succeed",
      },
      {
        path: "test.ts",
        oldCode: "nonexistent code",
        newCode: "replacement",
        explanation: "Fix - should fail",
      },
    ];
    const result = applyEdits(baseContent, edits, "test.ts");
    expect(result.success).toBe(false);
    // content should be null since we don't produce partial results
    expect(result.content).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/edit-applier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `edit-applier.ts`**

```typescript
// src/edit-applier.ts
import type { EditOperation } from "./types.js";

export interface ApplyResult {
  success: boolean;
  content: string | null;
  failedEdits: EditOperation[];
}

/**
 * edit_file 操作をファイル内容に適用する。
 * - 逆順適用（末尾側から）で行番号ズレを防ぐ
 * - 空白正規化マッチング（trailing whitespace, CRLF → LF）
 * - 複数マッチ時は finding の line に最も近いマッチを選択
 * - 全 edit 成功時のみ結果を返す（all-or-nothing）
 *
 * Spec: docs/specs/claude-fix-engine.md#edit-適用ロジック
 *
 * @param lineHints - 各 edit に対応する finding の line 番号（複数マッチ時の優先選択用）
 */
export function applyEdits(
  content: string,
  edits: EditOperation[],
  filePath: string,
  lineHints?: number[],
): ApplyResult {
  const failedEdits: EditOperation[] = [];

  // 各 edit のマッチ位置を先に計算（元のファイル内容に対して）
  const editMatches: { edit: EditOperation; startIndex: number }[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const lineHint = lineHints?.[i];
    const matchIndex = findMatchIndex(content, edit.oldCode, lineHint);

    if (matchIndex === -1) {
      failedEdits.push(edit);
    } else {
      editMatches.push({ edit, startIndex: matchIndex });
    }
  }

  if (failedEdits.length > 0) {
    return { success: false, content: null, failedEdits };
  }

  // 逆順適用（末尾側の edit から適用して行番号ズレを防ぐ）
  editMatches.sort((a, b) => b.startIndex - a.startIndex);

  let result = content;
  for (const { edit, startIndex } of editMatches) {
    // マッチ時の実際の長さを再計算（正規化マッチの場合、元テキスト側の長さが異なる）
    const actualLength = findActualMatchLength(result, startIndex, edit.oldCode);
    result =
      result.slice(0, startIndex) +
      edit.newCode +
      result.slice(startIndex + actualLength);
  }

  return { success: true, content: result, failedEdits: [] };
}

function findMatchIndex(
  content: string,
  oldCode: string,
  lineHint?: number,
): number {
  // 1. 完全一致を試行
  const exactMatches = findAllOccurrences(content, oldCode);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    return selectNearestMatch(content, exactMatches, oldCode.length, lineHint);
  }

  // 2. 空白正規化マッチを試行
  const normalizedMatches = findNormalizedMatches(content, oldCode);
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  if (normalizedMatches.length > 1) {
    return selectNearestMatch(content, normalizedMatches, oldCode.length, lineHint);
  }

  return -1;
}

function findAllOccurrences(content: string, search: string): number[] {
  const indices: number[] = [];
  let pos = 0;
  while (true) {
    const index = content.indexOf(search, pos);
    if (index === -1) break;
    indices.push(index);
    pos = index + 1;
  }
  return indices;
}

function findNormalizedMatches(content: string, oldCode: string): number[] {
  const normalizedOld = normalizeWhitespace(oldCode);
  const lines = content.split("\n");
  const indices: number[] = [];

  // スライディングウィンドウでマッチを探す
  const oldLines = normalizedOld.split("\n");
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    const windowLines = lines.slice(i, i + oldLines.length);
    const normalizedWindow = windowLines.map((l) => l.trimEnd()).join("\n");
    if (normalizedWindow === normalizedOld) {
      // 元のコンテンツ内でのバイトオフセットを計算
      const offset = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      indices.push(offset);
    }
  }
  return indices;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function selectNearestMatch(
  content: string,
  matchIndices: number[],
  _matchLength: number,
  lineHint?: number,
): number {
  if (!lineHint || matchIndices.length === 0) return matchIndices[0];

  // 各マッチの行番号を計算し、lineHint に最も近いものを選択
  let nearest = matchIndices[0];
  let minDist = Infinity;
  for (const idx of matchIndices) {
    const matchLine = content.slice(0, idx).split("\n").length;
    const dist = Math.abs(matchLine - lineHint);
    if (dist < minDist) {
      minDist = dist;
      nearest = idx;
    }
  }
  return nearest;
}

function findActualMatchLength(
  content: string,
  startIndex: number,
  oldCode: string,
): number {
  // 完全一致の場合
  if (content.slice(startIndex, startIndex + oldCode.length) === oldCode) {
    return oldCode.length;
  }
  // 正規化マッチの場合: 正規化された oldCode の行数分の元テキストを消費
  const oldLines = normalizeWhitespace(oldCode).split("\n").length;
  const contentFromStart = content.slice(startIndex);
  const contentLines = contentFromStart.split("\n");
  return contentLines.slice(0, oldLines).join("\n").length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/edit-applier.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/edit-applier.ts tests/edit-applier.test.ts
git commit -m "feat: add edit applier with reverse-order application and whitespace normalization"
```

---

## Task 7: State Manager (TDD)

**Files:**
- Create: `src/state-manager.ts`
- Create: `tests/state-manager.test.ts`

**Spec reference:** [状態管理](../../architecture/flow-and-state.md#状態管理)

hidden comment の CRUD を担当する。GitHub API の呼び出しは `gh` CLI をラップする。テストではプロセス実行をモックする。

- [ ] **Step 1: Write failing tests**

```typescript
// tests/state-manager.test.ts
import { describe, it, expect } from "vitest";
import {
  serializeState,
  deserializeState,
  createInitialState,
} from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

describe("state serialization", () => {
  it("serializes state to hidden comment format", () => {
    const state = createInitialState();
    const serialized = serializeState(state);
    expect(serialized).toContain("<!-- auto-review-state");
    expect(serialized).toContain('"status":"initialized"');
    expect(serialized).toContain("-->");
  });

  it("deserializes state from hidden comment body", () => {
    const state = createInitialState();
    state.iterationCount = 3;
    state.status = "waiting_codex";
    const serialized = serializeState(state);
    const deserialized = deserializeState(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.iterationCount).toBe(3);
    expect(deserialized!.status).toBe("waiting_codex");
  });

  it("returns null for invalid hidden comment body", () => {
    const result = deserializeState("not a valid hidden comment");
    expect(result).toBeNull();
  });

  it("returns null for corrupted JSON in hidden comment", () => {
    const result = deserializeState("<!-- auto-review-state\n{invalid json}\n-->");
    expect(result).toBeNull();
  });

  it("creates correct initial state", () => {
    const state = createInitialState();
    expect(state.iterationCount).toBe(0);
    expect(state.status).toBe("initialized");
    expect(state.stopReason).toBeNull();
    expect(state.findingsHashHistory).toEqual([]);
  });

  it("enforces size limit on findings_hash_history (max 3)", () => {
    const state = createInitialState();
    state.findingsHashHistory = [
      { iteration: 1, hash: "aaa" },
      { iteration: 2, hash: "bbb" },
      { iteration: 3, hash: "ccc" },
      { iteration: 4, hash: "ddd" },
    ];
    const serialized = serializeState(state);
    const deserialized = deserializeState(serialized);
    // serializeState should trim to 3 most recent
    expect(deserialized!.findingsHashHistory).toHaveLength(3);
    expect(deserialized!.findingsHashHistory[0].iteration).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/state-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `state-manager.ts`**

```typescript
// src/state-manager.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);

const STATE_MARKER = "<!-- auto-review-state";
const STATE_END = "-->";
const MAX_HASH_HISTORY = 3;
const MAX_COMMENT_SIZE = 65000;

export function createInitialState(): ReviewState {
  return {
    iterationCount: 0,
    lastProcessedReviewId: null,
    lastClaudeCommitSha: null,
    lastCodexRequestCommentId: null,
    lastCodexReviewReceivedAt: null,
    lastFindingsHash: null,
    findingsHashHistory: [],
    status: "initialized",
    stopReason: null,
  };
}

export function serializeState(state: ReviewState): string {
  // findings_hash_history を直近 MAX_HASH_HISTORY 件に切り詰め
  const trimmedState: ReviewState = {
    ...state,
    findingsHashHistory: state.findingsHashHistory.slice(-MAX_HASH_HISTORY),
  };

  let json = JSON.stringify(trimmedState);

  // サイズチェック（65,000 文字超なら history を 1 件に切り詰め）
  if (json.length > MAX_COMMENT_SIZE) {
    trimmedState.findingsHashHistory = trimmedState.findingsHashHistory.slice(-1);
    json = JSON.stringify(trimmedState);
  }

  return `${STATE_MARKER}\n${json}\n${STATE_END}`;
}

export function deserializeState(commentBody: string): ReviewState | null {
  const startIndex = commentBody.indexOf(STATE_MARKER);
  if (startIndex === -1) return null;

  const jsonStart = startIndex + STATE_MARKER.length;
  const endIndex = commentBody.indexOf(STATE_END, jsonStart);
  if (endIndex === -1) return null;

  const jsonStr = commentBody.slice(jsonStart, endIndex).trim();
  try {
    return JSON.parse(jsonStr) as ReviewState;
  } catch {
    return null;
  }
}

/**
 * PR の hidden comment を検索して状態を読み込む。
 * @returns { state, commentId } or null if not found
 */
export async function readState(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string,
): Promise<{ state: ReviewState; commentId: number } | null> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.body | contains("${STATE_MARKER}")) | {id, body}`,
  ], { env: { ...process.env, GH_TOKEN: githubToken } });

  if (!stdout.trim()) return null;

  // gh --jq で複数行 JSON が返る場合は最初の1件を使う
  const firstLine = stdout.trim().split("\n")[0];
  const parsed = JSON.parse(firstLine);
  const state = deserializeState(parsed.body);
  if (!state) return null;

  return { state, commentId: parsed.id };
}

/**
 * hidden comment を新規作成する。
 */
export async function createStateComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  state: ReviewState,
  githubToken: string,
): Promise<number> {
  const body = serializeState(state);
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    "-X", "POST",
    "-f", `body=${body}`,
    "--jq", ".id",
  ], { env: { ...process.env, GH_TOKEN: githubToken } });

  return parseInt(stdout.trim(), 10);
}

/**
 * 既存の hidden comment を更新する。
 */
export async function updateStateComment(
  repoOwner: string,
  repoName: string,
  commentId: number,
  state: ReviewState,
  githubToken: string,
): Promise<void> {
  const body = serializeState(state);
  await execFileAsync("gh", [
    "api",
    `repos/${repoOwner}/${repoName}/issues/comments/${commentId}`,
    "-X", "PATCH",
    "-f", `body=${body}`,
  ], { env: { ...process.env, GH_TOKEN: githubToken } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/state-manager.test.ts`
Expected: All tests PASS（シリアライズ/デシリアライズのテストのみ。GitHub API 呼び出しは統合テストで検証）

- [ ] **Step 5: Commit**

```bash
git add src/state-manager.ts tests/state-manager.test.ts
git commit -m "feat: add state manager for hidden comment CRUD with size limits"
```

---

## Task 8: Review Collector

**Files:**
- Create: `src/review-collector.ts`
- Create: `tests/review-collector.test.ts`

**Spec reference:** [イベント設計 §Phase 1](../../architecture/event-design.md#workflow-b-の処理フェーズ), [Severity パーサー仕様](../../specs/severity-parser.md)

GitHub API から Codex のインラインコメントを取得し、`Finding[]` に変換する。Bot フィルタ・時刻フィルタ・P0/P1 フィルタを適用する。

- [ ] **Step 1: Write failing tests**

```typescript
// tests/review-collector.test.ts
import { describe, it, expect, vi } from "vitest";
import { filterAndParseComments } from "../src/review-collector.js";
import type { RawReviewComment } from "../src/types.js";

describe("filterAndParseComments", () => {
  const codexBot = "chatgpt-codex-connector[bot]";
  const baseTime = "2026-03-20T10:00:00Z";

  const makeComment = (overrides: Partial<RawReviewComment> = {}): RawReviewComment => ({
    id: 1,
    user: { login: codexBot },
    body: "P0 Critical bug\n\nDetailed explanation",
    path: "src/app.ts",
    line: 10,
    createdAt: "2026-03-20T11:00:00Z",
    ...overrides,
  });

  it("extracts P0/P1 findings from Codex bot comments", () => {
    const comments = [makeComment()];
    const findings = filterAndParseComments(comments, codexBot, null);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].path).toBe("src/app.ts");
  });

  it("filters out non-Codex bot comments", () => {
    const comments = [makeComment({ user: { login: "human-user" } })];
    const findings = filterAndParseComments(comments, codexBot, null);
    expect(findings).toHaveLength(0);
  });

  it("filters out P2 findings", () => {
    const comments = [makeComment({ body: "P2 Style issue\n\nMinor style problem" })];
    const findings = filterAndParseComments(comments, codexBot, null);
    expect(findings).toHaveLength(0);
  });

  it("filters by created_at when lastReceivedAt is provided", () => {
    const comments = [
      makeComment({ createdAt: "2026-03-20T09:00:00Z" }), // before filter → excluded
      makeComment({ id: 2, createdAt: "2026-03-20T11:00:00Z" }), // after filter → included
    ];
    const findings = filterAndParseComments(comments, codexBot, baseTime);
    expect(findings).toHaveLength(1);
  });

  it("includes all Codex comments when lastReceivedAt is null", () => {
    const comments = [
      makeComment({ id: 1, createdAt: "2026-03-20T09:00:00Z" }),
      makeComment({ id: 2, createdAt: "2026-03-20T11:00:00Z" }),
    ];
    const findings = filterAndParseComments(comments, codexBot, null);
    expect(findings).toHaveLength(2);
  });

  it("handles comments with null line number", () => {
    const comments = [makeComment({ line: null })];
    const findings = filterAndParseComments(comments, codexBot, null);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/review-collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `review-collector.ts`**

```typescript
// src/review-collector.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSeverity } from "./severity-parser.js";
import type { Finding, RawReviewComment } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub API から PR のインラインコメントを取得する。
 */
export async function fetchReviewComments(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string,
): Promise<RawReviewComment[]> {
  // --paginate + --jq: 各ページが独立に jq 処理されるため、
  // 配列ラッパーを外して NDJSON で出力し、行ごとに JSON.parse する。
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
    "--paginate",
    "--jq",
    ".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at}",
  ], { env: { ...process.env, GH_TOKEN: githubToken } });

  if (!stdout.trim()) return [];

  // NDJSON（1行1オブジェクト）をパース
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RawReviewComment);
}

/**
 * コメント群をフィルタし、P0/P1 の Finding[] に変換する。
 *
 * - Codex bot のコメントのみ対象
 * - lastReceivedAt より後の created_at のコメントのみ対象
 * - P0/P1 のみ抽出（P2 は除外）
 *
 * Spec: docs/architecture/event-design.md Phase 1
 */
export function filterAndParseComments(
  comments: RawReviewComment[],
  codexBotLogin: string,
  lastReceivedAt: string | null,
): Finding[] {
  const findings: Finding[] = [];

  for (const comment of comments) {
    // Bot フィルタ
    if (comment.user.login !== codexBotLogin) continue;

    // 時刻フィルタ
    if (lastReceivedAt && comment.createdAt <= lastReceivedAt) continue;

    // Severity 抽出
    const parsed = parseSeverity(comment.body);
    if (parsed.severity !== "P0" && parsed.severity !== "P1") continue;

    findings.push({
      severity: parsed.severity,
      path: comment.path,
      line: comment.line ?? 0,
      title: parsed.title,
      body: parsed.body,
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/review-collector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/review-collector.ts tests/review-collector.test.ts
git commit -m "feat: add review collector with bot/time/severity filtering"
```

---

## Task 9: Claude Fix Engine

**Files:**
- Create: `src/claude-fix-engine.ts`

**Spec reference:** [Claude 修正エンジン仕様](../../specs/claude-fix-engine.md)

Claude API を呼び出し、`edit_file` tool use で構造化された編集操作を取得する。ファイル単位で呼び出し、リトライ戦略を実装する。

- [ ] **Step 1: Implement `claude-fix-engine.ts`**

このモジュールは外部 API 呼び出しが主体のため、TDD よりも統合テストで検証する。ユニットテストはプロンプト組み立てロジックのみ対象。

```typescript
// src/claude-fix-engine.ts
import Anthropic from "@anthropic-ai/sdk";
import type { EditOperation, Finding, PrContext } from "./types.js";

const EDIT_FILE_TOOL: Anthropic.Tool = {
  name: "edit_file",
  description: "Replace a specific code section in a file",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_code: { type: "string", description: "Exact code to replace" },
      new_code: { type: "string", description: "Replacement code" },
      explanation: { type: "string", description: "Why this change fixes the finding" },
    },
    required: ["path", "old_code", "new_code", "explanation"],
  },
};

const SYSTEM_PROMPT = `You are a senior software engineer fixing code review findings on a pull request.
You will receive Codex review findings (P0/P1 severity) and the source file content.
Use the edit_file tool to make precise, minimal fixes for each finding.

Rules:
- Fix ONLY the listed P0/P1 findings. Do not fix anything else.
- Do not perform unrelated refactors, style changes, or improvements.
- Do not change public APIs unless strictly necessary to fix a finding.
- Preserve existing behavior outside the scope of each finding.
- Each edit_file call must include an explanation of why the change fixes the finding.
- If a finding cannot be fixed safely without risking breakage, do NOT edit the file.
  Instead, respond with a text message explaining why the fix is unsafe.
- You will be told the current iteration number and max iterations.
  If fewer than 3 iterations remain, prefer conservative, minimal fixes over ambitious rewrites.
  Prioritize P0 findings over P1 when iteration budget is limited.`;

interface FixFileResult {
  edits: EditOperation[];
  skippedReason: string | null;
}

/**
 * 1ファイルに対して Claude API を呼び出し、edit_file ツール呼び出しを取得する。
 * Spec: docs/specs/claude-fix-engine.md
 */
export async function fixFile(
  client: Anthropic,
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[],
  iteration: number,
  maxIterations: number,
): Promise<FixFileResult> {
  const userPrompt = buildUserPrompt(prContext, filePath, fileContent, findings, iteration, maxIterations);

  const response = await callWithRetry(client, userPrompt);

  const edits: EditOperation[] = [];
  let skippedReason: string | null = null;

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "edit_file") {
      const input = block.input as {
        path: string;
        old_code: string;
        new_code: string;
        explanation: string;
      };
      edits.push({
        path: input.path,
        oldCode: input.old_code,
        newCode: input.new_code,
        explanation: input.explanation,
      });
    } else if (block.type === "text" && edits.length === 0) {
      // Claude がテキストのみ返した場合 → 安全に修正できない
      skippedReason = block.text;
    }
  }

  return { edits, skippedReason };
}

/**
 * edit_file の old_code 不一致時にリトライする。
 * 中間状態のファイル内容を Claude に渡して修正版の edit_file を再要求する。
 * Spec: docs/specs/claude-fix-engine.md#置換対象が見つからない場合の段階的フォールバック
 */
export async function retryFailedEdits(
  client: Anthropic,
  prContext: PrContext,
  filePath: string,
  currentContent: string,
  failedEdits: EditOperation[],
  iteration: number,
  maxIterations: number,
): Promise<FixFileResult> {
  const findingsFromEdits: Finding[] = failedEdits.map((edit) => ({
    severity: "P0" as const,
    path: edit.path,
    line: 0,
    title: edit.explanation,
    body: `Previous edit_file failed: old_code did not match. Please provide a corrected edit_file for this fix: ${edit.explanation}`,
  }));

  return fixFile(client, prContext, filePath, currentContent, findingsFromEdits, iteration, maxIterations);
}

function buildUserPrompt(
  prContext: PrContext,
  filePath: string,
  fileContent: string,
  findings: Finding[],
  iteration: number,
  maxIterations: number,
): string {
  const language = filePath.split(".").pop() || "";
  const findingsJson = JSON.stringify(
    findings.map((f) => ({
      severity: f.severity,
      line: f.line,
      title: f.title,
      body: f.body,
    })),
    null,
    2,
  );

  return `## PR Context
- PR #${prContext.number}: ${prContext.title}
- Branch: ${prContext.branch}
- Iteration: ${iteration} / ${maxIterations}

## Target File
Path: ${filePath}

\`\`\`${language}
${fileContent}
\`\`\`

## Findings to Fix
${findingsJson}

Fix each finding above using the edit_file tool.`;
}

const RETRY_CONFIG: Record<string, { maxRetries: number; getDelay: (attempt: number) => number }> = {
  rate_limit: { maxRetries: 3, getDelay: (n) => Math.min(30000 * 2 ** n, 300000) },
  server_error: { maxRetries: 3, getDelay: (n) => Math.min(10000 * 2 ** n, 120000) },
  timeout: { maxRetries: 2, getDelay: () => 30000 },
};

async function callWithRetry(
  client: Anthropic,
  userPrompt: string,
): Promise<Anthropic.Message> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [EDIT_FILE_TOOL],
        messages: [{ role: "user", content: userPrompt }],
      });
    } catch (error: unknown) {
      lastError = error;
      const category = categorizeError(error);
      const config = category ? RETRY_CONFIG[category] : null;

      if (!config || attempt >= config.maxRetries) throw error;

      const delay = config.getDelay(attempt);
      console.log(`Claude API ${category} (attempt ${attempt + 1}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

function categorizeError(error: unknown): string | null {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) return "rate_limit";
    if (error.status >= 500 && error.status < 504) return "server_error";
    if (error.status === 408) return "timeout";
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/claude-fix-engine.ts
git commit -m "feat: add Claude fix engine with edit_file tool use and retry strategy"
```

---

## Task 10: Check Runner & Rollback

**Files:**
- Create: `src/check-runner.ts`

**Spec reference:** [検証コマンドとロールバック](../../operations/check-and-rollback.md)

`CHECK_COMMAND` の実行、出力サニタイズ、失敗時のファイルロールバックを担当する。

- [ ] **Step 1: Implement `check-runner.ts`**

```typescript
// src/check-runner.ts
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface CheckResult {
  success: boolean;
  output: string;
}

/**
 * CHECK_COMMAND を実行し、結果を返す。
 * 失敗時は修正ファイルをロールバックする。
 * Spec: docs/operations/check-and-rollback.md
 */
export async function runCheckCommand(
  checkCommand: string,
  modifiedFiles: string[],
  createdFiles: string[],
): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execAsync(checkCommand, {
      timeout: 300000, // 5 minutes
      env: { ...process.env, CI: "true" },
    });
    return { success: true, output: sanitizeOutput(stdout + stderr) };
  } catch (error: unknown) {
    const output = extractErrorOutput(error);

    // ロールバック: 変更ファイルを元に戻し、作成ファイルを削除
    await rollback(modifiedFiles, createdFiles);

    return { success: false, output: sanitizeOutput(output) };
  }
}

async function rollback(
  modifiedFiles: string[],
  createdFiles: string[],
): Promise<void> {
  // 変更されたファイルを git checkout で元に戻す
  if (modifiedFiles.length > 0) {
    await execFileAsync("git", ["checkout", "--", ...modifiedFiles]).catch((e) => {
      console.error("Rollback checkout failed:", e);
    });
  }
  // 作成されたファイルを削除
  if (createdFiles.length > 0) {
    await execFileAsync("rm", ["-f", ...createdFiles]).catch((e) => {
      console.error("Rollback rm failed:", e);
    });
  }
}

/**
 * ANSI エスケープシーケンスを除去し、GitHub コメント文字数制限に収める。
 * Spec: docs/operations/check-and-rollback.md#出力のサニタイズ
 */
export function sanitizeOutput(output: string): string {
  // ANSI エスケープシーケンス除去
  const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  const lines = cleaned.split("\n");
  const maxChars = 60000; // GitHub 65,536 の余裕を持たせる

  if (cleaned.length <= maxChars) return cleaned;

  // 冒頭 20行 + 末尾 50行
  const head = lines.slice(0, 20);
  const tail = lines.slice(-50);
  const truncated = [...head, "\n... (truncated) ...\n", ...tail].join("\n");

  return truncated.slice(0, maxChars);
}

function extractErrorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
  }
  return String(error);
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/check-runner.ts
git commit -m "feat: add check runner with output sanitization and file-level rollback"
```

---

## Task 11: Comment Poster

**Files:**
- Create: `src/comment-poster.ts`

**Spec reference:** [推奨フローと状態管理 §6](../../architecture/flow-and-state.md#6-終了), [停止条件とリカバリ](../../operations/stop-and-recovery.md)

PR への各種コメント投稿を集約する。全コメントは英語で統一する（spec: claude-fix-engine.md）。

- [ ] **Step 1: Implement `comment-poster.ts`**

```typescript
// src/comment-poster.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EditOperation, Finding, StopReason } from "./types.js";

const execFileAsync = promisify(execFile);

async function postComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  body: string,
  githubToken: string,
): Promise<number> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    "-X", "POST",
    "-f", `body=${body}`,
    "--jq", ".id",
  ], { env: { ...process.env, GH_TOKEN: githubToken } });
  return parseInt(stdout.trim(), 10);
}

/** 修正完了の要約コメント */
export async function postFixSummary(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  iteration: number,
  edits: EditOperation[],
  skippedFiles: string[],
  githubToken: string,
): Promise<void> {
  const editSummary = edits
    .map((e) => `- \`${e.path}\`: ${e.explanation}`)
    .join("\n");

  let body = `**Auto-fix applied (iteration ${iteration})**\n\n${editSummary}`;

  if (skippedFiles.length > 0) {
    body += `\n\n**Files requiring manual intervention:**\n${skippedFiles.map((f) => `- \`${f}\``).join("\n")}`;
  }

  await postComment(repoOwner, repoName, prNumber, body, githubToken);
}

/** 正常完了コメント */
export async function postCompletionComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  iterations: number,
  githubToken: string,
): Promise<void> {
  const body = `Auto-review completed.\n\nIterations: ${iterations}\nAll P0/P1 findings have been resolved.`;
  await postComment(repoOwner, repoName, prNumber, body, githubToken);
}

/** 停止コメント */
export async function postStopComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  stopReason: StopReason,
  reviewId: number | null,
  remainingFindings: number,
  detail: string,
  githubToken: string,
): Promise<void> {
  const body = `Automation stopped.\n\nReason: ${formatStopReason(stopReason)}\nLast processed Codex review: ${reviewId ? `#${reviewId}` : "N/A"}\nOpen P0/P1 findings remaining: ${remainingFindings}\n${detail ? `Detail: ${detail}\n` : ""}Recommendation: manual intervention required.`;
  await postComment(repoOwner, repoName, prNumber, body, githubToken);
}

/** テスト失敗コメント */
export async function postTestFailureComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  checkOutput: string,
  githubToken: string,
): Promise<void> {
  const body = `**Auto-fix stopped: CHECK_COMMAND failed**\n\n\`\`\`\n${checkOutput}\n\`\`\`\n\nChanges have been rolled back. Manual intervention required.`;
  await postComment(repoOwner, repoName, prNumber, body, githubToken);
}

/** Workflow A 未完了検知時のエラーコメント */
export async function postInitIncompleteComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string,
): Promise<void> {
  const body = "Auto-review initialization incomplete. Workflow A may have failed before posting the initial review request. Please re-run Workflow A or manually post '@codex review'.";
  await postComment(repoOwner, repoName, prNumber, body, githubToken);
}

/** @codex review を投稿し、コメント ID を返す */
export async function postCodexReviewRequest(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string,
): Promise<number> {
  return postComment(repoOwner, repoName, prNumber, "@codex review", githubToken);
}

function formatStopReason(reason: StopReason): string {
  const map: Record<StopReason, string> = {
    no_findings: "no P0/P1 findings",
    max_iterations: "reached max iterations (MAX_REVIEW_ITERATIONS)",
    loop_detected: "same findings detected in loop",
    claude_api_error: "Claude API error",
    test_failure: "CHECK_COMMAND failed after fix",
    manual_stop: "manual stop requested",
    state_corrupted: "hidden comment state corrupted",
  };
  return map[reason] || reason;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/comment-poster.ts
git commit -m "feat: add comment poster for fix summaries, completion, and error reporting"
```

---

## Task 12: Workflow A — Main Init + GitHub Actions YAML

**Files:**
- Create: `src/main-init.ts`
- Create: `.github/workflows/auto-review-init.yml`

**Spec reference:** [Workflow A](../../architecture/event-design.md#workflow-a-pr-作成時auto-review-inityml), [セキュリティ](../../operations/security.md)

PR 作成時に hidden comment で状態を初期化し、`@codex review` を投稿する。Fork PR 防止のガードを含む。

- [ ] **Step 1: Implement `src/main-init.ts`**

```typescript
// src/main-init.ts
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

  // 既存の hidden comment があるか確認（re-run 対応）
  const existing = await readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );

  let commentId: number;
  let state = createInitialState();

  if (existing) {
    console.log("Found existing state comment, resetting to initialized");
    commentId = existing.commentId;
    await updateStateComment(
      config.repoOwner,
      config.repoName,
      commentId,
      state,
      config.githubToken,
    );
  } else {
    commentId = await createStateComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      state,
      config.githubToken,
    );
    console.log(`Created state comment: ${commentId}`);
  }

  // @codex review を投稿
  const reviewRequestId = await postCodexReviewRequest(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  console.log(`Posted @codex review: comment ${reviewRequestId}`);

  // status を waiting_codex に更新
  state = {
    ...state,
    status: "waiting_codex",
    lastCodexRequestCommentId: reviewRequestId,
  };
  await updateStateComment(
    config.repoOwner,
    config.repoName,
    commentId,
    state,
    config.githubToken,
  );

  console.log("Workflow A completed: status = waiting_codex");
}

main().catch((error) => {
  console.error("Workflow A failed:", error);
  process.exit(1);
});
```

- [ ] **Step 2: Create `.github/workflows/auto-review-init.yml`**

```yaml
# Workflow A: PR 作成時の初期化
# Spec: docs/architecture/event-design.md#workflow-a
name: Auto Review Init

on:
  pull_request:
    types: [opened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  init:
    # Draft PR では起動しない
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Check fork PR (security guard)
        if: github.event.pull_request.head.repo.full_name != github.repository
        run: |
          echo "::error::Fork PR detected. Auto-review is disabled for fork PRs."
          exit 1

      - name: Run init
        run: npx tsx src/main-init.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main-init.ts .github/workflows/auto-review-init.yml
git commit -m "feat: add Workflow A (auto-review-init) for PR initialization"
```

---

## Task 13: Workflow B — Main Loop + GitHub Actions YAML

**Files:**
- Create: `src/main-loop.ts`
- Create: `.github/workflows/auto-review-loop.yml`

**Spec reference:** [Workflow B](../../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正auto-review-loopyml), [推奨フローと状態管理](../../architecture/flow-and-state.md)

Codex レビュー受信後の Phase 1〜4 を実行する。これがシステムの中核。

- [ ] **Step 1: Implement `src/main-loop.ts`**

```typescript
// src/main-loop.ts
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { readState, updateStateComment } from "./state-manager.js";
import { fetchReviewComments, filterAndParseComments } from "./review-collector.js";
import { computeFindingsHash } from "./findings-hash.js";
import { isLoop } from "./loop-detector.js";
import { fixFile, retryFailedEdits } from "./claude-fix-engine.js";
import { applyEdits } from "./edit-applier.js";
import { runCheckCommand, sanitizeOutput } from "./check-runner.js";
import {
  postCompletionComment,
  postStopComment,
  postFixSummary,
  postTestFailureComment,
  postInitIncompleteComment,
  postCodexReviewRequest,
} from "./comment-poster.js";
import type {
  EditOperation,
  Finding,
  PrContext,
  ReviewState,
} from "./types.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const config = loadConfig();
  const triggerCommentId = parseInt(process.env.TRIGGER_COMMENT_ID || "0", 10);
  const repo = { owner: config.repoOwner, name: config.repoName };

  console.log(`Workflow B started for PR #${config.prNumber}`);

  // ── Phase 1: 状態読み込み + ガード ──

  const stateResult = await readState(
    repo.owner, repo.name, config.prNumber, config.githubToken,
  );

  if (!stateResult) {
    console.log("No state comment found. Workflow A may not have run. Skipping.");
    return;
  }

  let { state } = stateResult;
  const { commentId } = stateResult;

  // ガード: initialized → Workflow A 未完了
  if (state.status === "initialized") {
    await postInitIncompleteComment(repo.owner, repo.name, config.prNumber, config.githubToken);
    console.log("State is 'initialized'. Workflow A incomplete. Skipping.");
    return;
  }

  // ガード: fixing / stopped / done → スキップ
  if (["fixing", "stopped", "done"].includes(state.status)) {
    console.log(`State is '${state.status}'. Skipping.`);
    return;
  }

  // 冪等化: 同一レビューは再処理しない
  if (state.lastProcessedReviewId === triggerCommentId) {
    console.log(`Review ${triggerCommentId} already processed. Skipping.`);
    return;
  }

  // ── デバウンス待機 ──
  if (config.debounceSeconds > 0) {
    console.log(`Waiting ${config.debounceSeconds}s for debounce...`);
    await sleep(config.debounceSeconds * 1000);
  }

  // TODO(phase:prototype, reason:PoC で Codex のコメント投稿順序を確認後に必要性を判断, due:MVP):
  // セーフガード（件数安定方式）未実装。config.stabilizeIntervalSeconds / config.stabilizeCount を使い、
  // デバウンス後にインラインコメント 0 件だが総評に指摘ありの場合にポーリングする。
  // Spec: docs/architecture/flow-and-state.md §3 デバウンス待機

  // ── インラインコメント取得 + findings 抽出 ──
  const rawComments = await fetchReviewComments(
    repo.owner, repo.name, config.prNumber, config.githubToken,
  );
  const findings = filterAndParseComments(
    rawComments,
    config.codexBotLogin,
    state.lastCodexReviewReceivedAt,
  );

  console.log(`Found ${findings.length} P0/P1 findings`);

  // 受信時刻を記録（次回のフィルタ用）
  const receivedAt = new Date().toISOString();

  // ── Phase 2: 判定 ──

  // P0/P1 が 0 件 → 正常終了
  if (findings.length === 0) {
    state = {
      ...state,
      status: "done",
      stopReason: "no_findings",
      lastProcessedReviewId: triggerCommentId,
      lastCodexReviewReceivedAt: receivedAt,
    };
    await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);
    await postCompletionComment(repo.owner, repo.name, config.prNumber, state.iterationCount, config.githubToken);
    console.log("No P0/P1 findings. Auto-review completed.");
    return;
  }

  // MAX_REVIEW_ITERATIONS チェック
  if (state.iterationCount >= config.maxReviewIterations) {
    state = { ...state, status: "stopped", stopReason: "max_iterations", lastProcessedReviewId: triggerCommentId };
    await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);
    await postStopComment(repo.owner, repo.name, config.prNumber, "max_iterations", triggerCommentId, findings.length, "", config.githubToken);
    console.log("Max iterations reached. Stopping.");
    return;
  }

  // ループ検知
  const currentFindingsHash = computeFindingsHash(findings);
  if (isLoop(findings, state.findingsHashHistory)) {
    state = { ...state, status: "stopped", stopReason: "loop_detected", lastProcessedReviewId: triggerCommentId };
    await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);
    await postStopComment(repo.owner, repo.name, config.prNumber, "loop_detected", triggerCommentId, findings.length, "Same findings detected across iterations.", config.githubToken);
    console.log("Loop detected. Stopping.");
    return;
  }

  // ── Phase 3: Claude 修正 ──

  state = {
    ...state,
    status: "fixing",
    lastProcessedReviewId: triggerCommentId,
    lastCodexReviewReceivedAt: receivedAt,
  };
  await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);

  // PR ブランチを checkout
  const prBranch = process.env.PR_HEAD_REF || "main";
  await execFileAsync("git", ["checkout", prBranch]);

  // PR コンテキスト
  const prContext: PrContext = {
    number: config.prNumber,
    title: process.env.PR_TITLE || "",
    branch: prBranch,
  };

  // findings をファイル単位でグループ化
  const fileGroups = groupByFile(findings);

  // ファイル数上限で優先度選択
  const selectedFiles = selectFiles(fileGroups, config.maxFilesPerIteration);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const allEdits: EditOperation[] = [];
  const skippedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const createdFiles: string[] = []; // edit_file は置換のみなので通常は空

  for (const [filePath, fileFindings] of selectedFiles) {
    console.log(`Processing ${filePath} (${fileFindings.length} findings)...`);

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, "utf-8");
    } catch {
      console.error(`Cannot read file: ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // TODO(phase:prototype, reason:トークン数推定は文字数ベースの概算で十分, due:MVP):
    // MAX_INPUT_TOKENS_PER_FILE チェック未実装。本番では tiktoken 等でトークン数を推定し、
    // 上限超過時にスキップ + PR コメント報告する。
    // Spec: docs/specs/claude-fix-engine.md#コスト暴走防止策
    const estimatedTokens = Math.ceil(fileContent.length / 4);
    if (estimatedTokens > config.maxInputTokensPerFile) {
      console.log(`File ${filePath} too large (~${estimatedTokens} tokens). Skipping.`);
      skippedFiles.push(filePath);
      continue;
    }

    // Claude API 呼び出し
    let result = await fixFile(
      client, prContext, filePath, fileContent,
      fileFindings, state.iterationCount + 1, config.maxReviewIterations,
    );

    if (result.skippedReason) {
      console.log(`Claude skipped ${filePath}: ${result.skippedReason}`);
      skippedFiles.push(filePath);
      continue;
    }

    // edit 適用（メモリ上）
    const lineHints = fileFindings.map((f) => f.line);
    let applyResult = applyEdits(fileContent, result.edits, filePath, lineHints);

    // old_code 不一致の場合: リトライ（最大2回）
    // Spec: docs/specs/claude-fix-engine.md#置換対象が見つからない場合の段階的フォールバック
    // リトライでは「先行 edit 適用済みの中間状態のファイル内容」を Claude に渡す。
    // 成功した edits は保持し、失敗分のみ再要求 → 全 edits を元ファイルに一括再適用する。
    if (!applyResult.success && applyResult.failedEdits.length > 0) {
      // 成功した edits と失敗した edits を分離
      const failedOldCodes = new Set(applyResult.failedEdits.map((e) => e.oldCode));
      let successfulEdits = result.edits.filter((e) => !failedOldCodes.has(e.oldCode));
      let pendingFailedEdits = applyResult.failedEdits;

      for (let retry = 0; retry < 2; retry++) {
        console.log(`Retry ${retry + 1} for ${filePath} (${pendingFailedEdits.length} failed edits)...`);

        // 成功分を元ファイルに仮適用して中間状態を生成
        const intermediateResult = applyEdits(fileContent, successfulEdits, filePath, lineHints);
        const intermediateContent = intermediateResult.content || fileContent;

        const retryResult = await retryFailedEdits(
          client, prContext, filePath,
          intermediateContent,
          pendingFailedEdits,
          state.iterationCount + 1, config.maxReviewIterations,
        );

        if (retryResult.skippedReason) break;

        // 全 edits（成功分 + リトライ分）を元ファイルに一括適用
        const allEditsForFile = [...successfulEdits, ...retryResult.edits];
        applyResult = applyEdits(fileContent, allEditsForFile, filePath, lineHints);
        if (applyResult.success) {
          result.edits = allEditsForFile;
          break;
        }

        // まだ失敗分がある場合は次のリトライへ
        const newFailedOldCodes = new Set(applyResult.failedEdits.map((e) => e.oldCode));
        successfulEdits = allEditsForFile.filter((e) => !newFailedOldCodes.has(e.oldCode));
        pendingFailedEdits = applyResult.failedEdits;
      }
    }

    if (applyResult.success && applyResult.content) {
      // ディスクに書き込み
      writeFileSync(filePath, applyResult.content, "utf-8");
      modifiedFiles.push(filePath);
      allEdits.push(...result.edits);
    } else {
      console.log(`Failed to apply edits to ${filePath}. Skipping.`);
      skippedFiles.push(filePath);
    }
  }

  if (allEdits.length === 0) {
    state = { ...state, status: "stopped", stopReason: "claude_api_error" };
    await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);
    await postStopComment(repo.owner, repo.name, config.prNumber, "claude_api_error", triggerCommentId, findings.length, "No edits could be applied.", config.githubToken);
    console.log("No edits applied. Stopping.");
    return;
  }

  // CHECK_COMMAND 実行
  console.log(`Running check command: ${config.checkCommand}`);
  const checkResult = await runCheckCommand(config.checkCommand, modifiedFiles, createdFiles);

  if (!checkResult.success) {
    state = { ...state, status: "stopped", stopReason: "test_failure" };
    await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);
    await postTestFailureComment(repo.owner, repo.name, config.prNumber, checkResult.output, config.githubToken);
    console.log("Check command failed. Changes rolled back. Stopping.");
    return;
  }

  // commit / push
  const newIteration = state.iterationCount + 1;
  await execFileAsync("git", ["add", ...modifiedFiles]);

  const commitMessage = `fix: auto-resolve P0/P1 findings from Codex review (iteration ${newIteration})\n\n${allEdits.map((e) => `- ${e.explanation}`).join("\n")}`;
  await execFileAsync("git", ["commit", "-m", commitMessage]);
  await execFileAsync("git", ["push"]);

  const { stdout: commitSha } = await execFileAsync("git", ["rev-parse", "HEAD"]);

  // 修正要約コメント投稿
  await postFixSummary(repo.owner, repo.name, config.prNumber, newIteration, allEdits, skippedFiles, config.githubToken);

  // 状態更新
  const newHashEntry = { iteration: newIteration, hash: currentFindingsHash };
  state = {
    ...state,
    iterationCount: newIteration,
    lastClaudeCommitSha: commitSha.trim(),
    lastFindingsHash: currentFindingsHash,
    findingsHashHistory: [...state.findingsHashHistory, newHashEntry],
    status: "waiting_codex",
    stopReason: null,
  };
  await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);

  // ── Phase 4: 再レビュー依頼 ──
  const reviewRequestId = await postCodexReviewRequest(
    repo.owner, repo.name, config.prNumber, config.githubToken,
  );
  state = { ...state, lastCodexRequestCommentId: reviewRequestId };
  await updateStateComment(repo.owner, repo.name, commentId, state, config.githubToken);

  console.log(`Iteration ${newIteration} complete. Waiting for Codex re-review.`);
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.path) || [];
    existing.push(finding);
    groups.set(finding.path, existing);
  }
  return groups;
}

/**
 * ファイル数上限を適用し、P0 ファイル優先で選択する。
 * Spec: docs/specs/claude-fix-engine.md#大量の-findings・大きなファイルへの対応
 */
function selectFiles(
  fileGroups: Map<string, Finding[]>,
  maxFiles: number,
): [string, Finding[]][] {
  const entries = [...fileGroups.entries()];

  if (entries.length <= maxFiles) return entries;

  // P0 を含むファイル → P1 のみのファイル → findings 数降順
  entries.sort((a, b) => {
    const aHasP0 = a[1].some((f) => f.severity === "P0") ? 0 : 1;
    const bHasP0 = b[1].some((f) => f.severity === "P0") ? 0 : 1;
    if (aHasP0 !== bHasP0) return aHasP0 - bHasP0;
    return b[1].length - a[1].length;
  });

  return entries.slice(0, maxFiles);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("Workflow B failed:", error);
  process.exit(1);
});
```

- [ ] **Step 2: Create `.github/workflows/auto-review-loop.yml`**

```yaml
# Workflow B: Codex レビュー受信 + Claude 修正ループ
# Spec: docs/architecture/event-design.md#workflow-b
name: Auto Review Loop

on:
  issue_comment:
    types: [created]

# PR ごとに同時実行を防ぐ
concurrency:
  group: pr-${{ github.event.issue.number }}-auto-fix
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  auto-fix:
    # PR コメントかつ Codex bot の総評コメントのみ
    if: >
      github.event.issue.pull_request &&
      (github.event.comment.user.login == vars.CODEX_BOT_LOGIN || github.event.comment.user.login == 'chatgpt-codex-connector[bot]') &&
      (contains(github.event.comment.body, vars.CODEX_REVIEW_MARKER) || contains(github.event.comment.body, 'Codex Review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Get PR info
        id: pr
        run: |
          PR_DATA=$(gh api "/repos/${{ github.repository }}/pulls/${{ github.event.issue.number }}")
          echo "head_ref=$(echo "$PR_DATA" | jq -r '.head.ref')" >> "$GITHUB_OUTPUT"
          echo "head_sha=$(echo "$PR_DATA" | jq -r '.head.sha')" >> "$GITHUB_OUTPUT"
          echo "title=$(echo "$PR_DATA" | jq -r '.title')" >> "$GITHUB_OUTPUT"
          echo "fork=$(echo "$PR_DATA" | jq -r '.head.repo.full_name')" >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Check fork PR (security guard)
        if: steps.pr.outputs.fork != github.repository
        run: |
          echo "::error::Fork PR detected. Auto-review is disabled for fork PRs."
          exit 1

      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.head_ref }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Configure git user for commit
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Install dependencies
        run: npm ci

      - name: Run auto-fix loop
        run: npx tsx src/main-loop.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PR_NUMBER: ${{ github.event.issue.number }}
          PR_HEAD_REF: ${{ steps.pr.outputs.head_ref }}
          PR_TITLE: ${{ steps.pr.outputs.title }}
          TRIGGER_COMMENT_ID: ${{ github.event.comment.id }}
          MAX_REVIEW_ITERATIONS: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}
          DEBOUNCE_SECONDS: ${{ vars.DEBOUNCE_SECONDS || '90' }}
          CHECK_COMMAND: ${{ vars.CHECK_COMMAND || 'npm run check' }}
          MAX_FILES_PER_ITERATION: ${{ vars.MAX_FILES_PER_ITERATION || '10' }}
          MAX_INPUT_TOKENS_PER_FILE: ${{ vars.MAX_INPUT_TOKENS_PER_FILE || '30000' }}
          CODEX_BOT_LOGIN: ${{ vars.CODEX_BOT_LOGIN || 'chatgpt-codex-connector[bot]' }}
          STABILIZE_INTERVAL_SECONDS: ${{ vars.STABILIZE_INTERVAL_SECONDS || '10' }}
          STABILIZE_COUNT: ${{ vars.STABILIZE_COUNT || '3' }}
          CODEX_REVIEW_MARKER: ${{ vars.CODEX_REVIEW_MARKER || 'Codex Review' }}

      # PoC: Codex インラインコメントの原文を Artifact として保存（パーサー検証用）
      - name: Save Codex comments as artifact
        if: always()
        run: |
          mkdir -p artifacts
          gh api "/repos/${{ github.repository }}/pulls/${{ github.event.issue.number }}/comments" \
            --paginate --jq '.[]' | jq -s '.' > artifacts/review-comments.json || true
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: codex-comments-${{ github.event.issue.number }}-${{ github.run_number }}
          path: artifacts/
          retention-days: 30
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main-loop.ts .github/workflows/auto-review-loop.yml
git commit -m "feat: add Workflow B (auto-review-loop) with full Phase 1-4 implementation"
```

---

## Task 14: Integration Test — Workflow B Phase 1

**Files:**
- Create: `tests/integration/workflow-b-phase1.test.ts`

**Spec reference:** [テスト戦略 §統合テスト](../../testing/test-strategy.md#統合テスト推奨)

モック Codex コメントを使い、Phase 1（レビュー受信・集約）の一連の流れを検証する。

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration/workflow-b-phase1.test.ts
import { describe, it, expect } from "vitest";
import { filterAndParseComments } from "../../src/review-collector.js";
import { computeFindingsHash } from "../../src/findings-hash.js";
import { isLoop } from "../../src/loop-detector.js";
import type { RawReviewComment, FindingsHashEntry } from "../../src/types.js";

describe("Workflow B Phase 1: review collection → findings → loop check", () => {
  const codexBot = "chatgpt-codex-connector[bot]";

  // 実際の Codex コメント形式をシミュレート
  const mockComments: RawReviewComment[] = [
    {
      id: 100,
      user: { login: codexBot },
      body: "[P0] Token refresh path can bypass expiry validation\n\nThe token refresh logic skips expiry check when the token is marked as 'auto-renew'. This allows expired sessions to persist indefinitely.\n\nUseful? React with 👍 / 👎.",
      path: "src/auth/session.ts",
      line: 84,
      createdAt: "2026-03-20T11:05:00Z",
    },
    {
      id: 101,
      user: { login: codexBot },
      body: "P1 Unauthenticated requests reach protected handler\n\nUnder the else branch, requests without a valid session cookie are forwarded to the protected handler without any check.\n\nUseful? React with 👍 / 👎.",
      path: "src/auth/middleware.ts",
      line: 42,
      createdAt: "2026-03-20T11:05:30Z",
    },
    {
      id: 102,
      user: { login: codexBot },
      body: "P2 Consider using const instead of let\n\nMinor style suggestion.\n\nUseful? React with 👍 / 👎.",
      path: "src/utils.ts",
      line: 10,
      createdAt: "2026-03-20T11:06:00Z",
    },
    {
      id: 103,
      user: { login: "human-reviewer" },
      body: "P0 This looks wrong to me",
      path: "src/app.ts",
      line: 5,
      createdAt: "2026-03-20T11:07:00Z",
    },
  ];

  it("extracts only P0/P1 findings from Codex bot, ignoring P2 and humans", () => {
    const findings = filterAndParseComments(mockComments, codexBot, null);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].path).toBe("src/auth/session.ts");
    expect(findings[0].title).toBe("Token refresh path can bypass expiry validation");
    expect(findings[0].body).not.toContain("Useful?");
    expect(findings[1].severity).toBe("P1");
  });

  it("filters by time when lastReceivedAt is provided", () => {
    const findings = filterAndParseComments(
      mockComments, codexBot, "2026-03-20T11:05:15Z",
    );
    // Only the P1 comment at 11:05:30 passes the time filter
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
  });

  it("computes hash and detects no loop on first iteration", () => {
    const findings = filterAndParseComments(mockComments, codexBot, null);
    const hash = computeFindingsHash(findings);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(isLoop(findings, [])).toBe(false);
  });

  it("detects loop when same findings reappear", () => {
    const findings = filterAndParseComments(mockComments, codexBot, null);
    const hash = computeFindingsHash(findings);
    const history: FindingsHashEntry[] = [{ iteration: 1, hash }];
    expect(isLoop(findings, history)).toBe(true);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/workflow-b-phase1.test.ts
git commit -m "test: add integration test for Workflow B Phase 1 (review collection pipeline)"
```

---

## Task 15: Final Verification & PoC Checklist Alignment

- [ ] **Step 1: Run full check**

Run: `npm run check`
Expected: `tsc --noEmit` PASS + `vitest run` all PASS

- [ ] **Step 2: Verify PoC checklist coverage**

[PoC チェックリスト](../../checklists/poc-checklist.md) の各項目と実装の対応:

| チェック項目 | 実装箇所 |
|-------------|---------|
| Workflow A: hidden comment + `@codex review` | `main-init.ts` + `auto-review-init.yml` |
| Workflow B: レビュー受信 + デバウンス + Claude 修正 + 再レビュー | `main-loop.ts` + `auto-review-loop.yml` |
| Severity パーサー | `severity-parser.ts` + テスト |
| Claude API 呼び出し（`edit_file` tool use） | `claude-fix-engine.ts` |
| `edit_file` 適用ロジック | `edit-applier.ts` + テスト |
| `CHECK_COMMAND` + ロールバック | `check-runner.ts` |
| hidden comment 状態管理 | `state-manager.ts` + テスト |
| `MAX_REVIEW_ITERATIONS` 停止制御 | `main-loop.ts` Phase 2 |
| ループ検知 | `loop-detector.ts` + `findings-hash.ts` + テスト |
| Fork PR 起動防止 | 両 workflow の `if` 条件 + security guard step |

- [ ] **Step 3: Commit final state**

未コミットのファイルがあれば個別に `git add` してコミットする。`git add -A` は使わない（意図しないファイルの混入を防ぐ）。

---

## Implementation Notes

### PoC で妥協する点（`TODO(phase:prototype)` として記録）

1. **デバウンス:** `sleep` 方式。本番では `workflow_dispatch` + 外部スケジューラを検討
2. **hidden comment の競合:** `concurrency` 制御のみ。本番では楽観ロック
3. **クロスファイル修正:** ファイル単位で閉じた修正のみ。跨がる場合は PR コメントで手動対応を報告
4. **トークン数推定:** `MAX_INPUT_TOKENS_PER_FILE` は文字数ベースの概算（1 token ≈ 4 chars）。本番では `tiktoken` 等を使用
5. **セーフガード（件数安定方式）:** 未実装。PoC で Codex のコメント投稿順序を確認後に必要性を判断

### Repository Variables の事前設定

GitHub リポジトリの Settings → Variables → Actions で以下を設定すること:

- `CODEX_BOT_LOGIN`: `chatgpt-codex-connector[bot]`
- `CODEX_REVIEW_MARKER`: `Codex Review`

**未設定時のリスク:** `contains(any_string, '')` は常に true を返すため、全コメントで Workflow B が起動する。

### Repository Secrets の事前設定

- `ANTHROPIC_API_KEY`: Anthropic API キー
