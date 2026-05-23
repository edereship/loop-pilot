# 同一指摘ループの検知

## 概要

Claude が修正しても Codex が同じ指摘を繰り返すケースは、上限回数に達するまで無駄にリソースを消費する。このドキュメントでは、ループを早期検知して停止する仕組みを定義する。

**PoC 段階:** 初期実装に含める。ループが発生すると PoC 自体の検証が妨げられるため、早期に入れる価値がある。

---

## 検知方法（疑似コード）

```python
import hashlib

def stable_hash(s: str) -> str:
    """プロセス間で一貫した決定的ハッシュを返す。
    Python 組み込みの hash() は PYTHONHASHSEED によりプロセスごとに
    ランダム化されるため、異なる workflow 実行間で値が一致しない。
    hashlib.sha256 を使うことで、実行環境に依存しない比較が可能になる。"""
    return hashlib.sha256(s.encode()).hexdigest()[:16]

def normalize_finding(f):
    """finding を比較可能なキーに正規化する。
    line は修正のたびに変動する不安定な値のためキーに含めない。
    severity + path + body のハッシュで同一指摘を判定する。"""
    return (f.severity, f.path, stable_hash(f.body))

def compute_findings_hash(findings):
    """findings セット全体のハッシュを決定的に生成する。
    str(sorted(...)) は Python のタプル __repr__ に依存し、
    言語・バージョン間で表現が異なる可能性があるため、
    JSON シリアライズで決定論的な文字列表現を保証する。"""
    import json
    normalized = sorted(set(normalize_finding(f) for f in findings))
    # 各タプルをリストに変換し、JSON で決定論的にシリアライズ
    serializable = [list(t) for t in normalized]
    return stable_hash(json.dumps(serializable, separators=(",", ":"), sort_keys=True))

def is_loop(current_findings, findings_hash_history):
    """直近 N 回の findings と比較してループを検知する。

    findings_hash_history は hidden comment から読み込んだハッシュ値のリスト。
    hidden comment にはハッシュのみ保持し、normalized_set は保持しない。
    そのため、異なる workflow 実行間ではハッシュの完全一致のみで判定する。
    """
    current_hash = compute_findings_hash(current_findings)

    for entry in findings_hash_history:
        if current_hash == entry["hash"]:
            return True  # 完全一致（振動パターン A→B→A も検知可能）
    return False
```

---

## マッチング条件

- `(severity, path, body の hash)` を正規化キーとし、セット全体のハッシュで比較する
- `line` はキーに含めない（Claude の修正で行数が変動すると、同一指摘がループ検知をすり抜けるため）
- `title` はキーに含めない（TY-276 #7。Codex が同一指摘の title を iteration 間で cosmetic に書き換えることがあるため、含めると loop 検知を bypass される）
- `body` は hash 前に **whitespace を正規化** する（TY-305）。Codex は同じ logical finding を CRLF↔LF (renderer の OS 差) / trailing-line-whitespace (markdown line break) / 先頭末尾 trim (summary template 編集) の差分で再描画することがあり、raw のまま hash すると cosmetic 差分で別 hash になる。正規化規則は以下 3 段:
  1. `\r\n` → `\n` (line-ending 統一)
  2. `[ \t]+\n` → `\n` (行末 trailing whitespace 除去)
  3. body 全体に `trim()` (先頭末尾の whitespace 除去)
  内部 whitespace runs (行内の連続 space) は **保持** する。コード片 / stack trace の意図的なインデントを潰すと「実際に違う content」を同一視するリスクがあるため、edge whitespace だけを正規化する
- **hidden comment に保持するのはハッシュ値のみ**。`normalized_set` は保持しない（コメントサイズ制限のため）
- そのため、異なる workflow 実行間では**ハッシュの完全一致のみ**で判定する。部分一致（80%マッチ）の判定は `normalized_set` が必要なため、hidden comment からの復元では不可能
- **振動パターン（A → B → A）の検知:** `findings_hash_history` に直近 N 回分を保持し、いずれかとの一致でループ検知する（直近1回のみの比較では検知できない）
- **検知可能なサイクル長の上限:** N は `state-manager.ts` の `MAX_HISTORY_ENTRIES` で決まる。現状の実装では `MAX_REVIEW_ITERATIONS` の default と同じ **20** に揃えており、cycle 長 ≤ 20 の oscillation を検知できる。cycle 長 > 20 の oscillation は履歴が trim されて検知不能となり、`max_iterations` で停止する（TY-296 でこの上限を 3 → 20 に引き上げた経緯あり）

---

## ループ検知時の動作

- 自動修正を停止する（`status: stopped`, `stop_reason: loop_detected`）
- PR にコメントで状況を報告する（どの指摘がループしているか明記）
- 人間の介入を求める

---

## 関連ドキュメント

- [推奨フローと状態管理](../architecture/flow-and-state.md) — findings_hash_history の保存先
- [停止条件とリカバリ](../operations/stop-and-recovery.md) — ループ検知後の停止・復帰
- [テスト戦略](../testing/test-strategy.md#4-ループ検知) — ループ検知のテストケース
- [全ドキュメント索引](../README.md)
