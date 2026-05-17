# Hygiene 系の判断ログ

`team-yubune/test-auto-ai-review` のリポジトリ整備に関する判断を 1 箇所にまとめる。「やる / やらない」を選んだ理由を残し、再度議論し直す手間を防ぐ。

## TY-270: README/LICENSE / 依存整理ほか

### 採用した変更 (本ファイルは TY-270 #16 完了の一部)

- ルート `README.md` と `LICENSE` (MIT) を追加。
- `@types/node` を `^24.0.0` に上げて Action runtime (`node24`) に揃える。
- `vitest.config.ts` の `globals: true` を削除 (全テストが `describe`/`it`/`expect`/`vi` を明示 import 済み)。
- `pushWithToken` を `git -c http.extraheader='AUTHORIZATION: Basic <base64>' push <pinned-url> HEAD:refs/heads/<ref>` 方式へ (Codex PR #77 のセキュリティ指摘対応)。`.git/config` に token を書かず、push 先 URL と refspec を `Config` の `repoOwner` / `repoName` / `prHeadRef` から組み立てて明示的に渡す。三段の defense:
  1. **Pinned destination**: `git push <destUrl> <refspec>` で URL を明示。`remote.origin.url` が改変されても PAT が外部に流れない。
  2. **Cleared rewrite rules**: push 直前に `git config --local --get-regexp '^url\..*\.(insteadOf|pushInsteadOf)$'` で `.git/config` 上のすべての rewrite ルールを列挙し、`--unset-all` で個別に削除する。`-c url.<base>.insteadOf=` を空文字で上書きする方式は **既存の `url.<attacker>.insteadOf=https://github.com/` を無効化できない** ため、不十分。
  3. **Stripped checkout extraheader**: `actions/checkout@v5` が残した `http.https://github.com/.extraheader` (GITHUB_TOKEN) を push 前に `--unset-all` で除去し、`AUTO_REVIEW_PUSH_TOKEN` ヘッダと二重送信されないようにする。エラーは exit 5 (key 不在) のみ swallow し、それ以外は再 throw して push を中断 (silent failure で GITHUB_TOKEN ヘッダが残るのを防ぐ)。
- `gh api` の body 渡しを `--field` で統一 (TY-269 #13 と同時)。

### 採用した判断

#### #17 `package.json` の version 方針

- `version: "0.1.0"` のまま **semver 0.x で進める**。PoC 段階で API stability を保証しない以上、`0.x` のままが意図と合致する。
- 公開 `v1` 移植 (= 別 repo への分離) のタイミングで `1.0.0` に bump し、以降は GitHub Releases + tag で配布する。
- 内部 PoC の現在は `version` フィールドの値を厳密に追跡しない。`package.json` に最低限の構文として残しておく。

### 見送った変更 (理由付きで記録)

#### #21 `runIfNotVitest` の判定方法

- 現状 `process.env.VITEST === "true"` で entrypoint を bypass している。tsx 経由の手動実行で偶然 `VITEST=true` が継承された場合に entrypoint が起動しないが、**実害が観測されていない**。
- vitest 公式の判定方法 (`import.meta.vitest` など) に切り替えると tsconfig / esbuild bundle target の調整が必要で、bundle 経路 (`dist/{init,pre-fix,post-fix}/index.cjs`) を node24 / CJS で出していることもあり、コストが見合わない。
- **見送り**。将来 vitest 公式の手段が cjs bundle と素直に共存できるようになったら再検討する。

#### #12 `findings-hash` の hash 長

- `findings-hash.ts` は SHA-256 を `slice(0, 16)` (64-bit, hex 16 文字) に切り詰めている。
- hash 長を変えると `findingsHashHistory` の互換性が崩れ、既存 PR の `state.lastFindingsHash` と `findingsHashHistory[].hash` が一致しなくなる。結果、loop detection が「初回 finding」と誤判定し、本当の loop が見逃される。
- **現状維持**。実用上の衝突確率は無視できるレベルで、hash 拡張による堅牢化メリットよりも既存 PR の loop detection を温存するメリットが大きい。全 PR の hidden state を一掃する次回大型変更のタイミングで再評価する。
