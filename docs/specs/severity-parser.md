# Severity パーサー仕様

> **このドキュメントは設計全体の前提知識である。** Codex のレビュー形式を理解した上で他のドキュメントを読むこと。

## Codex のレビュー形式

Bot 名: **`chatgpt-codex-connector[bot]`**（環境変数 `CODEX_BOT_LOGIN` で変更可能）

Codex のレビューは以下の2種類のコメントで構成され、**それぞれ異なる GitHub API で投稿される**。

### 1. 総評レビュー / 総評コメント

```
💡 Codex Review

Here are some automated review suggestions for this pull request.

▶ ℹ️ About Codex in GitHub
```

- 指摘の詳細は含まれない。レビューが行われたことの通知的な役割
- PR #4 の実測では **`pull_request_review`（action: `submitted`）** として到達した
- 旧推定・互換経路として **`issue_comment`（action: `created`）** の総評コメントも許可する

### 2. インラインコメント（コード行に紐づく）

```
[P1] Base exits on bar closes instead of intrabar extremes

The exit logic triggers TP/SL whenever the 1m high/low crosses the levels ...
（詳細な説明）

Useful? React with 👍 / 👎.
```

- **GitHub API:** `POST /repos/{owner}/{repo}/pulls/{number}/comments`（Pull Request Review Comment API）
- **発火するイベント:** `pull_request_review_comment`（action: `created`）
- **1件ごとに個別に投稿される**（バッチではない）。複数の指摘がある場合、複数のイベントが順次発火する

**インラインコメントの構造:**
- 先頭に severity バッジ: `P0` `P1` `P2` 等
- バッジの後にタイトル（太字の場合がある）
- 改行後に詳細な指摘内容
- 末尾に `Useful? React with 👍 / 👎.`

**設計への影響:**
- [Workflow B](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正loop-pilotyml) の主トリガーは **`pull_request_review.submitted`** とする。実測で Codex の総評がこのイベントとして到達したため
- 互換用に `issue_comment.created` の総評コメントも受け付ける
- Claude に渡すのはインラインコメントのみ。trigger 検知後に GitHub API で PR の review comments を一括取得する

> **実測:** PR #4 では `chatgpt-codex-connector[bot]` が `pull_request_review` と inline `pull_request_review_comment` を投稿した。`issue_comment` のみをトリガーにすると Workflow B が起動しない。

---

## 対象 severity

パーサーは **P0 / P1 / P2 / P3** を識別する（TY-256）。実際に修正対象とする範囲は `LOOPPILOT_SEVERITY_THRESHOLD`（default `P3`）で制御する。

- `LOOPPILOT_SEVERITY_THRESHOLD=P3`（既定）: P0 / P1 / P2 / P3 すべてを対象
- `LOOPPILOT_SEVERITY_THRESHOLD=P2`: P0 / P1 / P2 を修正対象、P3 を skip（旧挙動互換）
- `LOOPPILOT_SEVERITY_THRESHOLD=P1`: P0 / P1 のみ、P2 / P3 を skip
- `LOOPPILOT_SEVERITY_THRESHOLD=P0`: P0 のみ

不正値は warning ログを出して default (`P3`) にフォールバックする。

severity を skip した件数は observability ログで出力する（`unparseable` / `belowThreshold` に分離）。詳細は [event-design.md Phase 1](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正loop-pilotyml) を参照。

---

## Severity の抽出ルール

Codex のインラインコメントの先頭にある severity バッジを正規表現で抽出する。

### 前処理

- GitHub API から取得した `body` フィールドに対し、**先頭の空白・改行を除去（strip）してから**正規表現を適用する。GitHub API のレスポンスで先頭に `\n` や空行が含まれるケースがあり、`^` アンカーが意図通りマッチしなくなるため

### 抽出パターン（段階的マッチング）

```regex
# Stage 1: 角括弧付き or 裸のバッジ（現在の確認済み形式）
^\s*\[?(P[0-3])\]?\s*(.+)

# Stage 2: Markdown 太字（Codex がフォーマット変更した場合の備え）
^\s*(?:\*{2})?\[?(P[0-3])\]?(?:\*{2})?\s*(.+)

# Stage 3: 画像バッジ（Codex の現行形式）
!\[(P[0-3])\s+Badge\]\([^)]+\)(?:\s*</sub>)*\s*(.+)
```

- **適用前に `body.strip()` を実行すること**（上記「前処理」参照）
- Stage 1 → Stage 2 → Stage 3 の順に試行する
- `P0`, `[P0]`, `**P0**`, `**[P0]**` のいずれにもマッチする
- `[P0]Title`（スペースなし）にもマッチする（`\s+` ではなく `\s*` を使用）
- `*P0*`（Markdown イタリック）には意図的にマッチしない（Codex が使用しない形式を除外）
- 先頭の `P0` / `P1` / `P2` / `P3` を severity として取得（TY-256 で P3 拡張）
- 後続のテキストをタイトルとして取得し、タイトル全体が Markdown 太字（`**...**` または `__...__`）の場合は太字記号を除去する
- 実際に修正対象とする range は `LOOPPILOT_SEVERITY_THRESHOLD` で制御する（上記「対象 severity」参照）

### フォールバック

- 上記いずれにも一致しない場合、コメント本文全体から `P0` `P1` のキーワード出現で判定する（Codex の形式変更に備えた保険）
- フォールバックは **P0 / P1 限定**。P2 / P3 はバッジ無しでは認識しない（プレーンテキスト中の `P2` / `P3` 文字列で誤検知が増えるため、明示タグ必須）
- フォールバックで検知した場合、タイトルはコメント本文の先頭行を使用する
- 先頭行に `No P0/P1 findings` / `no findings` / `0 findings` / `no issues` のような「指摘なし」を示す文がある場合は、本文中に `P0` / `P1` が含まれていても severity なしとして扱う

> **`LOOPPILOT_SEVERITY_THRESHOLD=P3`（既定） / `P2` を使う場合の注意 (TY-268 #23):**
> フォールバックは P2 / P3 を検出しない。Codex がバッジ無し finding を出した場合、severity 不明として `unparseable` カウンタに計上され、auto-fix 対象には残らない。閾値が P2 / P3（既定）の場合、Codex 側で severity badge を必ず付ける review prompt にしておくこと。バッジ無し P2 / P3 を後から拾いたい時は `docs/operations/security.md` の review prompt 設定を見直すか、Codex review 結果を手動でトリアージする。

### Severity 比較ヘルパ

`src/severity-parser.ts` は以下を export する（TY-256）。

- `SEVERITIES`: `readonly ["P0", "P1", "P2", "P3"]`
- `isSeverity(value: string): value is Severity` — type narrowing
- `compareSeverity(a, b)` — urgency 順 (P0 が最も緊急)
- `isAtLeastSeverity(severity, threshold)` — `severity` を threshold 以上として残すか判定する filter helper

### Regression fixture

Codex inline comment body の回帰テスト fixture は `tests/fixtures/codex-inline-comments.json` に保存する。fixture には以下を含める。

- P0 / P1 / P2 / P3 各 severity のバッジ付き finding 例 (parser が認識する全 tier をカバー)
- `P0` / `P1` という語を含むが非対象の総評・説明文 (fallback 経路の誤検知防止)
- Codex footer `Useful? React with 👍 / 👎.` を含む本文

fixture を追加する場合は、secret、private repo 固有のファイルパス、顧客名などを削除または匿名化する。GitHub Actions の artifact から取得する場合は、該当 run の `codex-comments-<pr-number>-<run-number>` artifact に含まれる `review-comments.json` の `body` を使う。

---

## PoC での必須検証事項

- 実際の Codex インラインコメントの原文を取得し、上記正規表現でパースできることを確認する
- GitHub API のレスポンス（`body` フィールド）を保存し、必要に応じて匿名化してパーサーのテストケースとする

> **推奨:** PoC 段階で Codex のインラインコメント原文を GitHub Actions Artifact として保存するステップを追加する。Codex 側のフォーマット変更時に過去の原文と比較でき、パーサー修正のデバッグが大幅に容易になる。

---

## 関連ドキュメント

- [テスト戦略](../testing/test-strategy.md#1-severity-パーサー) — パーサーのテストケース一覧
- [イベント設計](../architecture/event-design.md) — コメント取得フィルタの詳細
- [全ドキュメント索引](../README.md)
