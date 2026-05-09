# Claude 修正エンジン仕様

## モデル

- **Claude Opus** を使用。バグ修正には深い思考が必要なため、最も推論能力の高いモデルを選択する
- API キーは GitHub Actions の Repository secrets に `ANTHROPIC_API_KEY` として保存し、`${{ secrets.ANTHROPIC_API_KEY }}` で参照する

---

## コスト概算（Claude Opus 4, 2026年3月時点）

| 項目 | 標準ケース | ワーストケース |
|------|-----------|---------------|
| 入力トークン単価 | $15 / 1M tokens | 同左 |
| 出力トークン単価 | $75 / 1M tokens | 同左 |
| 1ファイルあたり入力 | ~3,500 tokens（100-200行のファイル + system/user prompt ~800 tokens + findings ~700 tokens） | ~10,000 tokens（500行超のファイル + 複数 findings + prompt） |
| 1ファイルあたり出力 | ~500 tokens（edit_file 1-2回） | ~2,000 tokens（edit_file 5回以上 + 再試行） |
| 対象ファイル数 / iteration | 5 ファイル | 10 ファイル（`MAX_FILES_PER_ITERATION` 上限） |
| 1 iteration | 入力: ~17.5K ($0.26) + 出力: ~2.5K ($0.19) ≈ **$0.45** | 入力: ~100K ($1.50) + 出力: ~20K ($1.50) ≈ **$3.00** |
| 20 iterations（上限） | ≈ **$9.00** | ≈ **$60.00** |

> `MAX_REVIEW_ITERATIONS` の適正値はこのコスト見積もりを基に判断すること。ワーストケースが現実的なプロジェクトでは、上限を 10 以下に設定するか、1 iteration あたりのコスト上限（例: $5）を設けて超過時に停止する仕組みを検討する。
>
> **注意:** 上記概算には tool 定義のトークン（~200-300 tokens / 呼び出し）は含まれていない（影響軽微）。ただし、extended thinking を有効にした場合は thinking トークンが追加課金対象となり、コストが大幅に増加する可能性がある。また、GitHub Actions ランナーのコスト（Linux: $0.008/min）も別途発生する。`DEBOUNCE_SECONDS=90` の sleep 中もランナー課金が発生するため、20 iteration × 90秒 ≈ 30分のアイドル時間で約 $0.24 が加算される。

### コスト暴走防止策

| 制御 | 説明 | デフォルト |
|------|------|-----------|
| `MAX_REVIEW_ITERATIONS` | 最大往復回数 | `20` |
| `MAX_FILES_PER_ITERATION` | 1 iteration あたりの最大対象ファイル数 | `10` |
| `MAX_INPUT_TOKENS_PER_FILE` | 1 ファイルあたりの入力トークン上限 | `30000` |

- **`MAX_INPUT_TOKENS_PER_FILE`:** ファイル内容 + findings + prompt の合計トークン数がこの上限を超える場合、そのファイルの修正をスキップし、PR コメントに「ファイルが大きすぎるため手動対応が必要」として報告する。トークン数は API 呼び出し前に `tiktoken` 等のトークナイザーで概算する（厳密な一致は不要。概算値が上限の 90% を超えたらスキップする）
- **複数 PR 同時実行時のコスト:** 上記制御は PR 単位であり、複数 PR が同時に走った場合の合算コストは制御されない。本番移植時には、Organization レベルでの Anthropic API 利用量モニタリング（Anthropic Console の Usage ダッシュボード）や、API キーに spending limit を設定することを推奨する

**PoC 実装状況:** `MAX_INPUT_TOKENS_PER_FILE` は文字数ベースの概算（`fileContent.length / 4`）で実装済み。上限超過ファイルは chunking せず、その iteration ではスキップして手動対応対象にする。本番移植時は対象プロジェクトのファイルサイズに応じて tokenizer ベースの概算または chunking を検討する。

---

## 起動方法

- GitHub Actions の step 内で、**Anthropic SDK（Python or Node.js）** を使って Claude API を呼び出す
- 整形済みの findings JSON をプロンプトに埋め込む

---

## 応答適用方式: tool use（function calling）

Claude にファイル編集用のツールを定義し、構造化された edit 操作を返させる。指摘事項への正確な対応を優先するため、自由形式の出力ではなく tool use を採用する。

### edit_file ツール定義

```json
{
  "name": "edit_file",
  "description": "Replace a specific code section in a file",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File path to edit" },
      "old_code": { "type": "string", "description": "Exact code to replace" },
      "new_code": { "type": "string", "description": "Replacement code" },
      "explanation": { "type": "string", "description": "Why this change fixes the finding" }
    },
    "required": ["path", "old_code", "new_code", "explanation"],
    "additionalProperties": false
  },
  "strict": true
}
```

- Claude には finding を1件ずつ渡す。複数 finding を1 request にまとめない
- Claude は対象 finding に対して1回以上の `edit_file` ツール呼び出しを返す
- Anthropic strict tool schema に合わせ、`input_schema` には `additionalProperties: false` を必ず含める
- `old_code` の完全一致でファイル内の置換箇所を特定するため、行番号ズレの影響を受けない
- `explanation` により、各変更の根拠を PR コメントに転記できる

### ツールの制約

- `edit_file` ツールは**置換のみ**をサポートする。ファイルの新規作成・削除・リネームは行わない。Claude にファイル削除権限を与えないことで、意図しないファイル消失を防ぐ
- 新規ファイルの作成が必要な修正（例: テストファイルの追加）は、PR コメントに「手動対応が必要」として報告する

---

## edit 適用ロジック

### 空白正規化マッチング

LLM の出力は trailing whitespace や改行コードの差異が発生しうるため、完全一致で見つからない場合は空白を正規化して再試行する（trailing whitespace の除去、`\r\n` → `\n` の統一）。正規化マッチで見つかった場合、ログに info を出力する（`"Matched old_code after whitespace normalization in {path}"`）

### 複数マッチ時の挙動

`old_code` がファイル内に複数回出現する場合は、**finding の `line` に最も近いマッチのみを置換する**。置換後、ログに warning を出力する（`"Multiple matches found for old_code in {path}, replaced nearest to line {line}"`）。これにより、同一パターンの誤置換を防ぐ

### edit 適用順序

1つの finding に対して複数の `edit_file` が返された場合、**ファイル末尾側の edit から逆順に適用する**。先頭側の edit を先に適用すると行数の増減により後続 edit の `old_code` マッチ位置がズレるためである。Codex が報告する `line` はレビュー時点の行番号であり、先行する edit による行数変動を反映しないことに注意

### edit 間の依存関係

各 finding の edit はメモリ上の最新ファイル内容へ順次適用する。同一ファイルに複数 finding がある場合、後続 finding の Claude request には前の finding の edit 適用後の内容を渡す。これにより、同一ファイル内で `old_code` が古い内容を参照して不一致になる可能性を下げる。

### 置換対象が見つからない場合の段階的フォールバック

1. **部分適用:** 同一 finding 内で一部の edit だけが適用可能な場合、適用できた edit はメモリ上の最新内容へ反映し、適用できなかった edit は skipped/manual として記録する
2. **スキップ:** `old_code` が一致しない、Claude が text-only で返した、API エラーになったなど、その finding を安全に修正できない場合は skipped/manual として PR の fix summary に明示する
3. **一括書き込み:** ファイルへの書き込みは selected findings の処理後にまとめて行う。少なくとも1件の edit が適用できた場合のみ `CHECK_COMMAND` を実行し、成功時は 1 iteration / 1 commit に集約する。全 finding が修正不能な場合のみ `stopped` にする

---

## 大量の findings・大きなファイルへの対応

- findings をファイル単位でグループ化して `MAX_FILES_PER_ITERATION` の対象ファイルを決めた後、選択された findings を severity 順（P0 → P1 → P2）に並べて **finding ごとに API を呼び出す**
- 各呼び出しでは、対象ファイルの最新メモリ上内容 + 単一 finding のみを送信する
- これにより、1回あたりのコンテキストを抑えつつ、ファイル内の文脈を十分に与えられる
- **クロスファイル修正の制約（PoC）:** 1つの finding が複数ファイルにまたがる修正を要求するケース（例: 関数シグネチャ変更 + 呼び出し側の修正）には対応しない。PoC 段階では **finding の対象ファイル内で閉じた修正のみ対応** し、クロスファイル修正が必要な finding は PR コメントに「手動対応が必要」として報告する。本番移植時には、依存関係のあるファイルを同一 finding request に含める仕組みを検討する
- **ファイル数上限:** 1 iteration あたりの対象ファイル数が `MAX_FILES_PER_ITERATION`（デフォルト: 10）を超える場合、以下の優先順位で対象ファイルを選択する:
  1. P0 findings を含むファイル（P0 と P1/P2 が混在するファイルもこのグループに含める）
  2. P1 findings を含むファイル
  3. P2 のみのファイル
  4. 同一グループ内では findings 数が多いファイルを優先する
  - P0 ファイルだけで上限を超える場合も上記ルールに従い、超過分は次の iteration に持ち越す
  - 超過が発生した旨と、持ち越したファイルの一覧を PR コメントに報告する。これにより、大量の findings がある場合のコスト暴走を防ぐ

PR #7 の E2E では対象が小さな単一ファイルだったため、large file skip、ファイル数上限、cross-file finding は実測していない。

---

## Claude API エラー時のリトライ戦略

| エラー種別 | リトライ | バックオフ | 最大回数 |
|-----------|---------|-----------|---------|
| 429 Rate Limit | する | exponential（初回 30秒、最大 5分） | 3回 |
| 500 / 502 / 503 | する | exponential（初回 10秒、最大 2分） | 3回 |
| タイムアウト | する | 固定 30秒 | 2回 |
| 400 Bad Request | しない | — | — |
| その他 4xx | しない | — | — |

- リトライは **finding 単位** で行う。finding A の API 呼び出しが失敗しても、finding B の処理は独立して続行する
- **全 finding 失敗** した場合: `status: stopped`, `stop_reason: claude_api_error` で停止
- **一部 finding 成功** した場合: 成功した edit のみ適用し、失敗した finding は PR コメントに skipped/manual として報告する。commit / push は成功分のみで行い、次の iteration で残りを再試行する機会を与える

---

## Claude に渡す入力形式

Claude には GitHub の生 payload ではなく、整形済みのレビュー情報を渡す。

例:

```json
{
  "pr": {
    "number": 128,
    "title": "fix session expiry bug",
    "branch": "fix/session-expiry"
  },
  "iteration": 4,
  "max_iterations": 20,
  "codex_review": {
    "review_id": 987654321,
    "findings": [
      {
        "severity": "P0",
        "path": "src/auth/session.ts",
        "line": 84,
        "title": "Token refresh path can bypass expiry validation",
        "body": "The token refresh logic skips expiry check when ..."
      },
      {
        "severity": "P1",
        "path": "src/auth/middleware.ts",
        "line": 42,
        "title": "Unauthenticated requests reach protected handler",
        "body": "Under the else branch, requests without a valid session ..."
      }
    ]
  }
}
```

**フィールド補足:**
- `summary` は削除。Codex の総評コメントには具体的な指摘が含まれないため、自動生成する意味が薄い。findings の一覧自体が Claude にとって十分な情報
- `title` を追加。Codex インラインコメントの severity バッジ直後のタイトル部分を格納。Claude が指摘の概要を素早く把握できる
- `body` は Codex インラインコメントの詳細説明部分（タイトル以降）を格納
- `max_iterations` を追加。Claude に残りの修正回数を意識させ、効率的な修正を促す

---

## Claude への指示方針

Claude には次の制約を明示する。

- P0 / P1 / P2 のみ修正する
- 無関係なリファクタをしない
- public API を不要に変えない
- 既存挙動を壊さない
- 修正後に test / lint / typecheck を実行する
- 安全に修正できない場合は停止して理由をコメントする
- 成功時のみ commit / push する

**自動投稿されるコメント・コミットメッセージの言語:** すべて **英語** で統一する。このドキュメント自体は日本語だが、GitHub 上のコメント（完了報告・エラー報告・修正要約等）およびコミットメッセージは英語とする。

### プロンプトテンプレート

以下のテンプレートに findings JSON と対象ファイルの内容を埋め込んで Claude API に送信する。

**システムプロンプト:**

```text
You are a senior software engineer fixing code review findings on a pull request.
You will receive one Codex review finding (P0/P1/P2 severity) and the source file content.
Use the edit_file tool to make precise, minimal fixes for that finding.

Rules:
- Fix ONLY the listed P0/P1/P2 finding. Do not fix anything else.
- Do not perform unrelated refactors, style changes, or improvements.
- Do not change public APIs unless strictly necessary to fix a finding.
- Preserve existing behavior outside the scope of each finding.
- Each edit_file call must include an explanation of why the change fixes the finding.
- If a finding cannot be fixed safely without risking breakage, do NOT edit the file.
  Instead, respond with a text message explaining why the fix is unsafe.
- You will be told the current iteration number and max iterations.
  If fewer than 3 iterations remain, prefer conservative, minimal fixes over ambitious rewrites.
  Prioritize P0 findings over P1, then P2 when iteration budget is limited.
```

**ユーザープロンプト（finding 単位で呼び出し）:**

````text
## PR Context
- PR #{pr_number}: {pr_title}
- Branch: {branch}
- Iteration: {iteration} / {max_iterations}

## Target File
Path: {file_path}

```{language}
{file_content}
```

## Finding to Fix
{findings_json}

Fix the finding above using the edit_file tool.
````

`{findings_json}` には対象 finding 1件のみを配列として埋め込む:

```json
[
  {
    "severity": "P0",
    "line": 84,
    "title": "Token refresh path can bypass expiry validation",
    "body": "The token refresh logic skips expiry check when ..."
  }
]
```

---

## 関連ドキュメント

- [検証コマンドとロールバック](../operations/check-and-rollback.md) — edit 適用後の検証
- [Severity パーサー仕様](severity-parser.md) — findings 抽出
- [ループ検知](loop-detection.md) — findings ハッシュ
- [推奨フローと状態管理](../architecture/flow-and-state.md) — フロー全体での位置づけ
- [全ドキュメント索引](../README.md)
