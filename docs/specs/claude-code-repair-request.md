# Claude Code repair request 仕様

> Codex の findings を `anthropics/claude-code-action@v1` に渡す repo-level repair request / prompt の生成仕様。

このモジュールは **request builder / serializer のみ** を担う pure module であり、GitHub Actions の workflow 統合、Claude Code Action の実行、commit/push などの副作用は対象外である。

## 位置づけ

従来の `src/claude-fix-engine.ts` は Claude API の `edit_file` ツールで **単一ファイル単位** の修正を行う方式だった。repo-level repair executor は `anthropics/claude-code-action@v1` を採用しており、Codex finding を **「修正範囲」ではなく「調査開始点（entry point）」** として扱う payload を生成する。

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
    findingsTruncated: {
      received: number;
      embedded: number;
      droppedFindingChars: number;
      truncatedBodyChars: number;
    };
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

- `pr.headSha` は `null` 許容。workflow 統合では GitHub event / checkout 結果から実値を渡す。
- `execution.previousCheckFailure` は初回 repair では `null`。CHECK_COMMAND 失敗 output を次回 repair の追加コンテキストとして渡す場合に利用する。長すぎる出力は `truncatePreviousCheckFailure()` で安全に短縮する（既定 20,000 chars、head 25% + tail 75% の **head + tail 方式**）。
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

## Findings の上限と truncation

`buildClaudeCodeRepairRequest()` は payload に embed する findings に対し以下の 2 つの cap を適用する。

### 定数

* `MAX_FINDINGS_PER_REQUEST = 30` — 1 リクエストあたりの findings 件数上限
* `MAX_FINDING_BODY_CHARS = 4_000` — 1 finding の body 文字数上限

### 適用順序

1. `findings.map(toRepairFinding).sort(compareFindings)` で `(severity, path, line, title, body)` 順に sort
2. 上位 `MAX_FINDINGS_PER_REQUEST` 件を `slice` で抽出（件数 cap）
3. 残った各 finding に対し `body` を `MAX_FINDING_BODY_CHARS` で tail-preserve truncation（body cap）
4. **truncation 後に再 sort しない** — body の変更で `compareFindings` の最終 tiebreaker (`body` 辞書順) が動かないようにするため

### Body truncation の挿入場所

body cap は payload 構築段階（`applyFindingCaps` ヘルパー）で適用する。`formatFindingBlock` 側では truncation しない。これにより:

* JSON payload と prompt body の整合性が保たれる
* payload レベルで `ClaudeCodeRepairFinding.body.length <= MAX_FINDING_BODY_CHARS` を不変条件として担保できる

marker フォーマット: `[... truncated N leading characters of finding body; showing tail ...]\n`

### `execution.findingsTruncated`

`ClaudeCodeRepairRequest.execution` には以下の集計フィールドを持つ:

```ts
findingsTruncated: {
  received: number;            // parser から受け取った件数
  embedded: number;            // payload に embed した件数 (= min(received, 30))
  droppedFindingChars: number; // 件数 cap で丸ごと drop した finding の body 文字数合計
  truncatedBodyChars: number;  // body cap で個別に削った文字数合計
}
```

`dropped` と `truncated` の使い分け: 「dropped」= finding 自体が消えた、「truncated」= finding は残ったが body が短くなった。

### Prompt header の表示

`buildClaudeCodeRepairPrompt()` は cap の発生状況を header に反映する:

* cap 未到達: `## Codex Findings (5)`
* 件数 cap 到達: `## Codex Findings (30 of 35 — 5 truncated due to per-request cap)`

### 総プロンプトサイズの worst-case

個別 cap から導かれる worst-case 文字数:

* findings: `30 × 4,000 = 120,000` 文字
* `previousCheckFailure`: 最大 `20,000` 文字
* prompt header / instructions / PR context: 約 `3,000` 文字
* **合計上限: 約 143,000 文字 ≈ 35K token**

Claude 4.6 / 4.7 (200K token context) に対して十分な余裕があり、claude-code-action 側の入力上限抵触リスクは個別 cap の段階で実質排除される。

## CHECK_COMMAND 失敗ログの truncation

`truncatePreviousCheckFailure(output, maxChars?)` は head + tail 方式で `output` を `maxChars` 以下に切り詰める。

- `output.length <= maxChars`: 無加工で返す
- それ以外: 内部定数 `HEAD_RATIO = 0.25` で残り budget を head 25% / tail 75% に配分し、中央を marker で置換する
  - marker フォーマット: `[... truncated N characters from the middle of CHECK_COMMAND output; kept H head + T tail ...]\n`
  - head の末尾が改行で終わっていない場合は、可読性のため marker 直前に `\n` を 1 文字挿入する
- `maxChars` が極小（marker フォーマット長以下）の場合は、tail のみ verbatim を返すフォールバックに切り替える

head 25% の根拠: jest / vitest / pytest は失敗サマリが末尾に固まるため tail を厚めに残す。tsc / eslint --max-warnings 系は最初のエラーが先頭に出るため head にも一定の領域を確保する。50:50 だと tail が痩せ、20:80 だと head が薄すぎる。25:75 がスイートスポット。

cut 位置は **文字単位** で行う（行境界には揃えない）。`result.length <= maxChars` の不変条件を最優先するためで、tsc / jest / linter の出力は前後コンテキストから Claude Code 側が補完できる前提とする。

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

- 不採用となった自前 Claude repair agent loop の検討から、CHECK_COMMAND 出力を修正入力に含める、既存テストを仕様として扱う、関連ファイル探索を許可する、という 3 点を prompt に反映している。

## 非対象（再掲）

- `anthropics/claude-code-action@v1` の workflow 統合本体
- GitHub Actions workflow permissions の最終設計
- 実際の Claude Code 実行 / PR 作成 / commit / rollback / push
- Codex severity parser の全面刷新
- `Finding` への `suggestion` 追加
- `headSha` を workflow から取得して渡す処理
- `claude-code-base-action` 導入
- 自前 Claude repair agent loop の導入

## 関連ドキュメント

- [Severity パーサー仕様](severity-parser.md) — findings 抽出
- [全ドキュメント索引](../README.md)
