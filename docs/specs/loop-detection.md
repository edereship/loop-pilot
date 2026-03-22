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
- **hidden comment に保持するのはハッシュ値のみ**。`normalized_set` は保持しない（コメントサイズ制限のため）
- そのため、異なる workflow 実行間では**ハッシュの完全一致のみ**で判定する。部分一致（80%マッチ）の判定は `normalized_set` が必要なため、hidden comment からの復元では不可能
- **振動パターン（A → B → A）の検知:** `findings_hash_history` に直近 N 回分（推奨: 3回）を保持し、いずれかとの一致でループ検知する（直近1回のみの比較では検知できない）

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
