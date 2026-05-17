# TY-233: Codex 徹底レビュー有効時 claude-code-action E2E

`anthropics/claude-code-action@v1` ベースの repo-level repair loop が、Codex 側で
「徹底的なコードレビュー」を有効にした PR に対しても破綻しないことを E2E で
確認した記録。

検証日: 2026-05-17
検証 PR: <https://github.com/team-yubune/test-auto-ai-review/pull/79>
ブランチ: `linear/TY-233-thorough-review-e2e`（merge せずクローズ）

## 前提

- TY-235 / TY-236 / TY-232 / TY-140: すべて Done を確認
- `AUTO_REVIEW_FULL_AUTO=true`、`CHECK_COMMAND=npm run check`
- Codex 設定: チケット冒頭で「Codex 側の設定は終わっている」旨を確認

## 実施手順

1. ブランチを切り、まず **未使用 export ファイル** `src/ty233-thorough-review-seed.ts`
   に 5 件の故意の欠陥（severity 混在）を仕込み PR #79 を作成。
2. Workflow A 起動を確認 → Codex 徹底レビューを待つ。
3. Codex が `Didn't find any major issues. Chef's kiss.` を返し
   `done / no_findings` 0 iteration で終了。**未使用コードは徹底モードでも
   findings 対象外** と判明。
4. `src/ty233-thorough-review-seed.ts` を削除し、本番ソース 2 ファイルに
   PR #58 (TY-145) 方式の small regression を仕込む：
   - `src/check-command-allowlist.ts:106` — safe-character 正規表現の否定を
     落として、shell metacharacter を通すようにする
   - `src/scope-checker.ts:155` — `isUnsafePath` の絶対パスガードを削除
5. push 後 `/restart-review --hard` で loop を再起動。
6. Codex が再レビューし、Workflow B → `claude-code-action` → 再 `@codex review`
   の 1 iteration で `done / no_findings` に到達。
7. 結果を本ファイルに記録、PR は merge せずクローズ。

## 主要観測値

| 項目 | 値 |
|---|---|
| iteration 数 | 1 / 上限 20 |
| Workflow B 経過時間 (fix 実行 run 25980252087) | 3 分 11 秒 (03:28:39→03:31:50 UTC) |
| Codex 徹底レビュー検出 finding 数 | 2 件（P1 × 1, P2 × 1） |
| Severity 内訳 | P0=0 / P1=1 / P2=1 / P3=0 |
| Claude repair diff | 2 files / 3 lines（`src/` 内） |
| scope-checker 違反 | 0（maxFiles=20, maxLines=1000, allowed=`src/` 内に収まる） |
| `--max-turns=40` 到達 | なし |
| workflow timeout 30 min 到達 | なし |
| `max_turns_exceeded` / `action_timeout` / `action_failure` / `scope_violation` | いずれも発生せず |
| 同一指摘ループ検知ヒット | なし (`findingsHashHistory` に hash 1 件のみ) |
| usage limit / quota コメント | なし |
| PR コメント総数 | 15 件（うち restart コマンド `/restart-review`、誤入力 `/restart-review …` のリジェクトを含む）|
| 修復後 PR の重複コメントノイズ | 観測されず（再レビュー要求とステータス完了の 2 件のみ）|
| 生成 repair request artifact | `codex-comments-79-471` (2010 bytes, run 25980252087) |
| Claude repair commit | `fccbf75142c3cfa51c71efffa768a4e2ae1b4c8f` (author: `claude[bot]`) |

### Codex 徹底レビュー検出内容

```
P1 src/check-command-allowlist.ts:106
   Restore safe-character check direction in command validation

P2 src/scope-checker.ts:156
   Keep absolute paths classified as unsafe in scope check
```

Codex は inverted condition と削除されたガードを的確に検出し、`Severity Badge`
画像と説明文を含む `pull_request_review_comment` として投稿した。
`severity-parser` の `IMAGE_BADGE_REGEX` でいずれもパース成功
（`hash=6e500eb1634677ca`）。

### Claude 修復内容

`claude-code-action@v1` は両 finding を最小差分で修復した：

```diff
--- a/src/check-command-allowlist.ts
+++ b/src/check-command-allowlist.ts
-  if (CHECK_COMMAND_SAFE_CHAR_RE.test(command)) {
+  if (!CHECK_COMMAND_SAFE_CHAR_RE.test(command)) {

--- a/src/scope-checker.ts
+++ b/src/scope-checker.ts
 function isUnsafePath(path: string): boolean {
   if (path.length === 0) return true;
+  if (path.startsWith("/")) return true;
   if (path.startsWith("../") || path === "..") return true;
```

post-fix の最終 `CHECK_COMMAND`（`npm run check`）が成功し、scope-checker は
allowed=`src/` 内、files=2 ≤ 20、lines=3 ≤ 1000 で違反なし。

## 受け入れ条件の判定

- [x] 徹底的なコードレビュー有効時の E2E 結果が記録されている — 本ファイル
- [x] finding 増加時も repair request / loop / guard の挙動が説明できる
  — 上記 1 iteration、Claude diff 2 files / 3 lines、scope-checker pass、
  state は `done / no_findings` で確定
- [x] 追加で必要な制限やチケットがあれば作成または記録されている
  — 後述「観察された残課題」を参照

## 観察された残課題・補足

### 1. 未使用 export ファイルは徹底レビューでも 0 findings になる

5 件の故意欠陥を含む `src/ty233-thorough-review-seed.ts`（どこからも import
していない new file）に対し、徹底モードの Codex は `Chef's kiss` を返した。
**Codex は「使われていないコード」を徹底モードでも skip する傾向** がある。

影響: 将来 PR の seeded regression は **既存の hot path に対する 1 行
inline 変更** で作る必要がある（PR #58 方式）。本検証で実証済み。

### 2. `/restart-review` のシンタックスは厳格

```
/restart-review thorough-review E2E: new commits ...
```
は `❌ Restart rejected: unsupported option.` で reject された。受理されるのは
`/restart-review` または `/restart-review --hard` のみ。任意のコメント文字列を
付与すると拒否される。docs に明示されているが、E2E では tail-comment 形式に
注意する。

### 3. 「複数 finding / 遅延 finding / 追加指摘」の境界条件は未到達

本検証は 2 findings 同時投稿で完結した。徹底モードが iteration 途中に追加
finding を投げてくるケース、または `MAX_REVIEW_ITERATIONS=20` / `--max-turns=40`
に近づくシナリオは未踏破。将来 finding がより多い PR が来た場合の挙動は引き
続き運用観測で補完する。`docs/checklists/poc-checklist.md` の未検証項目欄に
追記すべき候補だが、本検証で `claude-code-action` 経路の dogfood は完了した。

### 4. PR コメント数は受容可能だが restart 操作で +3 件

restart 時に `/restart-review --hard` 自身、ack コメント、再投稿の `@codex review`
が積まれる。通常フローでは comment 数は約 7〜8 件で収まり、徹底レビュー有効でも
追跡可能な量だった。

## 関連 run / commit

- Workflow A run: 25980013262
- Codex 初回（unused-export seed）: 4469071342 → 0 findings
- `/restart-review --hard`: コメント 4469109115
- Codex 徹底レビュー（regression 検出）: review 4304745665
  - inline 3253971388 (P1), 3253971389 (P2)
- Workflow B fix run: 25980252087（success, 3m11s）
- Claude repair commit: `fccbf75`
- Codex 再レビュー（修復後）: 4469162427 → `Bravo` / no findings
- 完了ステータス: 4469175086（`Auto-review completed — 1 iteration`）

## 関連

- [PoC チェックリスト](../checklists/poc-checklist.md)
- [Production E2E Validation Notes](production-e2e-validation.md)
- [Claude Code Action 実行制御 (security.md)](security.md)
- TY-145 / PR #58: same-repository auto-fix の先行 E2E
- TY-232: 通常モード E2E（前提として完了）
