# リリース手順 (Releasing)

LoopPilot は npm ではなく **リポジトリ + Git タグ** で配布する。adopter は
`uses: team-yubune/loop-pilot/{init,loop}@v1` の形で参照する。

## バージョニング規則

- リリースは [SemVer](https://semver.org/) の `vX.Y.Z` タグで表す（例 `v1.0.0`, `v1.2.3`）。
- 各メジャーには **moving タグ** `vX`（例 `v1`）があり、常に最新の `vX.Y.Z` を指す。
  - `@v1` … 後方互換なパッチ/マイナーを自動取得（推奨）
  - `@v1.2.3` / commit SHA … 凍結
  - `@main` … 破壊的変更を受け得る（本番非推奨）

## リリース手順（1 コマンド）

1. `main` を最新化し、`CHANGELOG.md` の `[Unreleased]` を新バージョン節へ繰り上げてコミット。
2. リリースコミットにタグを打って push する:

   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. これで `.github/workflows/release.yml` が起動し、自動で:
   - `dist/` が `src/` と一致しているか検証（ズレていれば中断）
   - `loop/action.yml` / `init/action.yml` のサブアクション `@v<major>` 参照が
     タグの major と一致しているか検証
   - moving タグ `v1` をこのコミットへ張り替え（`git tag -f` + force push）
   - GitHub Release を作成（`--generate-notes`）

## リリース前チェック（自動・手動共通）

- **dist ドリフト**: `npm run bundle && git status --porcelain dist/` が空であること
  （CI の dist drift チェックと同一）。
- **サブアクション参照整合**: `npm run check:action-refs -- v1.2.3`。
  `loop/action.yml`（サブアクション `team-yubune/loop-pilot/loop/{pre-fix,post-fix}@v1`）と
  再利用ワークフロー `.github/workflows/{loop,init}.yml`（`team-yubune/loop-pilot/{loop,init}@v1`）の
  ハードコード参照を走査する。メジャーを上げる時はこれら全ファイルの `@v<major>` 参照
  （コメント内の使用例も含む）を同時に更新すること。

## 手動フォールバック

release.yml が失敗した場合のみ手動で:

```bash
# moving タグの張り替え
git tag -f v1 <release-sha>
git push -f origin v1
# Release 作成
gh release create v1.2.3 --title v1.2.3 --verify-tag --generate-notes
```

## 確認

```bash
git ls-remote --tags origin v1 v1.2.3      # 両タグが同一 SHA を指す
gh release view v1.2.3                       # Release が存在
```

外部リポジトリから `uses: team-yubune/loop-pilot/init@v1` が解決・実行できることを
確認する（リポジトリの可視性が public、または adopter が read 権限を持つこと）。
