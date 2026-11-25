#!/usr/bin/env python3
"""両親指制約チェッカー: src/data/charts.json が「両手（両親指）前提」の制約を
満たすかを検証する（譜面 v4、docs/CHART-DESIGN.md の「両親指前提」節が正本）。

レーンは左から 0,1,2,3。左親指が 0・1、右親指が 2・3 を受け持つ（side = lane // 2）。

制約:
  C1 同時押しは最大2ノーツ。ペアは左右に分かれる組み合わせ
     （0+2 / 0+3 / 1+2 / 1+3）のみで、同側ペア（0+1 / 2+3）は禁止。
  C2 長押し中は、その側の親指は拘束される。ホールドの帯（頭の時刻 < t <= 尾）
     にあるノーツは反対側だけ。同時ホールドは左右1本ずつまで
     （同側同士の重なり禁止。左右に分かれた重なりは可）。
  C3a 速い流れ（16分相当＝細分グリッドで間隔1ステップ以下の連なり）では、
     同側に3連以上を置かない。
  C3b 同側2レーンの交互（片手トリル）は、間隔が8分相当以下（2ステップ以下）の
     連なりで5連以上にしない（4連＝半小節1単位まで）。
  C4 同一レーン連続は従来ルール: 原則禁止。例外は hard の縦連
     （間隔 170ms 以上の3連）だけ。

グリッド位置は charts.json の実測拍列（beats）から作る16分細分位置への
最近傍で求める（スナップで時刻が ±38ms 動いていても、ステップ単位の
間隔判定は揺れない）。

使い方:
  .venv/bin/python scripts/check-two-thumb.py [charts.json のパス]
  生成器（generate-charts.py）からも、書き出し前に check_charts() で呼ばれる。
"""
import bisect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JACK_MIN_GAP_MS = 170


def side_of(lane):
    return lane // 2


def subdivision_positions(beats):
    """拍列（ms）から16分細分位置（ms）の列を作る（生成器・単体テストと同じ補間）。"""
    pos = []
    for i, bt in enumerate(beats):
        nxt = beats[i + 1] if i + 1 < len(beats) else bt + (bt - beats[i - 1])
        for s in range(4):
            pos.append(bt + (nxt - bt) * s / 4)
    return pos


def grid_index(pos, t):
    """時刻 t に最も近い細分位置のインデックス。"""
    j = bisect.bisect_left(pos, t)
    best = None
    for k in (j - 1, j):
        if 0 <= k < len(pos):
            d = abs(pos[k] - t)
            if best is None or d < best[1]:
                best = (k, d)
    return best[0]


def _events(song, notes):
    pos = subdivision_positions(song["beats"])
    ev = []
    for n in notes:
        t, lane = n[0], n[1]
        hold = n[2] if len(n) > 2 else 0
        ev.append(
            {
                "t": t,
                "lane": lane,
                "hold": hold,
                "tail": t + hold,
                "grid": grid_index(pos, t),
                "side": side_of(lane),
            }
        )
    return ev


def check_song(song_id, song):
    """1曲分の違反リスト [(曲, 難易度, 制約, 詳細), ...] を返す。"""
    violations = []
    for diff, notes in song["charts"].items():
        ev = _events(song, notes)
        tag = (song_id, diff)

        # C1: 同時押しは最大2つ、ペアは左右に分かれること
        by_time = {}
        for e in ev:
            by_time.setdefault(e["t"], []).append(e)
        for t, group in sorted(by_time.items()):
            if len(group) > 2:
                violations.append(tag + ("C1", f"{t}ms に {len(group)} ノーツの同時押し"))
            elif len(group) == 2 and group[0]["side"] == group[1]["side"]:
                violations.append(
                    tag + ("C1", f"{t}ms に同側ペア {group[0]['lane']}+{group[1]['lane']}")
                )

        # C2: ホールドの帯の中は反対側だけ。同時ホールドは同側同士で重ならない
        holds = [e for e in ev if e["hold"] > 0]
        for h in holds:
            for e in ev:
                if e is not h and h["t"] < e["t"] <= h["tail"] and e["side"] == h["side"]:
                    violations.append(
                        tag
                        + (
                            "C2",
                            f"ホールド（{h['t']}ms・レーン{h['lane']}）の帯の中に"
                            f"同側ノーツ {e['t']}ms・レーン{e['lane']}",
                        )
                    )
        for i, h1 in enumerate(holds):
            for h2 in holds[i + 1 :]:
                if h1["side"] == h2["side"] and h1["t"] < h2["tail"] and h2["t"] < h1["tail"]:
                    violations.append(
                        tag
                        + (
                            "C2",
                            f"同側ホールドの重なり {h1['t']}ms・レーン{h1['lane']} と "
                            f"{h2['t']}ms・レーン{h2['lane']}",
                        )
                    )

        seq = sorted(ev, key=lambda e: (e["grid"], e["lane"]))

        # C3a: 16分チェーン（間隔1ステップ以下）の中で同側3連を作らない
        run = 0
        prev = None
        for e in seq:
            if prev is not None and e["grid"] - prev["grid"] <= 1 and e["side"] == prev["side"]:
                run += 1
            else:
                run = 1
            if run >= 3:
                violations.append(
                    tag
                    + (
                        "C3a",
                        f"{e['t']}ms・レーン{e['lane']} で同側{run}連（16分チェーン内）",
                    )
                )
            prev = e

        # C3b: 同側2レーン交互（間隔2ステップ以下）は4連まで
        for i in range(len(seq)):
            lanes_seen = {seq[i]["lane"]}
            j = i
            while j + 1 < len(seq):
                a, b = seq[j], seq[j + 1]
                if b["side"] != seq[i]["side"]:
                    break
                if b["grid"] - a["grid"] > 2:
                    break
                if b["lane"] == a["lane"]:
                    break
                if b["lane"] not in lanes_seen and len(lanes_seen) >= 2:
                    break
                lanes_seen.add(b["lane"])
                j += 1
            if j - i + 1 >= 5 and len(lanes_seen) == 2:
                violations.append(
                    tag
                    + (
                        "C3b",
                        f"{seq[i]['t']}ms から同側2レーン交互が {j - i + 1} 連"
                        f"（レーン {sorted(lanes_seen)}）",
                    )
                )

        # C4: 同一レーン連続は hard の縦連（間隔170ms以上の3連）だけ
        i = 0
        while i < len(seq):
            j = i
            while j + 1 < len(seq) and seq[j + 1]["lane"] == seq[i]["lane"]:
                j += 1
            if j - i + 1 >= 3:
                run_notes = seq[i : j + 1]
                allowed = (
                    diff == "hard"
                    and len(run_notes) == 3
                    and run_notes[1]["t"] - run_notes[0]["t"] >= JACK_MIN_GAP_MS
                    and run_notes[2]["t"] - run_notes[1]["t"] >= JACK_MIN_GAP_MS
                )
                if not allowed:
                    violations.append(
                        tag
                        + (
                            "C4",
                            f"{run_notes[0]['t']}ms から同一レーン {len(run_notes)} 連",
                        )
                    )
            i = j + 1
    return violations


def check_charts(data):
    """charts.json 全体の違反リストを返す。"""
    violations = []
    for song_id, song in data.items():
        violations.extend(check_song(song_id, song))
    return violations


def summarize(violations):
    """(曲, 難易度, 制約) ごとの件数に集計する。"""
    counts = {}
    for song_id, diff, rule, _detail in violations:
        key = (song_id, diff, rule)
        counts[key] = counts.get(key, 0) + 1
    return counts


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src/data/charts.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    violations = check_charts(data)
    counts = summarize(violations)
    if not violations:
        print(f"two-thumb check: OK（{path}、違反 0 件）")
        return 0
    print(f"two-thumb check: 違反 {len(violations)} 件")
    for (song_id, diff, rule), n in sorted(counts.items()):
        print(f"  {song_id}/{diff} {rule}: {n} 件")
    for v in violations[:20]:
        print(f"  例: {v[0]}/{v[1]} {v[2]}: {v[3]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
