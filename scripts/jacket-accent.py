#!/usr/bin/env python3
"""ジャケット絵から、リズムゲームの曲テーマ色（accent）を抜き出す。

使い方: python3 scripts/jacket-accent.py src/game/assets/track01.jpg
出力された #rrggbb を src/game/songs.ts の accent に書く。

決め方（2026-11-20、NK-S002 でのオーナー承認パターン3に合わせて固定）:
- 絵を 64×64 に縮小し、彩度と明度で重み付けした平均色を代表色とする
  （鮮やかな部分がその曲の印象になる）
- 暗い画面の枠・光として読めるよう、HSL で明度を 0.58〜0.68 に、
  彩度を 0.62 以上に持ち上げる（視認性の担保）
"""
import colorsys
import sys

import numpy as np
from PIL import Image


def accent(path: str) -> str:
    im = Image.open(path).convert('RGB').resize((64, 64))
    px = np.asarray(im).reshape(-1, 3).astype(float) / 255.0
    mx, mn = px.max(axis=1), px.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    if sat.mean() < 0.02:
        # モノクロの絵（NK-S009『Flavor』など）: 色味が無いので、平均の
        # かすかな色相（無ければ暖色 36°）を残した中立色にする。最終的には
        # 作品の世界観に合わせて songs.ts で手で決め直してよい
        avg = px.mean(axis=0)
        h, _l, s = colorsys.rgb_to_hls(*avg)
        if s < 0.02:
            h, s = 36 / 360, 0.30
        r, g, b = colorsys.hls_to_rgb(h, 0.66, min(s, 0.35))
        return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))
    w = (sat ** 2) * (0.35 + mx)
    avg = (px * w[:, None]).sum(axis=0) / w.sum()
    h, l, s = colorsys.rgb_to_hls(*avg)
    l = min(max(l, 0.58), 0.68)
    s = max(s, 0.62)
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))


if __name__ == '__main__':
    for path in sys.argv[1:]:
        print(f'{path}: {accent(path)}')
