// 曲と譜面のデータを組み立てる（エンジン側）。
// 曲リストそのものは作品データの src/game/songs.ts（SONG_DEFS）が正本。
// 譜面は src/game/data/charts.json（scripts/generate-charts.py が音源解析で生成）、
// 歌詞は src/game/data/lyrics.json（scripts/gen-game-lyrics.mjs が CD 側の
// 検証済み歌詞同期データ src/album/sync.ts から変換して生成）。
import type { LyricLine, SongData, SongId } from './logic';
import raw from './data/charts.json';
import lyricsRaw from './data/lyrics.json';
import { SONG_DEFS } from './songs';

export interface SongEntry {
  id: SongId;
  data: SongData;
  /** 音源ファイルの URL（ビルドで assets に出力され、Service Worker の precache に入る） */
  audioUrl: string;
  /** ジャケット絵の URL */
  jacketUrl: string;
  /**
   * ジャケット絵の四辺に焼き込まれた紙枠の幅（実画像ピクセル。絵は 1024×1024）。
   * 演奏画面の背景では、この枠を除いた内側の絵だけを幅いっぱいの正方形で敷く
   * （枠をなくして背景になじませる）。メニューのカルーセルや CD 側のジャケット
   * 表示には使わない（枠も含めて見せる）。作品ごとの値は songs.ts に置く。
   */
  frameInset: number;
  /** カルーセルでのジャケットの寄せ（CSS の object-position）。未指定は中央 */
  slidePosition?: string;
  /**
   * 曲のテーマ色（#rrggbb）。メニューの枠・光・ボタンなどのアクセント色に使う
   * （選曲に合わせて切り替わる。オーナー決定 2026-11-20 のパターン3）。
   * ジャケットから抜き出した代表色を、視認性のために明るくしてある。
   * 作品ごとの値は songs.ts に置く。
   */
  accent: string;
  /** accent の RGB 三つ組み（CSS の rgb(var(--song-accent-rgb) / α) 用） */
  accentRgb: string;
  /** ボーナストラックか（CD 側 tracks.ts の bonus と一致させる。スライドに BONUS チップが出る） */
  bonus: boolean;
  /** 収録アルバム名（表示用） */
  album: string;
  genre: string;
  /** 歌詞行（尺まで。無い曲は空配列） */
  lyrics: LyricLine[];
}

const songs = raw as unknown as Record<SongId, SongData>;
const lyrics = lyricsRaw as unknown as Record<SongId, LyricLine[]>;

const accentRgbOf = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

export const SONGS: SongEntry[] = SONG_DEFS.map((def) => ({
  id: def.id,
  data: songs[def.id],
  lyrics: lyrics[def.id] ?? [],
  audioUrl: def.audioUrl,
  jacketUrl: def.jacketUrl,
  frameInset: def.frameInset,
  slidePosition: def.slidePosition,
  accent: def.accent,
  accentRgb: accentRgbOf(def.accent),
  bonus: def.bonus ?? false,
  album: def.album,
  genre: def.genre,
}));

export const songById = (id: SongId): SongEntry => SONGS.find((s) => s.id === id) ?? SONGS[0];
