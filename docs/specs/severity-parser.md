# Severity パーサー仕様

> **このドキュメントは設計全体の前提知識である。** Codex のレビュー形式を理解した上で他のドキュメントを読むこと。

## Codex のレビュー形式

Bot 名: **`chatgpt-codex-connector[bot]`**（環境変数 `CODEX_BOT_LOGIN` で変更可能）

Codex のレビューは以下の2種類のコメントで構成され、**それぞれ異なる GitHub API で投稿される**。

### 1. 総評コメント（PR コメント）

```
💡 Codex Review

Here are some automated review suggestions for this pull request.

▶ ℹ️ About Codex in GitHub
```

- 指摘の詳細は含まれない。レビューが行われたことの通知的な役割
- **GitHub API:** `POST /repos/{owner}/{repo}/issues/{number}/comments`（Issue Comment API）
- **発火するイベント:** `issue_comment`（action: `created`）
- **`pull_request_review` イベントは発火しない**

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
- バッジの後にタイトル（太字）
- 改行後に詳細な指摘内容
- 末尾に `Useful? React with 👍 / 👎.`

**設計への影響:**
- [Workflow B](../architecture/event-design.md#workflow-b-codex-レビュー受信--claude-修正auto-review-loopyml) のトリガーは `pull_request_review.submitted` ではなく **`issue_comment`（総評コメント）** を使う。総評コメントはインラインコメントの後に投稿されるため、全指摘が出揃った後のトリガーとして適切
- Claude に渡すのはインラインコメントのみ。総評コメント検知後に GitHub API で PR の review comments を一括取得する

> **注意:** 上記は OpenAI Cookbook・Codex Action のソースコードに基づく推定。PoC で `chatgpt-codex-connector[bot]` の実際のイベント発行パターンを必ず確認すること。

---

## 対象 severity

今回拾うのは以下のみ。

- P0
- P1

P2 は対象外。

---

## Severity の抽出ルール

Codex のインラインコメントの先頭にある severity バッジを正規表現で抽出する。

### 前処理

- GitHub API から取得した `body` フィールドに対し、**先頭の空白・改行を除去（strip）してから**正規表現を適用する。GitHub API のレスポンスで先頭に `\n` や空行が含まれるケースがあり、`^` アンカーが意図通りマッチしなくなるため

### 抽出パターン（段階的マッチング）

```regex
# Stage 1: 角括弧付き or 裸のバッジ（現在の確認済み形式）
^\s*\[?(P[0-2])\]?\s*(.+)

# Stage 2: Markdown 太字（Codex がフォーマット変更した場合の備え）
^\s*(?:\*{2})?\[?(P[0-2])\]?(?:\*{2})?\s*(.+)
```

- **適用前に `body.strip()` を実行すること**（上記「前処理」参照）
- Stage 1 を先に試行し、一致しなければ Stage 2 を試行する
- `P0`, `[P0]`, `**P0**`, `**[P0]**` のいずれにもマッチする
- `[P0]Title`（スペースなし）にもマッチする（`\s+` ではなく `\s*` を使用）
- `*P0*`（Markdown イタリック）には意図的にマッチしない（Codex が使用しない形式を除外）
- 先頭の `P0` / `P1` / `P2` を severity として取得
- 後続のテキストをタイトルとして取得
- `P0` / `P1` のみを修正対象とし、`P2` は無視する

### フォールバック

- 上記いずれにも一致しない場合、コメント本文全体から `P0` `P1` のキーワード出現で判定する（Codex の形式変更に備えた保険）
- フォールバックで検知した場合、タイトルはコメント本文の先頭行を使用する

---

## PoC での必須検証事項

- 実際の Codex インラインコメントの原文を取得し、上記正規表現でパースできることを確認する
- GitHub API のレスポンス（`body` フィールド）をそのまま保存して、パーサーのテストケースとする

> **推奨:** PoC 段階で Codex のインラインコメント原文を GitHub Actions Artifact として保存するステップを追加する。Codex 側のフォーマット変更時に過去の原文と比較でき、パーサー修正のデバッグが大幅に容易になる。

---

## 関連ドキュメント

- [テスト戦略](../testing/test-strategy.md#1-severity-パーサー) — パーサーのテストケース一覧
- [イベント設計](../architecture/event-design.md) — コメント取得フィルタの詳細
- [全ドキュメント索引](../README.md)
