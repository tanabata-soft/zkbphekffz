// アプリアイコンの確認: npm run icons
// このアプリのアイコンは、表ジャケットの絵から作った PNG（public/icons/）を正本としてリポジトリに置く。
// ジャケットが変わったら、下の手順で作り直して置き換えること（図形を描く生成はしない）。
//   元絵: src/album/assets/img/jacket.jpg
//   icon-192.png / icon-512.png / apple-touch-icon.png（180）: 絵を全面に使う
//   icon-maskable-512.png: 端末に切り抜かれても絵が欠けないよう、絵を中央 80% に縮小し、周囲を藍色（#101a30）で埋める
// このスクリプトは、置かれた PNG の寸法が manifest の宣言と合っているかを確認する。
import { readFileSync } from 'node:fs';

const EXPECTED = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-512.png': 512,
  'apple-touch-icon.png': 180,
};

let failed = false;
for (const [name, size] of Object.entries(EXPECTED)) {
  const path = new URL(`../public/icons/${name}`, import.meta.url);
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    console.error(`✗ public/icons/${name} がありません（ジャケット絵から作って置いてください）`);
    failed = true;
    continue;
  }
  const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
  const w = isPng ? buf.readUInt32BE(16) : 0;
  const h = isPng ? buf.readUInt32BE(20) : 0;
  if (!isPng || w !== size || h !== size) {
    console.error(`✗ public/icons/${name} の寸法が ${w}x${h} で、期待する ${size}x${size} と違います`);
    failed = true;
  } else {
    console.log(`✓ public/icons/${name} (${size}x${size})`);
  }
}
if (failed) process.exit(1);
console.log('icons: ジャケット由来のアイコンがそろっています');
