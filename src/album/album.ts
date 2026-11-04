// このシングルの基本情報と、裏面ノートの文章。
// エンジン（src/ のほかのファイル）は、このフォルダ（src/album/）のデータだけを差し替えれば
// 別の作品になるよう作られている。新しい作品の作り方は docs/PRODUCTION.md、
// シングルの仕様は docs/SINGLE.md を参照。

export const ALBUM: {
  title: string;
  catalog: string;
  format: string;
  layout: 'album' | 'single';
} = {
  /** 題名（表題曲と同名） */
  title: 'チョコミントの残像',
  /** カタログ番号 */
  catalog: 'NK-S001',
  /** 形式の呼び名 */
  format: 'デジタルシングルCD',
  /** 形: 'album'（正方形ジャケット＋ブックレット） / 'single'（短冊型ジャケット＋裏面ノート、ブックレットなし） */
  layout: 'single',
};

/** 裏ジャケット下部の表記（例: NK-S001 ／ デジタルシングルCD） */
export const FOOT_NOTE = `${ALBUM.catalog} ／ ${ALBUM.format}`;

/** 裏面ノートの本文（シングルではブックレットの代わりにジャケット裏面へ置く） */
export const NOTE: string[] = [
  'カラオケボックスの小さな部屋で生まれた2曲を、短冊に閉じ込めた。千葉の夜、潮風とネオン。',
  '表題曲は、歌うことでしか前に進めない夜の歌。チョコミントの憂鬱を、極彩色の火花に変えるまで歌い続ける。',
  'カップリングは、別れの前夜のバラード。分けたチョコミントの味と、言えなかった「行かないで」を、雪の千葉に残していく。',
];

/** ライナーノーツ（アルバム形態のブックレット冒頭。本文は NOTE と共通） */
export const LINER: readonly [string, string, string] = [NOTE[0], NOTE[1], NOTE[2]];

/** ライナーノーツの見出し（アルバム形態のブックレット冒頭2ページ） */
export const LINER_TITLES: readonly [string, string] = ['短冊に閉じ込めた2曲', '聴き方について'];

/** ブックレット「聴き方について」のページに置く一文（アルバム形態用） */
export const HOWTO_EXTRA = '再生画面では歌詞が曲に合わせて流れます。ジャケットをめくると、裏面にノートがあります。';

/** 奥付（シングルでは裏面ノートの下部に置く） */
export const COLOPHON: string[] = [
  `『${ALBUM.title}』（全2曲／総再生時間 約5分）`,
  `${ALBUM.catalog} ― ${ALBUM.format}`,
  '歌詞は音源の字幕をもとに収録しました。',
];
