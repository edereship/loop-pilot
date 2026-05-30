# ADR-0001: CLI 配布設計（`gh looppilot` の配布方式・repo 境界）

- **Status:** Accepted
- **Date:** 2026-05-30
- **Deciders:** LoopPilot maintainers
- **Related:** TY-348（本 ADR）、TY-346（CLI scaffold 実装）、TY-347（pre-flight / doctor）、TY-349（外部 adopter E2E）、[リリース手順](../operations/releasing.md)

> これは LoopPilot で最初の ADR である。今後の設計判断も `docs/architecture/adr-NNNN-<slug>.md` 形式で残す。

## Context（背景）

`gh looppilot init` は導入摩擦を最も下げる施策だが、実装前に「どこに置き、どう配布するか」を確定しないと、Action 本体 (`@v1` Git tag)・CLI・release version の責務が混ざり、TY-346 実装後に作り直しになりやすい。

確定済みの技術的制約:

1. **GitHub Action 本体はリポジトリ + Git ref で配布する**（npm ではない）。adopter は `team-yubune/loop-pilot/{init,loop}@v1` および reusable workflow `team-yubune/loop-pilot/.github/workflows/{init,loop}.yml@v1`（TY-345）を参照する。
2. **`gh` CLI extension は `gh-<name>` という名前の専用 repo を要求する。** repo 直下に repo 名と同名の実行可能ファイル（`gh-looppilot`）を置くか、release に precompiled binary（`gh-looppilot-<os>-<arch>`）を添付する必要がある（[Creating GitHub CLI extensions](https://docs.github.com/en/github-cli/github-cli/creating-github-cli-extensions)）。
   → つまり **本体 repo `loop-pilot` 自体を `gh looppilot` extension にはできない。** extension 経路を採るなら別 repo が構造上必須。
3. CLI の中核価値（caller 生成 + TY-347 pre-flight）は本質的に **`gh` 中心**で、認証済み `gh` セッションを使った read-only API 検査に依存する。
4. CLI が生成する caller は **薄い caller**（reusable workflow `@v1` を参照、TY-345）であり、full workflow を凍結生成しない。よって生成テンプレートは小さく安定で、Action 内部変更で陳腐化しない。

## Decision（決定）

### 1. 配布方式: `gh` CLI extension（専用 repo）

CLI は **`team-yubune/gh-looppilot` を専用 repo とする GitHub CLI extension** として配布する。本体 repo `loop-pilot` は Action + reusable workflow の配布に専念する。

- **唯一の公式 install path:**
  ```bash
  gh extension install team-yubune/gh-looppilot
  gh looppilot init      # caller 生成・ラベル作成・CHECK_COMMAND 提案・手動手順表示
  gh looppilot doctor    # TY-347 pre-flight を単独実行（= init --preflight-only と同等）
  ```

### 2. npm / `npx`: v1 では公式対象外（fallback でもない）

`npx` / npm を **v1 の正式配布チャネルに含めない**。理由:

- ツールが `gh` 中心であり、pre-flight は認証済み `gh` セッション前提。npm 単独配布では `gh auth` の前提を強制できない。
- npm publish は **public package + SemVer 公開面**を抱え、Action `@v1` tag 運用と version 責務が混ざる（このチケットが避けたい状態そのもの）。
- 本体 `loop-pilot/package.json` は **`private: true` のまま**にでき、npm publish を一切不要にできる。

> 将来 npm/`npx` の需要が出た場合は、**同一の生成ロジックを共有**して別 ADR で追加する（出力差分を作らないこと）。それまでは「`gh` extension のみ」と明記する。

### 3. 実装言語: Node / TypeScript（interpreted extension）

CLI は **Node/TS** で実装し、interpreted な gh extension として配布する。

- repo 直下の実行可能ファイル `gh-looppilot` は薄い bash shim（`exec node "${0%/*}/cli.cjs" "$@"` 相当）とし、esbuild で単一ファイルにバンドルした `cli.cjs` を **repo にコミット**する（action の `dist/*/index.cjs` と同じパターン。gh extension は clone してそのまま実行するため `npm install` は走らない）。
- **runtime 依存: Node ≥ 20。** LoopPilot adopter は GitHub ユーザーであり Node の用意は軽微。非 Node toolchain の adopter（例: Python repo）でローカルに Node が無い摩擦が顕在化したら、**Node SEA による precompiled binary 配布**（`cli/gh-extension-precompile` 相当）へ移行する（後方互換な追加で対応可能）。
- 言語を Node/TS にする理由: 本体 repo の TS/vitest/esbuild ツールチェインを再利用でき、TY-346 の toolchain 検出・テンプレート生成・TY-347 の安定 JSON schema + exit code・CHECK_COMMAND allowlist をテスト可能な形で書ける。bash 実装は JSON schema と allowlist の保守性が低く、Go 実装は新言語導入かつロジック再利用不可。

### 4. repo 境界と責務分離

| | `team-yubune/loop-pilot`（本体） | `team-yubune/gh-looppilot`（CLI） |
|---|---|---|
| 配布物 | composite action + reusable workflow | `gh looppilot` extension |
| バージョニング | Git tag `v1.x.y` + moving `v1`（[releasing.md](../operations/releasing.md)） | 独自 tag `v0.x.y`（extension release。Action の `@v1` とは独立） |
| 依存方向 | （CLI に依存しない） | 生成する caller が `loop-pilot` の `@v1` を**文字列参照**するのみ。コード import はしない |
| 共有ロジック | `src/check-command-allowlist.ts` 等 | CLI 側に **vendoring（移植 + 自前テスト）**。allowlist は小さく、cross-repo の build 依存を作らないことを優先 |

- **Action release（`@v1`）と CLI release は完全に分離**する。CLI のバグ修正で Action を再タグしない／Action 変更で CLI を再リリースしない。
- CLI が生成する caller は常に `team-yubune/loop-pilot/.github/workflows/{init,loop}.yml@v1`（moving major）を指す。CLI は「どの major を指すか」だけを知っていればよく、Action の内部変更には追従不要。

### 5. 実装ステージング（TY-346/347 を repo 作成前に進めるため）

`team-yubune/gh-looppilot` の **新規 public repo 作成は人手承認が必要**（外部公開操作）。そのため CLI は当面 **本体 repo の `cli/` ディレクトリ**で開発し、CI に組み込む。`cli/` は将来の `gh-looppilot` repo の中身をそのまま反映したレイアウトにする。

```
loop-pilot/
  cli/                      # = 将来の team-yubune/gh-looppilot repo の中身
    gh-looppilot            # 実行可能 shim (chmod +x)
    cli.cjs                 # esbuild バンドル（コミットする）
    src/                    # CLI ロジック (TS)
    tests/                  # vitest（root の `npm run check` で実行）
    tsconfig.json
    README.md
    .github/workflows/release.yml   # extraction 後に有効化
```

- root `vitest.config.ts` の `include` に `cli/tests/**/*.test.ts` を追加し、`npm run check` で CLI テストも回す。
- root `package.json` に `typecheck:cli`（`tsc --noEmit -p cli/tsconfig.json`）と `bundle:cli`（esbuild → `cli/cli.cjs`）を追加。
- `cli/cli.cjs` の drift は CI で検査できるが、本体 `dist/` drift とは別ジョブ/別 npm script にする。

**extraction（人手承認後）:** `team-yubune/gh-looppilot` を作成し `cli/` を移送（`git subtree split` か単純コピー）→ `gh-looppilot/release.yml` 有効化 → tag → `gh extension install team-yubune/gh-looppilot` で検証。手順は TY-349 の runbook に記載する。抽出後、本体 repo の `cli/` は削除するか canonical source として残すかを extraction 時に決める（推奨: 抽出後は `gh-looppilot` を single source とし `loop-pilot/cli/` は削除）。

## Consequences（影響）

**良い点:**
- install が 1 コマンド（`gh extension install team-yubune/gh-looppilot`）。`gh` ユーザーに自然。
- Action `@v1` と CLI version が構造的に分離され、責務混在が起きない。
- 本体 `package.json` は `private: true` のままで npm publish 不要。
- CLI は Node/TS で書け、テスト可能。生成 caller は薄く安定。

**コスト / 留意:**
- 2 つ目の repo を作成・維持する必要がある（人手承認の repo 作成が前提）。
- CLI runtime に Node ≥ 20 が必要（非 Node adopter には軽微な摩擦。precompile で将来回避可能）。
- 共有ロジック（allowlist）が 2 repo に重複する。allowlist は小さいので許容。差分が出ないよう、移植時に同一テストケースをコピーする。
- ステージング期間中は `loop-pilot` に CLI コードが同居する（extraction 後に解消）。

## Alternatives considered（検討した代替案）

1. **monorepo 同居 + npm/`npx` 主、`gh` extension は薄い wrapper.**
   却下理由: `gh` extension は結局 `gh-` 専用 repo が必要なので「同居で完結」しない。npm publish が `@v1` tag 運用と version 責務を混ぜる。pre-flight の `gh` セッション前提を npm 単独では強制できない。
2. **CLI を Go で実装し precompiled binary extension.**
   却下理由: 新言語導入、本体の TS allowlist/型を再利用不可、保守者の認知負荷増。Node SEA で同等の precompile は将来必要時に可能。
3. **CLI を bash で実装（runtime 依存ゼロ）.**
   却下理由: TY-347 の安定 JSON schema・exit code・allowlist・snapshot テストを bash で保守するコストが高い。
4. **`loop-pilot` 自体を extension にする.**
   却下理由: extension は `gh-<name>` repo 必須のため構造上不可能。

## Implementation checklist（TY-346 / TY-347 への申し送り）

TY-346（CLI scaffold）が迷わず始められるよう:

- [ ] `cli/` レイアウトを上記の通り作成（shim `gh-looppilot` + `src/` + `tests/` + `tsconfig.json` + `cli.cjs` バンドル）。
- [ ] `gh looppilot init` サブコマンド: 薄い caller 2 本生成（`@v1` reusable workflow 参照・secret 明示列挙・完全 `permissions`（`actions: read` 含む）・検出した `language` input）／ゲートラベル冪等作成（`gh label create`）／CHECK_COMMAND 提案／手動手順表示。**full workflow は生成しない。**
- [ ] `gh looppilot doctor`（= `init --preflight-only`）: TY-347 の read-only 検査を単独実行。
- [ ] toolchain 自動検出: `package.json`/`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`、`requirements.txt`/`pyproject.toml`、`go.mod`、`Cargo.toml`、`Makefile` → `language` input と `CHECK_COMMAND` を提案。
- [ ] CHECK_COMMAND allowlist を `src/check-command-allowlist.ts` から `cli/` に移植し、同一テストケースで検証。
- [ ] snapshot/fixture テスト（生成 caller の出力固定）を `cli/tests/` に置き `npm run check` で回す。
- [ ] root `vitest.config.ts` / `package.json` に CLI テスト・typecheck・bundle を配線。
- [ ] 生成 caller は `team-yubune/loop-pilot/.github/workflows/{init,loop}.yml@v1` を参照（TY-345 で確定した薄い caller 形）。
- [ ] **自動化不能**として明示する手順: Codex GitHub App 連携、secret 値投入、branch protection 利用時の `LOOPPILOT_PUSH_TOKEN`、初回 PR の観測ポイント。

## Human-required follow-ups（人手承認が必要な残作業）

- `team-yubune/gh-looppilot` public repo の新規作成（外部公開操作）。
- `cli/` の extraction + extension release tag。
- （任意）GitHub Marketplace 掲載（TY-343）は発見性の入口であり、CLI 配布方式の代替ではない。
