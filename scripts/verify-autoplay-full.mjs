// オートプレイ全通し確認: デバッグモード（バージョン5回タップのパネル）のオートプレイで全曲・hard を
// 実時間で最後まで再生し、フルコンボ（MISS 0・最大コンボ＝全ノーツ数）に
// 到達することを確かめる。譜面を再生成したときの完走可能性チェック用。
// 対象の曲は src/game/data/charts.json の全曲（曲を足せば自動で対象になる）。
// 1曲あたり実時間（曲の長さ）がかかるので、通常の E2E（npm run test:e2e）には
// 入れず、譜面を作り替えたときにだけ手で実行する。
// 使い方: npm run build && node scripts/verify-autoplay-full.mjs
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';

const charts = JSON.parse(readFileSync(new URL('../src/game/data/charts.json', import.meta.url), 'utf8'));
const SONGS = Object.entries(charts).map(([id, data]) => ({ id, label: data.title ?? id }));
// デバッグモードの保存キーはアプリ ID（package.json の name）から決まる
const { name: appId } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const server = await preview({ preview: { port: 4176, strictPort: true }, logLevel: 'warn' });
const url = 'http://localhost:4176/';
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
let failed = false;
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.error(`pageerror: ${e.message}`);
  });
  // デバッグモード（バージョン表示の5回タップで出るパネル）を最初からオンにする
  await page.addInitScript(`localStorage.setItem('${appId}.debug', '1')`);
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__appStarted === true);
  // リズムゲームへ入る（CD 側のトップから「遊ぶ」ボタン）
  await page.locator('#btn-open-game').click();
  await page.waitForFunction("!document.getElementById('menu-screen').hidden", null, { timeout: 10_000 });

  // デバッグパネルの「自動」でオートプレイを有効化（設定には置いていない）
  await page.locator('#debug-panel button[title*="オートプレイ"]').click();
  await page.waitForFunction("document.body.dataset.autoplay === 'on'", null, { timeout: 10_000 });
  await page.getByRole('button', { name: 'むずかしい' }).click();

  for (const song of SONGS) {
    const total = charts[song.id].charts.hard.length;
    const durationMs = charts[song.id].durationMs;
    await page.locator(`.carousel-slide[data-song="${song.id}"]`).click();
    await page.getByRole('button', { name: 'スタート' }).click();
    await page.waitForFunction("document.body.dataset.game === 'playing'", null, { timeout: 30_000 });
    const t0 = Date.now();
    // 曲の終わりまで実時間で待つ（READY 2秒＋曲長＋余裕）
    await page.waitForFunction("document.body.dataset.game === 'result'", null, {
      timeout: durationMs + 90_000,
    });
    // 結果カード（演奏画面の上に重なって出る）が見えるまで待つ
    await page.waitForFunction("!document.getElementById('result-screen').hidden", null, {
      timeout: 30_000,
    });
    const counts = await page.locator('#result-counts').textContent();
    const combo = Number(await page.locator('#result-combo').textContent());
    const miss = Number(/MISS (\d+)/.exec(counts ?? '')?.[1] ?? -1);
    // フルコンボの印が結果カードの中に出ていることも確かめる
    const badge = await page.locator('#result-fullcombo').isVisible();
    const ok = miss === 0 && combo === total && badge;
    console.log(
      `${song.id} (${song.label}) hard: ${counts} / 最大コンボ ${combo} / 全ノーツ ${total}` +
        ` / 所要 ${Math.round((Date.now() - t0) / 1000)}秒 => ${ok ? 'フルコンボ OK' : 'NG'}`,
    );
    if (!ok) failed = true;
    await page.locator('#back-button').click();
    // 戻るボタンは画面表示の切り替えだけ（data-game は 'result' のままが仕様）
    await page.waitForFunction(
      "document.getElementById('result-screen').hidden && !document.getElementById('menu-screen').hidden",
      null,
      { timeout: 10_000 },
    );
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) {
  console.error('verify-autoplay-full: 失敗');
  process.exit(1);
}
console.log('verify-autoplay-full: 全曲 hard をオートプレイでフルコンボ完走');
