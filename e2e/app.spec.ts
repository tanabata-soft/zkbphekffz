import { expect, test } from '@playwright/test';
import { SYNC } from '../src/album/sync';
import { TRACKS } from '../src/album/tracks';

test('初回に全音源が一括ダウンロードされ、キャッシュに揃う', async ({ page }) => {
  await page.goto('/');
  // 一括ダウンロードが終わると、音源キャッシュに2曲分が揃い、表示は消える
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const c = await caches.open('chocomint-single-audio');
          return (await c.keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBe(2);
  await expect(page.locator('#dl-banner')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-downloading', '0');
});

test('短冊ジャケットが開き、タップで裏面パネルに反転する', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-cover')).toBeVisible();
  await expect(page.locator('#cover-img')).toBeVisible();
  // シングル形態にブックレットボタンと曲目ボタンは無い（曲目は裏面の表示専用リスト）
  await expect(page.locator('#btn-open-booklet')).toHaveCount(0);
  await expect(page.locator('#btn-open-tracks')).toHaveCount(0);
  await page.locator('#flip').click();
  await expect(page.locator('#flip')).toHaveClass(/flipped/);
  const nb = page.locator('.backnote');
  await expect(nb).toContainText('短冊に閉じ込めた');
  await expect(nb).toContainText('NK-S001');
  await expect(nb).toContainText('Neon Karaoke Rock');
  await expect(nb).toContainText('Snow Ballad');
  await expect(nb).toContainText('2:11');
  await expect(nb).toContainText('3:00');
  await expect(nb.locator('#version-line')).toContainText('デジタルシングルCD v');
  await page.locator('#flip').click();
  await expect(page.locator('#flip')).not.toHaveClass(/flipped/);
});

test('裏面パネルは小さい画面でもスクロールなしで全内容が収まる', async ({ page }) => {
  // iPhone SE 相当の小さい画面で、裏面パネルが収まりきること（オーナー指示 2026-11-12）
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await page.locator('#flip').click();
  await expect(page.locator('#flip')).toHaveClass(/flipped/);
  const nb = page.locator('.backnote');
  const dims = await nb.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeLessThanOrEqual(dims.ch + 1);
  // 最後の曲目行とバージョン表示がパネルの内側に見えている
  const panelBox = await nb.boundingBox();
  const versionBox = await nb.locator('#version-line').boundingBox();
  const lastTrackBox = await nb.locator('.bn-track').last().boundingBox();
  expect(panelBox).not.toBeNull();
  expect(versionBox).not.toBeNull();
  expect(lastTrackBox).not.toBeNull();
  if (panelBox && versionBox && lastTrackBox) {
    expect(lastTrackBox.y + lastTrackBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
    expect(versionBox.y + versionBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
  }
});

test('再生ボタンから1曲目が始まり、「次」で2曲目に進む', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#p-title')).toContainText('チョコミントの残像');
  await page.getByRole('button', { name: '次の曲' }).click();
  await expect(page.locator('#p-title')).toContainText('Chocomintの溶ける夜');
  await expect(page.locator('body')).toHaveAttribute('data-track', '1');
  const lines = await page.locator('#lyrics-box p').count();
  expect(lines).toBeGreaterThan(10);
});

test('再生中にトップへ戻っても曲は止まらず、トップの再生で再生中の曲の画面へ戻る', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#play-lb')).toHaveText('一時停止', { timeout: 10_000 });
  // 2曲目へ進めてからトップへ戻る（再生中の曲は2曲目のままであること）
  await page.getByRole('button', { name: '次の曲' }).click();
  await expect(page.locator('#p-title')).toContainText('Chocomintの溶ける夜');
  await expect(page.locator('body')).toHaveAttribute('data-track', '1');
  await page.getByRole('button', { name: 'トップに戻る' }).click();
  await expect(page.locator('#view-cover')).toBeVisible();
  // トップへ戻っても再生は止まらない（オーナー指示 2026-11-12）
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
  const paused = await page.evaluate(() => document.querySelector('audio')!.paused);
  expect(paused).toBe(false);
  // トップの再生を押すと、1曲目からではなく再生中の曲（2曲目）の再生画面へ戻る
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#p-title')).toContainText('Chocomintの溶ける夜');
  await expect(page.locator('body')).toHaveAttribute('data-track', '1');
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
});

test('歌詞をタップすると、その行の時刻から再生が始まる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#play-lb')).toHaveText('一時停止', { timeout: 10_000 });
  // 一時停止してから、1曲目の3行目をタップする: その行から再生が始まり、現在行になる
  await page.getByRole('button', { name: '再生／一時停止' }).click();
  await expect(page.locator('#play-lb')).toHaveText('再生');
  const lines = SYNC[TRACKS[0].src] ?? [];
  const t = lines[2][0];
  const line = page.locator(`#lyrics-box p[data-t="${t}"]`);
  await line.click();
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
  const now = await page.evaluate(() => document.querySelector('audio')!.currentTime);
  expect(now).toBeGreaterThanOrEqual(Math.max(0, t - 1));
  expect(now).toBeLessThan(t + 30);
  await expect(line).toHaveClass(/cur/);
});

test('歌詞をドラッグ（スクロール操作）してもシークしない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#play-lb')).toHaveText('一時停止', { timeout: 10_000 });
  // 一時停止した状態で、先の行（15秒以降）を押してドラッグする: シークも再生再開もしない
  await page.getByRole('button', { name: '再生／一時停止' }).click();
  await expect(page.locator('#play-lb')).toHaveText('再生');
  const t = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#lyrics-box p')];
    const el = ps.find((p) => Number((p as HTMLElement).dataset.t ?? '0') >= 15);
    return el ? Number((el as HTMLElement).dataset.t) : -1;
  });
  expect(t).toBeGreaterThanOrEqual(15);
  const line = page.locator(`#lyrics-box p[data-t="${t}"]`);
  await line.scrollIntoViewIfNeeded();
  const bb = await line.boundingBox();
  expect(bb).not.toBeNull();
  if (!bb) return;
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-playing', '0');
  const now = await page.evaluate(() => document.querySelector('audio')!.currentTime);
  expect(now).toBeLessThan(t - 5);
});
test('再生と一時停止で表示が切り替わる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#play-lb')).toHaveText('一時停止', { timeout: 10_000 });
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
  await page.getByRole('button', { name: '再生／一時停止' }).click();
  await expect(page.locator('#play-lb')).toHaveText('再生');
});

test('再生画面のリピートボタンで1曲リピートに切り替わり、その曲を繰り返す', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '全曲再生' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#repeat-lb')).toHaveText('全曲リピート');
  await page.locator('#btn-repeat').click();
  await expect(page.locator('#repeat-lb')).toHaveText('1曲リピート');
  // 曲の終わりまで進める → 次の曲へ行かず、同じ曲が先頭から再生される
  await page.evaluate(() => {
    const a = document.querySelector('audio')!;
    a.currentTime = a.duration - 0.3;
  });
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('audio')!.currentTime), { timeout: 10_000 })
    .toBeLessThan(5);
  await expect(page.locator('body')).toHaveAttribute('data-track', '0');
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
});

test('manifest と Service Worker が使える', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(registered).toBe(true);
});

test('更新バナーは通常は隠れていて、「あとで」で閉じられる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeHidden();
  await page.evaluate(() => {
    document.getElementById('update-banner')!.hidden = false;
  });
  await page.getByRole('button', { name: 'あとで' }).click();
  await expect(page.locator('#update-banner')).toBeHidden();
});

test('表ジャケットからもインストール方法を開ける', async ({ page }) => {
  await page.goto('/');
  await page.locator('#install-open-cover').click();
  const dialog = page.locator('#install-dialog');
  await expect(dialog).toBeVisible();
  // Pixel 7 のプロファイルなので Android の説明が開いている
  await expect(dialog.locator('details[data-platform="android"]')).toHaveJSProperty('open', true);
  await expect(dialog.locator('details[data-platform="ios"]')).toHaveJSProperty('open', false);
  await dialog.getByRole('button', { name: 'とじる' }).click();
  await expect(dialog).toBeHidden();
});

test('裏面の曲目は表示専用で、タップしても再生画面へは行かない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flip').click();
  await expect(page.locator('#flip')).toHaveClass(/flipped/);
  await page.locator('.backnote .bn-track').first().click();
  // 行タップはジャケットを表に戻すだけで、画面遷移はしない
  await expect(page.locator('body')).toHaveAttribute('data-view', 'cover');
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('#flip')).not.toHaveClass(/flipped/);
});

test('バージョンが表示される（ジャケット裏面パネル）', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#version')).toHaveText(/^\d+\.\d+\.\d+$/);
});

test('起動できないときは「なおす」ボタンが出て、押すと起動できる（ほかのアプリのキャッシュは消えない）', async ({ page }) => {
  const APP_ID = 'chocomint-zanzo-single';
  await page.addInitScript((id) => {
    (window as unknown as { __bootWaitMs: number }).__bootWaitMs = 500;
    // 1回目の自動修復は済んだことにして、ボタンが出る側の動きを確かめる
    sessionStorage.setItem(`${id}:repaired-at`, String(Date.now()));
  }, APP_ID);
  // 同じサイトにある、ほかのアプリのキャッシュ（なおすときに消えてはいけない）を用意する
  await page.goto('/');
  await page.evaluate(async () => {
    await caches.open('other-app-v1');
  });
  // メインのスクリプトが読み込めない状況を作る
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#boot-error')).toBeVisible();

  await page.unroute('**/assets/*.js');
  await page.getByRole('button', { name: 'なおす' }).click();
  await expect(page.locator('#view-cover')).toBeVisible();
  await expect(page.locator('#boot-error')).toBeHidden();
  expect(await page.evaluate(() => caches.has('other-app-v1'))).toBe(true);
});

test('テスト用の入口: ?debug=1 で状態を読めて、場面を作れる', async ({ page }) => {
  await page.goto('/?debug=1');
  const state = await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { getState?: () => unknown } }).__pwaTest;
    return api?.getState?.();
  });
  expect(state).toMatchObject({ view: 'cover', track: -1 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { setState?: (patch: Record<string, unknown>) => void } }).__pwaTest;
    api?.setState?.({ track: 1 });
  });
  await expect(page.locator('#p-title')).toContainText('Chocomintの溶ける夜');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'player');
});

test('テスト用の入口は、?debug=1 でないときは出ない', async ({ page }) => {
  await page.goto('/');
  const exposed = await page.evaluate(() => (window as unknown as { __pwaTest?: unknown }).__pwaTest !== undefined);
  expect(exposed).toBe(false);
});

test('デバッグモード: バージョンを 5 回タップで操作パネルが出る', async ({ page }) => {
  await page.goto('/');
  // バージョン表示はジャケット裏面パネルの下部にある
  await page.locator('#flip').click();
  await expect(page.locator('#flip')).toHaveClass(/flipped/);
  const panel = page.locator('#debug-panel');
  await expect(panel).toBeHidden();
  for (let i = 0; i < 5; i++) await page.locator('#version-line').click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: '表ジャケットへ' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'cover');
  await page.getByRole('button', { name: 'デバッグモードを終える' }).click();
  await expect(panel).toBeHidden();
});
