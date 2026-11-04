// 収録メディア（曲ごとのジャケット画像と音源）。Vite が dist/assets へ配置する。
// 音源は事前キャッシュに入れず、初回起動時に一括ダウンロードして実行時キャッシュへ入れる（src/download.ts）。
import img01 from './assets/img/track01.jpg';
import img02 from './assets/img/track02.jpg';
import audio01 from './assets/audio/track01.mp4';
import audio02 from './assets/audio/track02.mp4';

/** 曲ごとのジャケット画像（TRACKS と同じ順） */
export const TRACK_IMG: string[] = [img01, img02];

/** 曲ごとの音源（TRACKS と同じ順） */
export const TRACK_AUDIO: string[] = [audio01, audio02];
