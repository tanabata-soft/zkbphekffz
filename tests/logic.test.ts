import { describe, expect, it } from 'vitest';
import {
  buildPages,
  currentLineIndex,
  fmt,
  lyricsText,
  needsInterlude,
  nextIndex,
  prevAction,
  prevIndex,
  wrapIndex,
  type SyncLine,
} from '../src/logic';
import { COLOPHON, HOWTO_EXTRA, LINER, LINER_TITLES } from '../src/album/album';
import { TRACKS } from '../src/album/tracks';
import { SYNC } from '../src/album/sync';

describe('fmt', () => {
  it('秒を m:ss にする', () => {
    expect(fmt(0)).toBe('0:00');
    expect(fmt(65)).toBe('1:05');
    expect(fmt(178.9)).toBe('2:58');
  });
  it('不正な値は 0:00', () => {
    expect(fmt(NaN)).toBe('0:00');
    expect(fmt(Infinity)).toBe('0:00');
    expect(fmt(-3)).toBe('0:00');
  });
});

describe('曲順の循環', () => {
  it('最後の次は最初、最初の前は最後', () => {
    expect(nextIndex(10, 11)).toBe(0);
    expect(prevIndex(0, 11)).toBe(10);
    expect(wrapIndex(-1, 11)).toBe(10);
    expect(wrapIndex(11, 11)).toBe(0);
  });
});

describe('prevAction（戻るボタンの3秒ルール）', () => {
  it('3秒より進んでいたら先頭へ、以内なら前の曲へ', () => {
    expect(prevAction(3.1)).toBe('restart');
    expect(prevAction(3)).toBe('prev');
    expect(prevAction(0)).toBe('prev');
  });
});

const LINES: SyncLine[] = [
  [0, 'a'],
  [10, 'b'],
  [20, 'c'],
];
describe('currentLineIndex', () => {
  it('時刻に対応する行を返す', () => {
    expect(currentLineIndex(LINES, 0)).toBe(0);
    expect(currentLineIndex(LINES, 9.9)).toBe(0);
    expect(currentLineIndex(LINES, 10)).toBe(1);
    expect(currentLineIndex(LINES, 999)).toBe(2);
  });
  it('1行目より前は -1', () => {
    expect(currentLineIndex([[5, 'x']], 3)).toBe(-1);
    expect(currentLineIndex([], 10)).toBe(-1);
  });
});

describe('needsInterlude / lyricsText', () => {
  it('1行目が3秒より後なら間奏マーカーが要る', () => {
    expect(needsInterlude([[17, 'x']])).toBe(true);
    expect(needsInterlude([[0, 'x']])).toBe(false);
    expect(needsInterlude([])).toBe(false);
  });
  it('歌詞テキストは改行つなぎ', () => {
    expect(lyricsText(LINES)).toBe('a\nb\nc');
  });
});

describe('buildPages', () => {
  const pages = buildPages(TRACKS, SYNC, {
    liner: LINER,
    linerTitles: LINER_TITLES,
    howtoExtra: HOWTO_EXTRA,
    colophon: COLOPHON,
  });
  it('ライナー2 + 曲ページ + 奥付 = 曲数 + 3 ページ', () => {
    expect(pages.length).toBe(TRACKS.length + 3);
  });
  it('曲ページには画像・メタ・歌詞が付く', () => {
    const p = pages[2];
    expect(p.imgTrack).toBe(0);
    expect(p.h3).toBe(TRACKS[0].title);
    expect(p.lyrics).toBe(lyricsText(SYNC[TRACKS[0].src]));
  });
  it('最後は奥付（本文はデータ側の COLOPHON）', () => {
    const last = pages[pages.length - 1];
    expect(last.h4).toBe('COLOPHON');
    expect(last.body).toEqual([...COLOPHON]);
  });
});
