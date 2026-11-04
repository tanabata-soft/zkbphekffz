// 曲目と解説（このシングルのデータ）。src は歌詞データ（src/album/sync.ts）のキー。
// 並びが曲順。1曲目が表題曲、2曲目がカップリング（docs/SINGLE.md）。
import type { TrackMeta } from '../logic';

export const TRACKS: TrackMeta[] = [
  { src: 'チョコミントの残像', title: 'チョコミントの残像', genre: 'Neon Karaoke Rock', time: '2:11', note: 'カラオケの密室から切り裂く、終わらない夜。命を焦がして歌い上げる表題曲。' },
  { src: 'Chocomintの溶ける夜', title: 'Chocomintの溶ける夜', genre: 'Snow Ballad', time: '3:00', note: '旅立ちの朝の前に、もう一度だけ。英語とフランス語の囁きが溶ける雪のバラード。' },
];
