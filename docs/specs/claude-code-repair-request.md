# Claude Code repair request 仕様

> Codex の findings を `anthropics/claude-code-action@v1` に渡す repo-level repair request / prompt の生成仕様。

このモジュールは **request builder / serializer のみ** を担う pure module であり、GitHub Actions の workflow 統合、Claude Code Action の実行、commit/push などの副作用は対象外である。workflow 統合は <issue id="6e907267-a4ce-4639-8172-7260d5b1199a">TY-236</issue> で扱う。

## 位置づけ

従来の `src/claude-fix-engine.ts` は Claude API の `edit_file` ツールで **単一ファイル単位** の修正を行う方式だった。<issue id="ed2b6617-9c7a-46eb-8afd-da2a451b8a79">TY-234</issue> で repo-level repair executor は `anthropics/claude-code-action@v1` を採用する方針に決定したため、Codex finding を **「修正範囲」ではなく「調査開始点（entry point）」** として扱う新しい payload が必要になった。

このドキュメントは `src/claude-code-repair-request.ts` の役割と shape をまとめる。

## 設計原則

- **entry point only**: finding の `path` / `line` は調査開始点にすぎない。Claude Code は関連ファイル、呼び出し元、型定義、テスト、設定まで探索して必要な最小修正を行う。
- **deterministic payload**: 同じ入力から常に同じ JSON が得られるよう、findings は `(severity, path, line, title, body)` で安定ソートする。これにより fixture スナップショットを利用できる。
- **pure**: ネットワーク I/O や filesystem 副作用を持たない。
- **workflow 側でも CHECK_COMMAND を最終検証**: Claude Code に CHECK_COMMAND の通過を要求するが、workflow 側でも最終 CHECK_COMMAND を必ず実行する前提でプロンプトを書く。

## Request の shape

```ts
export interface ClaudeCodeRepairRequest {
  version: 1;
  pr: {
    number: number;
    title: string;
    branch: string;
    headSha: string | null;
  };
  execution: {
    iteration: number;
    maxIterations: number;
    checkCommand: string;
    previousCheckFailure: string | null;
  };
  findings: ClaudeCodeRepairFinding[];
  instructions: string;
}

export interface ClaudeCodeRepairFinding {
  severity: "P0" | "P1" | "P2";
  path: string;
  line: number;
  title: string;
  body: string;
  entryPointOnly: true;
}
```

- `pr.headSha` は本チケットの時点では `null` 許容。TY-236 の workflow 統合で GitHub event / checkout 結果から実値を渡す。
- `execution.previousCheckFailure` は初回 repair では `null`。CHECK_COMMAND 失敗 output を次回 repair の追加コンテキストとして渡す場合に利用する。長すぎる出力は `truncatePreviousCheckFailure()` で安全に短縮する（既定 20,000 chars、tail 保持）。
- `instructions` には Claude Code に守らせる行動制約を embed する（後述）。

## Builder API

`src/claude-code-repair-request.ts` から以下を export する。

```ts
buildClaudeCodeRepairRequest(input): ClaudeCodeRepairRequest
buildClaudeCodeRepairPrompt(request): string
serializeClaudeCodeRepairRequest(request): string
truncatePreviousCheckFailure(output, maxChars?): string
```

`buildClaudeCodeRepairRequest()` の入力は `PrContext`、`Finding[]`、`iteration` / `maxIterations`、`checkCommand`、optional `headSha`、optional `previousCheckFailure`。`Finding` には `suggestion` を追加しない（必要になれば parser 側で別チケット化）。

## Prompt に必ず含める内容

`buildClaudeCodeRepairPrompt()` の出力には少なくとも次を明記する。テスト（`tests/claude-code-repair-request.test.ts`）がこれを正規表現で検証する。

- Codex finding の `path` / `line` は **修正範囲ではなく調査開始点（investigation entry point）** である。
- 関連ファイル（callers）、呼び出し元、型定義、テスト、設定を必要に応じて読んでよい。
- 既存テストを仕様として扱う（treat existing tests as the specification）。
- 型エラー、テスト失敗、呼び出し元不整合があれば関連箇所を調査して直す。
- 変更は最小限（minimal change）。unrelated refactor をしない。
- secrets を読まない / 出力しない。
- network access を前提にしない。
- 任意 shell を実行しない（only the configured CHECK_COMMAND）。
- 最終的に CHECK_COMMAND が通る状態にする。**workflow 側でも final CHECK_COMMAND を必ず実行する** ので、検証可能な状態でツリーを残す。

`previousCheckFailure` が与えられた場合のみ、prompt 末尾に "Previous CHECK_COMMAND Failure" セクションを追加する。

## 過去知見の取り込み

- <issue id="9a461f27-1b6f-4cb8-add1-2af5922eb846">TY-230</issue>（自前 Claude repair agent loop、不採用）から: CHECK_COMMAND 出力を修正入力に含める、既存テストを仕様として扱う、関連ファイル探索を許可する、という 3 点を prompt に反映している。
- <issue id="2922d9cf-1e69-4c41-b0a3-3863a9d1cc21">TY-225</issue>: prompt 改善内容は本チケットへ吸収済み。

## 非対象（再掲）

- `anthropics/claude-code-action@v1` の workflow 統合本体（TY-236）
- GitHub Actions workflow permissions の最終設計
- 実際の Claude Code 実行 / PR 作成 / commit / rollback / push
- Codex severity parser の全面刷新
- `Finding` への `suggestion` 追加
- `headSha` を workflow から取得して渡す処理
- `claude-code-base-action` 導入
- 自前 Claude repair agent loop の導入

## 関連ドキュメント

- [Claude 修正エンジン仕様](claude-fix-engine.md) — 旧 `edit_file` 方式の仕様。本ドキュメントは後継。
- [Severity パーサー仕様](severity-parser.md) — findings 抽出
- [全ドキュメント索引](../README.md)
