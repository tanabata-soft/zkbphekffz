// 収録データの整合（曲目 ⇔ 歌詞データ ⇔ メディア）。データ駆動アプリの検証はここに置く（CLAUDE.md）。
// 曲数や収録内容に依存しない、データ一般の決まりだけを確かめる（新しいアルバムでもそのまま使える）。
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../src/album/tracks';
import { SYNC } from '../src/album/sync';
import { TRACK_AUDIO, TRACK_IMG } from '../src/album/media';

describe('収録データの整合', () => {
  it('曲が1曲以上ある', () => {
    expect(TRACKS.length).toBeGreaterThan(0);
  });

  it('ボーナストラックは末尾にだけ置ける', () => {
    TRACKS.forEach((t, i) => {
      if (t.bonus) expect(i).toBe(TRACKS.length - 1);
    });
  });

  it('全曲に歌詞データがあり、キーが曲の src と一致する', () => {
    for (const t of TRACKS) {
      expect(SYNC[t.src], `SYNC に ${t.src} がありません`).toBeDefined();
      expect(SYNC[t.src].length).toBeGreaterThan(0);
    }
    expect(Object.keys(SYNC).length).toBe(TRACKS.length);
  });

  it('歌詞の時刻は全曲単調増加で、本文が空でない', () => {
    for (const t of TRACKS) {
      const lines = SYNC[t.src];
      for (let i = 0; i < lines.length; i++) {
        expect(lines[i][1].length, `${t.title} ${i + 1} 行目の本文が空`).toBeGreaterThan(0);
        if (i > 0) expect(lines[i][0], `${t.title} ${i + 1} 行目の時刻が前行以下`).toBeGreaterThan(lines[i - 1][0]);
      }
    }
  });

  it('画像と音源の数が曲数と一致する', () => {
    expect(TRACK_IMG.length).toBe(TRACKS.length);
    expect(TRACK_AUDIO.length).toBe(TRACKS.length);
  });

  it('タイトルに重複がない', () => {
    expect(new Set(TRACKS.map((t) => t.title)).size).toBe(TRACKS.length);
  });
});
