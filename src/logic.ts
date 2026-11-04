// アルバムのロジック（純関数）。DOM・時刻・乱数に触れず、単体テストだけで確かめられるように保つ（eslint.config.js が強制）。

/** 曲のメタ情報（src は歌詞データ SYNC のキー） */
export interface TrackMeta {
  src: string;
  title: string;
  genre: string;
  time: string;
  bonus?: boolean;
  note: string;
}

/** 歌詞の 1 行（開始秒, 本文） */
export type SyncLine = readonly [number, string];

/** 秒を m:ss に整形する（不正な値は 0:00） */
export function fmt(s: number): string {
  if (!isFinite(s)) return '0:00';
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

/** 曲順を端で循環させる（最後の次は最初、最初の前は最後） */
export function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

export function nextIndex(cur: number, n: number): number {
  return wrapIndex(cur + 1, n);
}

export function prevIndex(cur: number, n: number): number {
  return wrapIndex(cur - 1, n);
}

/** 「前」ボタンの挙動: 3 秒より進んでいたら曲の先頭へ、3 秒以内なら前の曲へ（Spotify など一般的な方式） */
export function prevAction(currentTime: number): 'restart' | 'prev' {
  return currentTime > 3 ? 'restart' : 'prev';
}

/** 時刻 now に対応する歌詞行の番号（まだ始まっていなければ -1） */
export function currentLineIndex(lines: readonly SyncLine[], now: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] <= now) idx = i;
    else break;
  }
  return idx;
}

/** 1 行目が 3 秒より後に始まる曲は、先頭に ♪（間奏）マーカーを出す */
export function needsInterlude(lines: readonly SyncLine[]): boolean {
  return lines.length > 0 && lines[0][0] > 3;
}

/** ブックレット用の歌詞テキスト（行を改行でつなぐ） */
export function lyricsText(lines: readonly SyncLine[]): string {
  return lines.map((l) => l[1]).join('\n');
}

/** ブックレットのページ */
export interface BookPage {
  /** 曲の番号（0 始まり）。画像は main 側で割り当てる */
  imgTrack?: number;
  h4: string;
  h3: string;
  meta?: string;
  body: string[];
  lyrics?: string;
}

/** ブックレットの文章（ライナー・奥付）。文面そのものはデータ側（src/album/album.ts）が持つ */
export interface BookletTexts {
  liner: readonly [string, string, string];
  /** ライナー2ページの見出し */
  linerTitles: readonly [string, string];
  howtoExtra: string;
  colophon: string[];
}

/** ブックレットのページ構成（ライナー 2 ページ + 曲ページ + 奥付） */
export function buildPages(
  tracks: readonly TrackMeta[],
  sync: Record<string, readonly SyncLine[]>,
  texts: BookletTexts,
): BookPage[] {
  const pages: BookPage[] = [];
  pages.push({ h4: 'LINER NOTES', h3: texts.linerTitles[0], body: [texts.liner[0], texts.liner[1]] });
  pages.push({
    h4: 'LINER NOTES',
    h3: texts.linerTitles[1],
    body: [texts.liner[2], texts.howtoExtra],
  });
  tracks.forEach((t, i) => {
    pages.push({
      imgTrack: i,
      h4: `TRACK ${i + 1}${t.bonus ? ' ― BONUS TRACK' : ''}`,
      h3: t.title,
      meta: `${t.genre}／${t.time}`,
      body: [t.note],
      lyrics: lyricsText(sync[t.src] ?? []),
    });
  });
  pages.push({
    h4: 'COLOPHON',
    h3: '奥付',
    body: [...texts.colophon],
  });
  return pages;
}
