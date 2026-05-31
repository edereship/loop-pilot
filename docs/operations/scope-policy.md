# Scope Policy — auto-fix の変更スコープ検査

> claude-code-action が生成した diff を post-fix がどのように受け入れ / 拒否するかと、運用側で許可・禁止を調整する `LOOPPILOT_BLOCK_PATHS` Repository variable の仕様。

## 概要

post-fix は `anthropics/claude-code-action@v1` の出力を `git diff --numstat HEAD` で確認し、以下のいずれかに該当した場合は **revert + `stop_reason: scope_violation`** で停止する。

| reason | 条件 |
|--------|------|
| `path_traversal` | パスが絶対パス・`..` を含む（セキュリティ拒否、override 不可） |
| `hard_block_path` | パスが block-list（default + `LOOPPILOT_BLOCK_PATHS`）にマッチ |
| `binary_change` | numstat が `-`/`-`（バイナリ）。auto-fix では非対応 |
| `too_many_files` | 変更ファイル数が `LOOPPILOT_SCOPE_MAX_FILES` 上限を超過（default 20） |
| `too_many_lines` | 追加+削除行数が `LOOPPILOT_SCOPE_MAX_LINES` 上限を超過（default 1000） |

allow-list は存在しない。block-list にマッチしないパスはすべて許可される。

## Default block-list

`src/scope-checker.ts` の `DEFAULT_BLOCK_PATTERNS` にハードコードされている。各エントリは「ディレクトリ prefix（末尾 `/`）」または「ファイル完全一致（末尾 `/` なし）」のいずれか。

| path | 種別 | 解除可否 | 理由 |
|------|------|---------|------|
| `.github/` | dir | **locked**（解除不可） | workflow YAML を agent が書き換えると scope check 自体を内部から無効化できる（CI-rewrite escape hatch） |
| `.husky/` | dir | 解除可 | pre-commit hook 経路 |
| `.git-hooks/` | dir | 解除可 | git hook 経路 |
| `hooks/` | dir | 解除可 | git hook 経路 |
| `.devcontainer/` | dir | 解除可 | container 設定 |
| `.vscode/` | dir | 解除可 | editor 設定 |
| `.cursor/` | dir | 解除可 | editor 設定 |
| `node_modules/` | dir | 解除可 | dependency 出力 |
| `dist/` | dir | 解除可 | bundle 出力 |
| `Makefile` | exact | 解除可 | CI 入口になりやすい |
| `package.json` | exact | 解除可 | 依存追加で supply-chain 汚染 |
| `package-lock.json` | exact | 解除可 | 依存追加で supply-chain 汚染 |
| `tsconfig.json` | exact | 解除可 | tsc 設定 |
| root dotfiles（`.gitignore` 等） | regex (`^\.[^/]+$`) | 個別解除可 | ルート設定ファイル全般 |

`.github/` 以外はリポジトリ運用方針次第で `LOOPPILOT_BLOCK_PATHS` から `!path` で解除できる。

## `LOOPPILOT_BLOCK_PATHS` syntax

`.gitignore` 風のカンマ区切り spec。前後の空白はトリムし、空エントリは捨てる。

| エントリ形式 | 意味 |
|------------|------|
| `secrets/` | ディレクトリ prefix block を追加（`secrets/foo.txt` も block） |
| `Justfile` | ファイル完全一致 block を追加（`Justfile.bak` は無関係） |
| `!Makefile` | default block から exact 一致を解除 |
| `!dist/` | default block から dir prefix を解除 |
| `!.github/...` | **無視される**（警告ログ）。`.github/` は locked |

### 解決順序

`buildScopePolicy()` は以下の順で最終 block-list を構築する:

1. `DEFAULT_BLOCK_PATTERNS` から start（`.github/` は locked）
2. spec の `!path` で「path 完全一致」する default を取り除く（locked は対象外）
3. spec の `path` を追加

### 典型ユースケース

**1. デフォルトのまま（推奨）**

```
LOOPPILOT_BLOCK_PATHS = (未設定)
```

`src/`, `tests/`, `docs/`, `loop/`, `README.md`, `scripts/` 等すべて auto-fix 可能。`.github/`, `dist/`, `package.json`, `tsconfig.json` 等のセンシティブ領域は block。

**2. `dist/` を auto-fix 対象にする（bundle を loop で再生成したい）**

```
LOOPPILOT_BLOCK_PATHS = !dist/
```

`dist/` 配下の `.cjs` / `.map` を Claude が書き換え可能になる。Codex が「bundle が古い」と指摘するケース等で利用。

**3. 機密ディレクトリを明示的に追加**

```
LOOPPILOT_BLOCK_PATHS = secrets/,infra/terraform/,!Makefile
```

`secrets/`, `infra/terraform/` を block しつつ、デフォルトでは block されていた `Makefile` を解除。

## サイズ上限のカスタマイズ

| variable | input | default |
|----------|-------|---------|
| `LOOPPILOT_SCOPE_MAX_FILES` | `scope-max-files` | 20 |
| `LOOPPILOT_SCOPE_MAX_LINES` | `scope-max-lines` | 1000 |

`0` または空文字を渡すとデフォルトが使われる。`@v1` の `loop.yml` は `scope-max-files: ${{ vars.LOOPPILOT_SCOPE_MAX_FILES }}` のように Repository variable を**素のまま** action input に転送する（未設定なら空文字になり、上記 default にフォールバックする）。`"0"` を明示すると `core.getInput` が「設定済み」と解釈して env-var フォールバックを上書きしてしまうため、転送時に `|| '0'` のようなデフォルトは付けない（TY-350）。

## `BUILD_COMMAND` と build 後 scope 再 check

`BUILD_COMMAND` Repository variable (または `build-command` input) を設定すると、post-fix は CHECK_COMMAND 通過後・commit 直前にそのコマンドを実行し、生成された差分も auto-fix commit に含めて push する。`dist/` などのビルド成果物を repo にコミットする運用 (この repo を含む GitHub Action 配布レポなど) で、auto-fix commit が `src/` と drift しないようにする経路。

| variable | input | default |
|----------|-------|---------|
| `BUILD_COMMAND` | `build-command` | "" (skip) |

build 後は **緩和版 scope check** (`checkScopeBuildMode`) が走る。Build output は user が opt-in したコマンドの出力なので、default block list の **unlocked エントリ** (`dist/`, `package.json` 等) と **サイズ上限** をスキップする。**locked エントリ** (`.github/`) と **path traversal** はセキュリティ境界として維持する。

| チェック | 通常 `checkScope` (pre-build) | `checkScopeBuildMode` (post-build) |
|---|---|---|
| `path_traversal` (`..`, 絶対パス) | reject | **reject** |
| `hard_block_path` (locked: `.github/`) | reject | **reject** |
| `hard_block_path` (unlocked: `dist/`, `package.json` 等) | reject | skip |
| `binary_change` (`-`/`-` numstat) | reject | skip |
| `too_many_files` / `too_many_lines` | reject | skip |

これにより、`BUILD_COMMAND=npm run bundle` を Repository variable に設定するだけで `dist/` 配下が auto-fix commit に同梱される。`LOOPPILOT_BLOCK_PATHS=!dist/` を併設する必要はない。ただし build command が `.github/` を書き換えるような事故 (CI-rewrite escape hatch) は依然として `scope_violation` で止まる。

複数ステップ (lint + build + post-process など) のニーズには **npm script ラップを推奨** する (例: `package.json` に `"build": "npm run lint && npm run bundle"` を追加して `BUILD_COMMAND=npm run build`)。`&&` をそのまま `BUILD_COMMAND` に書く形は config-load 時の allowlist (`validateCheckCommand`) で **shell metacharacter として reject** される。multi-command native support は意図的に付けていない (既存の `CHECK_COMMAND` と同じ方針)。allowlist の詳細は [security.md](security.md) の「CHECK_COMMAND / BUILD_COMMAND validation」節を参照。

エラーハンドリング:

| 状況 | 停止理由 |
|------|----------|
| `BUILD_COMMAND` non-zero exit | `action_failure` (working tree を `git reset --hard HEAD && git clean -ffd` で復元) |
| 生成物が `.github/` 等 locked path に該当 / `..` 含む path | `scope_violation` (同上で復元、停止コメントは `formatScopeViolationDetail` の表現) |
| 生成物が無い (no-op) | 何もせず claude-code-action の差分のみ commit |

## repair prompt への事前共有

pre-fix は `buildScopePolicy()` で得た effective policy を `claude-code-action@v1` の repair prompt に `## Scope Policy (your edits must satisfy)` セクションとして埋め込む。Claude が事前に境界を知っていれば、そもそも違反 diff を生成しないため、scope_violation 経由の revert + iteration 浪費を構造的に減らせる。

prompt 上の表示は以下の構造:

```
## Scope Policy (your edits must satisfy)
- Blocked paths (do not modify; reverted server-side after your run):
  - .github/ (structurally locked, cannot be overridden)
  - dist/
  - node_modules/
  - package.json
  - ...
- Max files changed: 20
- Max lines changed (added + deleted): 1000

If a faithful repair would exceed these limits, stop and explain rather than producing a partial fix that will be reverted.
```

仕様:

- block-list は override (`!path`) を **解除済みの effective list**。Claude には override syntax を露出させない。
- `.github/` は locked 注記 (`(structurally locked, cannot be overridden)`) を inline で付与。
- `max-files` / `max-lines` は Repository variable で上書きされていれば override 後の値。default 値と一致する場合も省略しない。
- セクションは **`## Codex Findings` の直後 / `## Instructions` の直前**に挿入される。
- `buildScopePolicy()` が失敗した場合 (parse error 等) はセクションを省略する。Claude が scope policy を知らない状態に戻るだけで安全側。`core.warning` でログのみ残す。

実装: `src/claude-code-repair-request.ts`（`buildClaudeCodeRepairPrompt`, `formatScopePolicySection`）, `src/main-pre-fix.ts`。

## scope_violation 時の停止コメント

post-fix は違反種別ごとに actionable な `Detail:` を生成する。

### `hard_block_path`

```
Detail: Auto-fix touched paths blocked by the scope check.

Affected paths:
  - dist/post-fix/index.cjs

To let Claude edit these paths, add the matching `!` entries to the
`LOOPPILOT_BLOCK_PATHS` Repository variable:

  LOOPPILOT_BLOCK_PATHS = "!dist/"

(If the variable is already set, append the new entries with a comma.)

See docs/operations/scope-policy.md.
```

`.github/` がマッチした場合は加えて「locked であり解除不可、手動修正が必要」が表示される。

### `too_many_files` / `too_many_lines`

`LOOPPILOT_SCOPE_MAX_FILES` / `LOOPPILOT_SCOPE_MAX_LINES` での上限引き上げ手順を案内する。

### `binary_change`

「auto-fix は binary を扱えない、手動修正してほしい」を明示。

### `path_traversal`

「セキュリティ拒否であり override 不可」を明示。

## 旧 variable の撤廃 (TY-271 / TY-350)

旧 scope 変数 `LOOPPILOT_HARD_BLOCK_OVERRIDE` / `LOOPPILOT_SCOPE_ALLOWED_PATH_PREFIXES` / `LOOPPILOT_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES`（および対応する `looppilot-hard-block-override` / `scope-allowed-path-prefixes` / `scope-additional-hard-block-prefixes` action input）は **v1.1.0 で削除**された。これらは reusable workflow `loop.yml` から composite へ配線されておらず、`@v1` では元々設定しても効果がなかった（TY-350）。`LOOPPILOT_BLOCK_PATHS` に移行する:

| 旧設定 | 新設定 |
|--------|--------|
| `LOOPPILOT_HARD_BLOCK_OVERRIDE=package.json,tsconfig.json` | `LOOPPILOT_BLOCK_PATHS=!package.json,!tsconfig.json` |
| `LOOPPILOT_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES=secrets/,Justfile` | `LOOPPILOT_BLOCK_PATHS=secrets/,Justfile` |
| 両方併用 | `LOOPPILOT_BLOCK_PATHS=!package.json,!tsconfig.json,secrets/,Justfile` |
| `LOOPPILOT_SCOPE_ALLOWED_PATH_PREFIXES=...` | （削除のみ。allow-list 概念は廃止され、block されていないパスは全て許可される） |

`LOOPPILOT_SCOPE_MAX_FILES` / `LOOPPILOT_SCOPE_MAX_LINES` は block-list とは直交するため**存続**する。

## 関連

- 実装: `src/scope-checker.ts`（`parseBlockPathsSpec`, `buildScopePolicy`, `checkScope`）
- pre-fix 配線 (prompt 共有): `src/main-pre-fix.ts` / `src/claude-code-repair-request.ts`（`formatScopePolicySection`）
- post-fix 配線: `src/main-post-fix.ts`（`formatScopeViolationDetail`）
- セキュリティ運用全般: [security.md](security.md)
- 停止条件とリカバリ: [stop-and-recovery.md](stop-and-recovery.md)
