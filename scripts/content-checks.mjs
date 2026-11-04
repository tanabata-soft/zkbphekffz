// 内容の整合チェックの中身（scripts/check-content.mjs から呼ばれる）。
// 正本と派生物が食い違っていないかを確かめる検査を、ここに { id, title, run } で足す。
// run はエラーの文言の配列を返す（問題がなければ空）。ctx.root はリポジトリのルートのパス。
// 例（データ駆動のアプリ）: 物語データ ⇔ 読み上げ文・ルビ・音声ファイルの対応、到達できない場面や結末の検出、件数・重複・必須項目。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
/** `const 名前 = '値'` の形で書かれた文字列を取り出す（vite.config.ts の設定用） */
const constString = (text, name) => new RegExp(`const ${name} = '([^']*)'`).exec(text)?.[1];

export const checks = [
  {
    id: 'app-name',
    title: 'アプリ名が vite.config.ts と index.html でそろっている',
    // アプリ名は vite.config.ts の APP_NAME と index.html の2か所に書く決まり（vite.config.ts のコメント参照）。
    // 片方だけ書き換える事故を防ぐ。
    run({ root }) {
      const name = constString(read(root, 'vite.config.ts'), 'APP_NAME');
      if (!name) return ['vite.config.ts に APP_NAME が見つかりません'];
      const html = read(root, 'index.html');
      const errors = [];
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
      if (title !== name) errors.push(`index.html の <title>（${title}）が APP_NAME（${name}）と違います`);
      const appleTitle = /name="apple-mobile-web-app-title" content="([^"]*)"/.exec(html)?.[1];
      if (appleTitle !== name) errors.push(`index.html の apple-mobile-web-app-title（${appleTitle}）が APP_NAME（${name}）と違います`);
      return errors;
    },
  },
  {
    id: 'theme-color',
    title: 'テーマカラーが vite.config.ts と index.html でそろっている',
    run({ root }) {
      const color = constString(read(root, 'vite.config.ts'), 'THEME_COLOR');
      if (!color) return ['vite.config.ts に THEME_COLOR が見つかりません'];
      const html = read(root, 'index.html');
      const meta = /name="theme-color" content="([^"]*)"/.exec(html)?.[1];
      return meta === color ? [] : [`index.html の theme-color（${meta}）が THEME_COLOR（${color}）と違います`];
    },
  },
  {
    id: 'sync-keys',
    title: '歌詞データ（src/album/sync.ts）のキーが、曲目（src/album/tracks.ts の src）とそろっている',
    // 曲を足し替えるときに、歌詞データの付け替えを忘れる事故を防ぐ。
    run({ root }) {
      const data = read(root, 'src/album/tracks.ts');
      const srcs = [...data.matchAll(/src: '([^']+)'/g)].map((m) => m[1]);
      const sync = read(root, 'src/album/sync.ts');
      const keys = [...sync.matchAll(/"([^"]+)": \[\[/g)].map((m) => m[1]);
      const errors = [];
      for (const s of srcs) if (!keys.includes(s)) errors.push(`sync.ts に歌詞がありません: ${s}`);
      for (const k of keys) if (!srcs.includes(k)) errors.push(`tracks.ts に無い曲の歌詞が sync.ts にあります: ${k}`);
      if (srcs.length !== keys.length) errors.push(`曲数（${srcs.length}）と歌詞データの数（${keys.length}）が違います`);
      return errors;
    },
  },
  {
    id: 'media-count',
    title: 'メディア（src/album/media.ts の画像・音源）の数が曲数とそろっている',
    run({ root }) {
      const data = read(root, 'src/album/tracks.ts');
      const n = [...data.matchAll(/src: '([^']+)'/g)].length;
      const media = read(root, 'src/album/media.ts');
      const imgs = [...media.matchAll(/from '\.\/assets\/img\/track\d+\.jpg'/g)].length;
      const audios = [...media.matchAll(/from '\.\/assets\/audio\/track\d+\.mp4'/g)].length;
      const errors = [];
      if (imgs !== n) errors.push(`曲の画像が ${imgs} 件で、曲数 ${n} と違います`);
      if (audios !== n) errors.push(`曲の音源が ${audios} 件で、曲数 ${n} と違います`);
      return errors;
    },
  },
];
