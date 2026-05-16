# システム概要

## 目的

Pull Request に対して、以下の自動ループを実現する。

1. PR を作成
2. Codex がレビュー
3. Codex の指摘を Claude に渡す
4. Claude が修正して commit / push
5. Codex が再レビュー
6. P0 / P1 指摘がなくなるまで繰り返す
7. ただし `MAX_REVIEW_ITERATIONS` 回で停止（PoC: 1回、本番: 20回以上を想定）

---

## 本リポジトリの位置づけ

このリポジトリは **PoC（検証用）** である。
まず動作することを確認し、検証済みのロジックを本プロジェクトに移植する。

PR #7 / TY-11 で、同一リポジトリ PR に対する Workflow A/B の主要 E2E は確認済み。残る作業は本番移植前の運用・セキュリティ・コスト判断であり、[本番移植チェックリスト](../checklists/production-migration.md) に集約する。

したがって:
- 動作確認を優先する
- 過度な堅牢性・最適化は後回しでよい
- ただし、本番移植時に設計変更が必要になるような判断は避ける

---

## 基本方針

- **Codex はレビュー専任**
- **Claude は修正専任**
- 再レビューは push 自動連動ではなく、**明示的に `@codex review` を起動**
- Claude に渡す単位は **1 コメント単位ではなく「最新の Codex review 一式」**
- 修正対象は **P0 / P1 のみ**
- **最大往復回数は環境変数 `MAX_REVIEW_ITERATIONS` で制御**（デフォルト: 20）
- **Codex レビュー受信後、一定時間待機してから Claude に渡す**

---

## 設定可能なパラメータ

| 環境変数 | 説明 | デフォルト | PoC 値 |
|----------|------|-----------|--------|
| `MAX_REVIEW_ITERATIONS` | 最大往復回数 | `20` | `1` |
| `DEBOUNCE_SECONDS` | レビュー受信後の待機時間（秒） | `90` | `90` |
| `CHECK_COMMAND` | 修正後に実行する検証コマンド | `npm run check` | `npm run check` |
| `MAX_FILES_PER_ITERATION` | 1 iteration あたりの最大対象ファイル数 | `10` | `10` |
| `MAX_INPUT_TOKENS_PER_FILE` | 1 ファイルあたりの入力トークン上限 | `30000` | `30000` |
| `CODEX_BOT_LOGIN` | Codex bot のログイン名 | `chatgpt-codex-connector[bot]` | `chatgpt-codex-connector[bot]` |
| `STABILIZE_INTERVAL_SECONDS` | セーフガードのポーリング間隔（秒） | `10` | `10` |
| `STABILIZE_COUNT` | コメント数安定と判定する連続一致回数 | `3` | `3` |
| `CODEX_REVIEW_MARKER` | Codex 総評レビュー/コメントの検知文言 | `Codex Review` | `Codex Review` |
| `CODEX_REVIEW_REQUEST_TOKEN` | `@codex review` 投稿専用の接続済みユーザー PAT。未設定時は `GITHUB_TOKEN` に fallback | なし | 接続済みユーザーの Fine-grained PAT |
| `AUTO_REVIEW_PUSH_TOKEN` | repair commit の `git push` 専用 token。required checks を修復コミット上で発火させたい本番 repo では machine user PAT または GitHub App token を設定する。未設定時は従来通り `GITHUB_TOKEN` 相当の push 経路を使う | なし | 未設定 |
| `AUTO_REVIEW_LABEL` | 起動ラベル名（カスタマイズ用）。デフォルトのラベル必須モードでこのラベルが付いた PR のみ Workflow A/B が起動する。未設定/空文字なら `auto-review-fix` をフォールバック使用（レビュー＋自動修正までを行うため命名は `auto-review-fix`） | `auto-review-fix` | 未設定（フォールバックで `auto-review-fix` を要求） |
| `AUTO_REVIEW_FULL_AUTO` | `true` を設定すると label gate を無効化し、すべての非 fork ready PR で起動する（完全自動化、PoC 互換挙動） | `false`（ラベル必須） | 未設定（ラベル必須） |
| `AUTO_REVIEW_AUTO_MERGE` | `true` を設定すると `done / no_findings` 到達時に GitHub native auto-merge (squash) を有効化する（TY-245）。他の停止理由ではマージしない。失敗時は warning のみで人手マージ運用を維持 | `false`（人手マージ） | 未設定（人手マージ） |
| `AUTO_REVIEW_SEVERITY_THRESHOLD` | auto-fix 対象とする最低 severity。値は `P0` / `P1` / `P2` / `P3` のいずれか。デフォルト `P2` は従来挙動 (P0/P1/P2 を修正、P3 は skip)。`P3` で P3 まで修正対象に含め、`P1` / `P0` で対象を狭める。Codex finding の severity badge が読めなかった場合は warning ログを出して件数を記録、threshold 未達 finding は info ログで件数を記録する（TY-256） | `P2` | 未設定（`P2`） |

> 運用注意: `AUTO_REVIEW_FULL_AUTO=true` 時はラベルの付け外しで開始/停止を制御できない。停止したい場合は `AUTO_REVIEW_FULL_AUTO=false` に戻すか、workflow を無効化する。

GitHub Actions workflow の `env` または Repository variables で設定する。

```yaml
env:
  MAX_REVIEW_ITERATIONS: ${{ vars.MAX_REVIEW_ITERATIONS || '20' }}
  DEBOUNCE_SECONDS: ${{ vars.DEBOUNCE_SECONDS || '90' }}
  CHECK_COMMAND: ${{ vars.CHECK_COMMAND || 'npm run check' }}
  MAX_FILES_PER_ITERATION: ${{ vars.MAX_FILES_PER_ITERATION || '10' }}
  MAX_INPUT_TOKENS_PER_FILE: ${{ vars.MAX_INPUT_TOKENS_PER_FILE || '30000' }}
  CODEX_BOT_LOGIN: ${{ vars.CODEX_BOT_LOGIN || 'chatgpt-codex-connector[bot]' }}
  STABILIZE_INTERVAL_SECONDS: ${{ vars.STABILIZE_INTERVAL_SECONDS || '10' }}
  STABILIZE_COUNT: ${{ vars.STABILIZE_COUNT || '3' }}
  CODEX_REVIEW_MARKER: ${{ vars.CODEX_REVIEW_MARKER || 'Codex Review' }}
  AUTO_REVIEW_SEVERITY_THRESHOLD: ${{ vars.AUTO_REVIEW_SEVERITY_THRESHOLD || 'P2' }}
```

`CODEX_REVIEW_REQUEST_TOKEN` は GitHub Actions の Repository secrets に設定し、Workflow A/B の action input `codex-review-request-token` として渡す。この token は `@codex review` の投稿だけに使い、hidden comment の状態管理、Artifact 収集など既存の GitHub 操作は `GITHUB_TOKEN` を使い続ける。

`AUTO_REVIEW_PUSH_TOKEN` は repair commit の push だけに使う。branch protection の required checks がある本番 repo では、`GITHUB_TOKEN` push だと修復コミット上の CI が発火しない場合があるため、machine user PAT または GitHub App token を Repository secret として設定する。

---

## 役割分担

### Codex
- レビューだけ
- P0 / P1 指摘だけ
- 修正はしない

### Claude
- 指摘修正だけ
- 必要最小限の変更だけ
- テスト・lint・型チェックを通す
- commit / push する

この責務分離により、ループが安定しやすくなる。

---

## 最終まとめ

今回の設計は以下。

- **Codex はレビュー専任（bot: `chatgpt-codex-connector[bot]`）**
- **Claude は修正専任（Claude API Opus を GitHub Actions 内で tool use 呼び出し）**
- **Codex の総評レビュー（`pull_request_review`）を主トリガーに Workflow B を起動し、互換用に `issue_comment` も許可**
- **インラインコメント（`pull_request_review_comment`）を GitHub API で一括取得し、P0/P1 を抽出**
- **Claude にはファイル単位で `edit_file` ツール呼び出しによる構造化 edit を返させる**
- **レビュー受信後に `DEBOUNCE_SECONDS` 秒待機してから集約する（PR #7 ではデフォルト値で安定動作を確認。0秒化は未検証）**
- **Claude 修正後に `@codex review` を再実行（`CODEX_REVIEW_REQUEST_TOKEN` 設定時は接続済みユーザー PAT で投稿）**
- **P0 / P1 がなくなるか `MAX_REVIEW_ITERATIONS` 回到達で終了**
- **状態は PR の hidden comment で管理（status の遷移は [状態遷移図](flow-and-state.md#状態遷移図) を参照）**
- **PoC は Workflow 2本構成（A: 初期化、B: レビュー受信+修正）**
- **API キーは Repository secrets で管理**

この構成が、最も制御しやすく、運用上も安定しやすい。

---

## 関連ドキュメント

- [推奨フローと状態管理](flow-and-state.md) — ステップごとの詳細と状態遷移
- [イベント設計](event-design.md) — Workflow A/B のトリガーと重複防止
- [Severity パーサー仕様](../specs/severity-parser.md) — Codex コメントの解析
- [Claude 修正エンジン仕様](../specs/claude-fix-engine.md) — Claude API・edit 適用ロジック
- [全ドキュメント索引](../README.md)
