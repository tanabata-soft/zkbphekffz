// リズムゲームの収録曲リスト（作品データ。ここは作品ごとに書き換える場所で、
// エンジン側の部品ではない。CD 側の作品データが src/album/ にあるのと同じ考え方）。
//
// 1曲ごとに決めるもの:
// - id: 曲 ID（半角英数の短い名前。譜面・歌詞データのキーになる。公開後に変えない）
// - audioUrl / jacketUrl: 音源とジャケット。音源は制作入口で用意した唯一の
//   正規音源 MP3 192kbps（src/game/assets/track0N.mp3。CD 側プレイヤーも
//   同じ音源を src/album/assets/audio/track0N.mp3 として参照し、ビルドでは
//   内容が同一のため dist 上は1ファイルにまとまる）、ジャケットは
//   CD 側の曲ジャケット（1024×1024）のコピー。作り方は docs/PRODUCTION.md の
//   「リズムゲーム（任意モジュール）」参照
// - frameInset: ジャケット絵の四辺に焼き込まれた紙枠の幅（実画像ピクセル、絵は
//   1024×1024）。演奏画面の背景では、この枠を除いた内側の絵だけを敷く。
//   枠が無い絵は 0
// - slidePosition: メニューのカルーセルでジャケットを寄せる位置（CSS の
//   object-position）。絵の中の曲タイトルができるだけ収まる側へ寄せる。
//   未指定なら中央
// - accent: 曲のテーマ色（#rrggbb）。メニューの枠・光・ボタンなどのアクセント色
//   として、選曲に合わせて切り替わる（オーナー決定 2026-11-20 のパターン3）。
//   ジャケットから scripts/jacket-accent.py で抜き出す（視認性のために明度・
//   彩度を持ち上げる処理込み）
// - bonus: ボーナストラックなら true（CD 側 tracks.ts の bonus と一致させる）。
//   スライドの先頭に金色の BONUS チップが出る
// - album: 収録アルバム名（表示用） / genre: ジャンル（表示用）
//
// 譜面（data/charts.json）と歌詞（data/lyrics.json）は生成物なので、ここには
// 書かない。生成手順は docs/PRODUCTION.md 参照。
import track01Audio from './assets/track01.mp3';
import track01Jacket from './assets/track01.jpg';
import track02Audio from './assets/track02.mp3';
import track02Jacket from './assets/track02.jpg';

export interface GameSongDef {
  id: string;
  audioUrl: string;
  jacketUrl: string;
  frameInset: number;
  slidePosition?: string;
  accent: string;
  bonus?: boolean;
  album: string;
  genre: string;
}

// NK-S001『チョコミントの残像』の収録曲（2026-11-25、v2.0.0 でリズムゲームを
// 後付け。エンジン v1.18.0 のモジュールを統合）。
// frameInset は両曲とも 0: 目視で四辺に均一な帯は無く、実測でも暖色テスト
// （R-B>22 の紙色画素）と無彩色テスト（低彩度・高明度画素）のどちらでも、
// 四辺すべてで占有率 0.9 以上の帯は 0px だった（2026-11-25 実測）。
// accent は scripts/jacket-accent.py の抽出値。
export const SONG_DEFS: GameSongDef[] = [
  {
    id: 'chocomint',
    audioUrl: track01Audio,
    jacketUrl: track01Jacket,
    frameInset: 0,
    accent: '#5191d6',
    album: 'NK-S001 チョコミントの残像',
    genre: 'Neon Karaoke Rock',
  },
  {
    id: 'tokeruyoru',
    audioUrl: track02Audio,
    jacketUrl: track02Jacket,
    frameInset: 0,
    accent: '#51b4d6',
    album: 'NK-S001 チョコミントの残像',
    genre: 'Snow Ballad',
  },
];
