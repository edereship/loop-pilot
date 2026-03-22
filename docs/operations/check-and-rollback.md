# 検証コマンドとロールバック

## 検証コマンド（test / lint / typecheck）

Claude が修正を適用した後に実行する検証コマンドは `CHECK_COMMAND` 環境変数で指定する。

### コマンド設計

- 単一のコマンドで test / lint / typecheck をまとめて実行する想定（例: `npm run check` が内部で `tsc --noEmit && eslint . && vitest run` を実行する）
- プロジェクトの `package.json`（または相当の設定ファイル）に `check` スクリプトを定義しておく
- 複数コマンドを直列実行する場合は `&&` で連結して指定する（例: `npm run lint && npm test`）

---

## 失敗時の挙動

`CHECK_COMMAND` が非ゼロで終了した場合、commit / push は行わない。

### ロールバックのフロー

1. Claude の edit 適用前に `git diff --name-only` と `git ls-files --others --exclude-standard` で変更前の状態を記録する
2. 全 edit をメモリ上で検証する（`old_code` の一致確認）
3. **検証失敗（`old_code` 不一致等）:** ディスク書き込みは行わないため、ロールバック不要
4. **検証成功 → ディスクに一括書き込み → `CHECK_COMMAND` 実行**
5. **`CHECK_COMMAND` 失敗:** 記録済みのファイル一覧を基に `git checkout -- <modified files>` + `rm <created files>` を実行する

- `git clean -fd` のような無差別な削除は、PR ブランチに含まれる Claude 修正と無関係な untracked file を消失させるリスクがあるため使用しない

### 失敗時の状態と報告

- `status: stopped`, `stop_reason: test_failure` で停止する
- PR に失敗内容（コマンド出力の冒頭 20行 + 末尾 50行）をコメントとして投稿する。冒頭を含めるのは、テストフレームワークによってはエラーサマリーが出力の先頭に表示されるため

### 出力のサニタイズ

投稿前に以下の処理を行う:

- ANSI エスケープシーケンスを除去する（例: `sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'`。`[a-zA-Z]` とすることで、カラーコード `m` だけでなくカーソル移動 `H` `J` 等のシーケンスも除去できる）
- コメント全体が GitHub の文字数制限（65,536 文字）を超えないよう、末尾行数を調整して切り詰める

---

## 関連ドキュメント

- [Claude 修正エンジン仕様](../specs/claude-fix-engine.md) — edit 適用ロジックの詳細
- [停止条件とリカバリ](stop-and-recovery.md) — テスト失敗後の停止・復帰
- [推奨フローと状態管理](../architecture/flow-and-state.md) — フロー全体での位置づけ
- [全ドキュメント索引](../README.md)
