// リズムゲームの歌詞データ（src/game/data/lyrics.json）を、CD 側で検証済みの
// 歌詞同期データ（src/album/sync.ts の SYNC）から変換して生成する。
//
// 字幕（mov_text）から取り直さないこと。NK-S003 では字幕の表示時刻が実唱と
// 約7〜12秒ずれた事故があり、sync.ts の時刻は文字起こしとの照合で付け直し済み
// （v1.0.1 / v1.0.3）。ゲームの歌詞も、その検証済みの時刻を正とする。
//
// 形式の変換だけを行う: [開始秒, 行] の列 → { text, startMs, endMs } の列。
// endMs は次の行の startMs。最終行は「開始 + 4秒」と曲の尺（tracks.ts の time）の
// うち小さい方。
// 使い方: node scripts/gen-game-lyrics.mjs
import { readFileSync, writeFileSync } from 'node:fs';

/** 曲名（sync.ts / tracks.ts のキー）→ リズムゲーム側の曲 ID（作品ごとに書き換える。
 *  ID は src/game/songs.ts の SONG_DEFS とそろえる） */
const ID_BY_TITLE = {
  'チョコミントの残像': 'chocomint',
  'Chocomintの溶ける夜': 'tokeruyoru',
};

const syncText = readFileSync(new URL('../src/album/sync.ts', import.meta.url), 'utf8');
// SYNC のオブジェクトリテラル部分は JSON 互換として読む（末尾カンマだけ落とす。
// 雛形の sync.ts のように手書きで末尾カンマが付いていても読めるように）
const objStart = syncText.indexOf('{', syncText.indexOf('='));
const objEnd = syncText.lastIndexOf('}');
const sync = JSON.parse(syncText.slice(objStart, objEnd + 1).replace(/,\s*([}\]])/g, '$1'));

// 曲の尺は tracks.ts の time（プレイヤー表示に合わせて実測で確定した値）を正とする。
// ただしゲームが実際に再生するのは MP3 で、尺はエンコードで僅かに短くなる
// （例: 京葉線の午後は表示 180.0秒に対し MP3 は 179.7秒）。譜面データ
// （charts.json）が既にある場合は、その durationMs（MP3 の実尺）でさらに締める。
const tracksText = readFileSync(new URL('../src/album/tracks.ts', import.meta.url), 'utf8');
const durationByTitle = {};
for (const m of tracksText.matchAll(/title: '([^']+)'[^}]*?time: '(\d+):(\d+)'/g)) {
  durationByTitle[m[1]] = Number(m[2]) * 60 + Number(m[3]);
}
try {
  const charts = JSON.parse(readFileSync(new URL('../src/game/data/charts.json', import.meta.url), 'utf8'));
  for (const [title, id] of Object.entries(ID_BY_TITLE)) {
    if (charts[id]?.durationMs) {
      durationByTitle[title] = Math.min(durationByTitle[title] ?? Infinity, charts[id].durationMs / 1000);
    }
  }
} catch {
  // charts.json がまだ無い場合は tracks.ts の尺だけで作る（譜面生成後に再実行すると締まる）
}

const out = {};
for (const [title, lines] of Object.entries(sync)) {
  const id = ID_BY_TITLE[title];
  if (!id) throw new Error(`曲 ID が未定義の曲が sync.ts にあります: ${title}`);
  const durationMs = (durationByTitle[title] ?? 0) * 1000;
  if (!durationMs) throw new Error(`tracks.ts に尺が見つかりません: ${title}`);
  out[id] = lines.map(([startSec, text], i) => {
    const startMs = Math.round(startSec * 1000);
    const nextMs = i + 1 < lines.length ? Math.round(lines[i + 1][0] * 1000) : durationMs;
    const endMs = i + 1 < lines.length ? nextMs : Math.min(startMs + 4000, durationMs);
    return { text, startMs, endMs };
  });
  console.log(`${id} (${title}): ${lines.length} 行`);
}

writeFileSync(new URL('../src/game/data/lyrics.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('src/game/data/lyrics.json を書き出した');
