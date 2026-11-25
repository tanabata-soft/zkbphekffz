import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SONGS } from '../src/game/charts';
import {
  clampSpeed,
  effectiveFallSeconds,
  findFlickHit,
  findHit,
  findKeyboardHit,
  findNearestNote,
  makePlayNotes,
  validateCharts,
  type LyricLine,
  type NoteData,
  type SongData,
} from '../src/game/logic';
import { flickSampleToneFor } from '../src/game/sound';

// リズムゲームのデータ（譜面 charts.json / 歌詞 lyrics.json）の整合を担保する。
// 譜面は scripts/generate-charts.py の生成物、歌詞は CD 側の検証済み歌詞同期
// データ（src/album/sync.ts）から scripts/gen-game-lyrics.mjs が変換したもの。

describe('リズムゲームの曲データ', () => {
  it('収録曲は2曲で、CD 側の曲順・曲名とそろっている', () => {
    expect(SONGS.map((s) => s.id)).toEqual(['chocomint', 'tokeruyoru']);
    expect(SONGS.map((s) => s.data.title)).toEqual(['チョコミントの残像', 'Chocomintの溶ける夜']);
  });

  it('全曲の譜面が検証を通る（昇順・レーン・長押し・難易度ごとのノーツ数）', () => {
    for (const entry of SONGS) {
      expect(validateCharts(entry.data), entry.id).toEqual([]);
    }
  });

  it('テーマ色は全曲に #rrggbb で入っている', () => {
    for (const entry of SONGS) {
      expect(entry.accent, entry.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(entry.accentRgb, entry.id).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      expect(typeof entry.bonus, entry.id).toBe('boolean');
    }
  });

  it('歌詞は全曲にあり、行が昇順で、尺の範囲内にある', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../src/game/data/lyrics.json', import.meta.url), 'utf8'),
    ) as Record<string, LyricLine[]>;
    for (const entry of SONGS) {
      const lines = raw[entry.id];
      expect(lines, entry.id).toBeDefined();
      expect(lines.length).toBeGreaterThan(0);
      expect(entry.lyrics.length).toBe(lines.length);
      let prevStart = -1;
      for (const line of lines) {
        expect(line.text.trim()).not.toBe('');
        expect(line.startMs).toBeGreaterThan(prevStart);
        expect(line.endMs).toBeGreaterThan(line.startMs);
        expect(line.startMs).toBeLessThan(entry.data.durationMs);
        expect(line.endMs).toBeLessThanOrEqual(entry.data.durationMs);
        prevStart = line.startMs;
      }
    }
  });

  it('歌詞の行数と開始時刻が、CD 側の歌詞同期データ（sync.ts）と一致する', () => {
    const syncText = readFileSync(new URL('../src/album/sync.ts', import.meta.url), 'utf8');
    const objStart = syncText.indexOf('{', syncText.indexOf('='));
    const sync = JSON.parse(
      syncText.slice(objStart, syncText.lastIndexOf('}') + 1).replace(/,\s*([}\]])/g, '$1'),
    ) as Record<string, [number, string][]>;
    const idByTitle: Record<string, string> = {
      'チョコミントの残像': 'chocomint',
      'Chocomintの溶ける夜': 'tokeruyoru',
    };
    for (const [title, lines] of Object.entries(sync)) {
      const entry = SONGS.find((s) => s.id === idByTitle[title]);
      expect(entry, title).toBeDefined();
      expect(entry?.lyrics.map((l) => [l.startMs, l.text])).toEqual(
        lines.map(([sec, text]) => [Math.round(sec * 1000), text]),
      );
    }
  });
});

// ---- フリックノーツと速度調整（テンプレートへの移植分） ----

/** validateCharts 用の最小の曲データ。3難易度とも同じ譜面にする（ノーツ数は同数で検証を通る） */
function songWith(chart: NoteData[]): SongData {
  return {
    title: 'テスト曲',
    durationMs: 60000,
    bpm: 120,
    fever: [],
    charts: { easy: chart, normal: chart, hard: chart },
  };
}

describe('フリックノーツの読み込みと判定', () => {
  it('[t, lane, 0, "flick"] 形式をフリックとして読み込み、従来形式は通常ノーツのまま', () => {
    const notes = makePlayNotes(
      [
        [3000, 0],
        [4000, 1, 800],
        [5000, 2, 0, 'flick'],
      ],
      0,
    );
    expect(notes.map((n) => n.flick)).toEqual([false, false, true]);
    expect(notes[2].holdMs).toBe(0);
    // オフセットは従来どおり時刻へ加わる
    expect(makePlayNotes([[5000, 2, 0, 'flick']], 100)[0].timeMs).toBe(5100);
  });

  it('タップ（findHit）ではフリックノーツは取れず、通常ノーツは従来どおり取れる', () => {
    const only = makePlayNotes([[5000, 1, 0, 'flick']], 0);
    expect(findHit(only, 1, 5000)).toBeNull();
    // フリックが手前にあっても、窓内の通常ノーツはタップで取れる
    const mixed = makePlayNotes(
      [
        [5000, 1, 0, 'flick'],
        [5080, 1],
      ],
      0,
    );
    const hit = findHit(mixed, 1, 5050);
    expect(hit?.note.flick).toBe(false);
    expect(hit?.judge).toBe('perfect');
  });

  it('フリック（findFlickHit）はフリックノーツ優先で、無ければ通常ノーツ（長押しの頭は除く）を取る', () => {
    const mixed = makePlayNotes(
      [
        [5000, 1],
        [5120, 1, 0, 'flick'],
      ],
      0,
    );
    // 通常ノーツの方が近くても、フリックノーツを優先する
    const hit = findFlickHit(mixed, 1, 5030);
    expect(hit?.note.flick).toBe(true);
    // フリックだけ通常ノーツも取る（判定は時刻差どおり）
    const tapOnly = makePlayNotes([[5000, 2]], 0);
    expect(findFlickHit(tapOnly, 2, 5070)?.judge).toBe('great');
    // 長押しの頭はフリックでは取らない
    const holdOnly = makePlayNotes([[5000, 2, 900]], 0);
    expect(findFlickHit(holdOnly, 2, 5000)).toBeNull();
    // 窓の外は null
    expect(findFlickHit(mixed, 1, 4000)).toBeNull();
  });

  it('キーボード（findKeyboardHit）はフリックノーツも通常のキー押しで取れる', () => {
    const notes = makePlayNotes([[5000, 3, 0, 'flick']], 0);
    const hit = findKeyboardHit(notes, 3, 5000);
    expect(hit?.note.flick).toBe(true);
    expect(hit?.judge).toBe('perfect');
  });

  it('findNearestNote は種別を問わず最寄りを返し、最寄りがフリックかどうか判定できる', () => {
    const notes = makePlayNotes(
      [
        [5000, 0, 0, 'flick'],
        [5300, 0],
      ],
      0,
    );
    expect(findNearestNote(notes, 0, 5010)?.flick).toBe(true);
    expect(findNearestNote(notes, 0, 9000)).toBeNull();
  });

  it('譜面検証: フリック形式は通り、フリック＋長押しの併記はエラー。従来譜面も従来どおり通る', () => {
    const base: NoteData[] = [
      [3000, 0],
      [4000, 1, 0, 'flick'],
      [5000, 2],
    ];
    expect(validateCharts(songWith(base))).toEqual([]);
    const bad: NoteData[] = [
      [3000, 0],
      [4000, 1, 500, 'flick'],
      [5000, 2],
    ];
    expect(validateCharts(songWith(bad)).some((e) => e.includes('フリック'))).toBe(true);
    // テンプレート収録曲（フリックなし）も検証を通し続ける
    for (const entry of SONGS) expect(validateCharts(entry.data), entry.id).toEqual([]);
  });

  it('フリック成功音（H2 サンプル）のパラメータ: PERFECT が原音（レート1）で最も大きく、tier でピッチが上がる', () => {
    const perfect = flickSampleToneFor('perfect', 0);
    const good = flickSampleToneFor('good', 0);
    expect(perfect.rate).toBe(1);
    expect(perfect.rate).toBeGreaterThan(good.rate);
    expect(perfect.peak).toBeGreaterThan(good.peak);
    expect(flickSampleToneFor('perfect', 2).rate).toBeGreaterThan(perfect.rate);
  });
});

describe('ノーツ速度の調整', () => {
  it('clampSpeed は ×0.8〜×2.0 に 0.1 刻みで丸め、不正値は ×1.0', () => {
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(1.26)).toBe(1.3);
    expect(clampSpeed(0.5)).toBe(0.8);
    expect(clampSpeed(3)).toBe(2);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it('effectiveFallSeconds は倍率で落下時間を割る（×1.0 は従来どおり）', () => {
    expect(effectiveFallSeconds(2.0, 1)).toBe(2.0);
    expect(effectiveFallSeconds(2.0, 2)).toBe(1.0);
    expect(effectiveFallSeconds(1.6, 0.8)).toBeCloseTo(2.0);
  });
});
