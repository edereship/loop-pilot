# テスト戦略

PoC 段階でも以下のユニットテスト・統合テストを実装する。自動ループの信頼性はこれらのコンポーネントの正確性に依存するため、テストなしでの PoC 検証は非推奨。

---

## ユニットテスト（必須）

### 1. Severity パーサー

> 仕様の詳細は [Severity パーサー仕様](../specs/severity-parser.md) を参照。

- `P0 Title` → severity: `P0`, title: `Title`
- `[P1] Title` → severity: `P1`, title: `Title`
- `**P0** Title` → severity: `P0`, title: `Title`
- `**[P0]** Title` → severity: `P0`, title: `Title`
- `[P0]Title`（スペースなし） → severity: `P0`, title: `Title`
- `P2 Title` → 対象外（無視される）
- `\n  P0 Title`（先頭に空白・改行） → severity: `P0`, title: `Title`（strip 後にマッチ）
- `Some text with P0 in the middle` → フォールバック検知
- `No severity badge at all` → severity なし

### 2. findings ハッシュ

> 仕様の詳細は [ループ検知](../specs/loop-detection.md) を参照。

- 同一 findings セット → 同一ハッシュ（決定性）
- findings の順序が異なる → 同一ハッシュ（順序非依存）
- 1件でも異なる finding → 異なるハッシュ
- `line` のみ異なる → 同一ハッシュ（`line` はキーに含めない）

### 3. `edit_file` 適用ロジック

> 仕様の詳細は [Claude 修正エンジン仕様](../specs/claude-fix-engine.md#edit-適用ロジック) を参照。

- 単一 edit の正常適用
- 複数 edit の逆順適用（行数変動がある場合）
- `old_code` 不一致 → フォールバック発動
- 空白正規化マッチング（trailing whitespace, `\r\n`）
- 複数マッチ → `line` に最も近いマッチを選択
- 全 edit 成功後の一括書き込み（途中失敗時はディスク未変更）

### 4. ループ検知

> 仕様の詳細は [ループ検知](../specs/loop-detection.md) を参照。

- 同一ハッシュ → ループ検知
- 振動パターン（A → B → A） → ループ検知
- 異なるハッシュ → ループなし

---

## 統合テスト（推奨）

- **モック Codex コメント**を使った Workflow B の Phase 1（レビュー受信・集約）の E2E テスト
- GitHub API のレスポンスをモックし、パース → severity 抽出 → findings JSON 生成の一連の流れを検証する
- 実際の Codex インラインコメントの原文を GitHub Actions Artifact として保存し、テストケースの入力データとして使用する

---

## テスト実行

テストは `CHECK_COMMAND`（デフォルト: `npm run check`）に含めるか、CI の別ステップとして実行する。

---

## 関連ドキュメント

- [Severity パーサー仕様](../specs/severity-parser.md)
- [Claude 修正エンジン仕様](../specs/claude-fix-engine.md)
- [ループ検知](../specs/loop-detection.md)
- [全ドキュメント索引](../README.md)
