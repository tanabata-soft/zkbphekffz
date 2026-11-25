import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// リズムゲーム（デジタルCDエンジンのモジュール）の E2E。CD 側の画面遷移（data-view）と
// リズムゲーム側の状態（data-screen / data-song / data-difficulty / data-game）の
// 両方を見て、同居が壊れていないことを確かめる。

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-cover')).toBeVisible();
});

test('トップの「遊ぶ」ボタンからリズムゲーム画面に入れる', async ({ page }) => {
  await expect(page.locator('#btn-open-game')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'game');
  await expect(page.locator('#view-game')).toBeVisible();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('#view-game h1')).toHaveText('リズムゲーム');
  // 操作説明はメニューには出さない（設定の中に入れた）
  await expect(page.locator('#menu-screen')).not.toContainText('ノーツが下の枠に重なったら');
  // 収録曲2曲がカルーセルに並ぶ
  await expect(page.locator('.carousel-slide')).toHaveCount(2);
  await expect(page.locator('.carousel-slide[data-song="chocomint"]')).toBeVisible();
});

test('リズムゲームでは CD 側の再生が止まる', async ({ page }) => {
  // 先に CD 側で再生を始める
  await page.locator('#btn-play-all').click();
  await expect(page.locator('body')).toHaveAttribute('data-playing', '1');
  await page.locator('#btn-home').click();
  await page.locator('#btn-open-game').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'game');
  await expect(page.locator('body')).toHaveAttribute('data-playing', '0');
});

test('曲と難易度を選べる', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('.carousel-slide[data-song="tokeruyoru"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-song', 'tokeruyoru');
  await page.locator('#diff-row [data-diff="hard"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-difficulty', 'hard');
  await expect(page.locator('#diff-row [data-diff="hard"]')).toHaveAttribute('aria-pressed', 'true');
  // ベストスコアは曲選択画面に、選んでいる曲・難易度のラベルつきで出る
  await expect(page.locator('#menu-best-label')).toHaveText('Chocomintの溶ける夜・むずかしい のベストスコア');
  // ベストのパネルは難易度の上にある専用領域で、ランク表示の枠も持つ
  const panelBox = await page.locator('#best-panel').boundingBox();
  const diffBox = await page.locator('#diff-row').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(diffBox).not.toBeNull();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(diffBox!.y);
  await expect(page.locator('#menu-best-rank')).toHaveText('—');
  // 結果カードは演奏画面の中にあり、演奏画面の上に重ねて出す構造になっている
  await expect(page.locator('#game-screen #result-screen')).toHaveCount(1);
  // ドットからも選べる
  await page.locator('.carousel-dot[data-song="chocomint"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-song', 'chocomint');
});

test('設定ダイアログが開閉できる', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // 操作説明（遊び方）は設定の中にある
  await expect(page.locator('#settings-dialog')).toContainText('遊び方');
  // ベストスコアは設定には出さない（曲選択画面のパネルで出す）
  await expect(page.locator('#settings-dialog #best-panel')).toHaveCount(0);
  // オートプレイとデバッグモードも設定には出さない（デバッグパネル側に移した）
  await expect(page.locator('#settings-dialog')).not.toContainText('オートプレイ');
  await expect(page.locator('#settings-dialog')).not.toContainText('デバッグモード');
  await expect(page.locator('#settings-dialog')).toContainText('ノーツが下の枠に重なったらタップ');
  // オフセットの増減が保存・表示される
  await page.locator('#offset-plus').click();
  await expect(page.locator('#offset-value')).toHaveText('+10ms');
  await expect(page.locator('body')).toHaveAttribute('data-offset', '10');
  // 下部の「閉じる」と版数表示は廃止した（右上の × で閉じる）
  await expect(page.locator('#settings-dialog #settings-close-bottom')).toHaveCount(0);
  await expect(page.locator('#settings-dialog .dialog-version')).toHaveCount(0);
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
});

test('選択を変えると確認音が鳴る', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.evaluate(() => {
    const w = window as unknown as { __uiSounds: number; __swipeSounds: number };
    w.__uiSounds = 0;
    w.__swipeSounds = 0;
    document.addEventListener('app:sound', (e) => {
      const kind = (e as CustomEvent).detail?.kind;
      if (kind === 'ui') w.__uiSounds += 1;
      if (kind === 'swipe') w.__swipeSounds += 1;
    });
  });
  // 難易度を変えるとクリック音（ui）
  await page.locator('#diff-row [data-diff="hard"]').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __uiSounds: number }).__uiSounds))
    .toBeGreaterThanOrEqual(1);
  // 曲を変えるとスワイプ音（swipe）で、クリック音は増えない
  await page.locator('.carousel-dot[data-song="tokeruyoru"]').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __swipeSounds: number }).__swipeSounds))
    .toBeGreaterThanOrEqual(1);
  await expect(page.evaluate(() => (window as unknown as { __uiSounds: number }).__uiSounds)).resolves.toBe(1);
});

test('ゲームが始まり、Canvas が表示され、中断ボタンで確認カードが出て中断できる', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();
  await expect(page.locator('#game-canvas')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // 歌詞はジャケット（画面幅いっぱいの正方形）のすぐ下に出る（判定ラインより上）
  const lyricBox = await page.locator('#lyrics').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, width: window.innerWidth, height: window.innerHeight };
  });
  expect(lyricBox.top).toBeGreaterThanOrEqual(lyricBox.width);
  expect(lyricBox.top).toBeLessThan(lyricBox.height * 0.82);
  // 左上の中断ボタンをタップすると、即座には戻らず確認カードが出る（案1）
  await page.locator('#game-canvas').dispatchEvent('pointerdown', { clientX: 30, clientY: 29 });
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  // 「メニューに戻る」でメニューに戻る
  await page.locator('#pause-abort-button').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'menu');
});

test('次の曲の読み込み中に、前の曲の画面（背景）が残らない', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('#result-screen')).toBeVisible();
  // キャンバス右上（スコア表示域）の最大輝度。前の演奏の最終フレームには白いスコアが残る
  const stripMax = (): Promise<number> =>
    page.evaluate(() => {
      const c = document.getElementById('game-canvas') as HTMLCanvasElement;
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = c.height;
      const ctx = t.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      const x0 = Math.floor(c.width * 0.72);
      const y0 = Math.floor(c.height * 0.015);
      const d = ctx.getImageData(x0, y0, c.width - x0, Math.floor(c.height * 0.05)).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
      return max;
    });
  expect(await stripMax()).toBeGreaterThan(200);
  // 次の曲の音声読み込みを遅らせて、読み込み中の画面を見る
  await page.route('**/*.mp3', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.locator('#next-button').click();
  await page.waitForTimeout(400);
  // 読み込み中は地の色で消えていて、前の曲の画面は残っていない
  expect(await stripMax()).toBeLessThan(64);
  // 読み込みが終われば通常どおり始まる
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
});

test('演奏が終わるとジングルが鳴ってから結果が出る', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.evaluate(() => {
    const w = window as unknown as { __jingleRank: string };
    w.__jingleRank = '';
    document.addEventListener('app:sound', (e) => {
      const d = (e as CustomEvent).detail as { kind?: string; rank?: string };
      if (d?.kind === 'jingle') w.__jingleRank = d.rank ?? '?';
    });
  });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  // ジングルが鳴っている間は、結果はまだ出ない（何も叩いていないのでランクは C）
  await page.waitForTimeout(350);
  await expect(page.locator('#result-screen')).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __jingleRank: string }).__jingleRank))
    .toBe('C');
  // ジングルが終わると結果が出る
  await expect(page.locator('#result-screen')).toBeVisible({ timeout: 5_000 });
  // 通常の結果ではランクが出る（ゲームオーバーの回だけ出さない）
  await expect(page.locator('#result-rank')).toBeVisible();
  await expect(page.locator('#result-rank')).toHaveText('C');
  // 何も叩いていない回は、フルコンボの印もハイスコア更新の印も出ない
  await expect(page.locator('#result-fullcombo')).toBeHidden();
  await expect(page.locator('#result-newrecord')).toBeHidden();
});

test('次の曲の読み込み中に、前の曲の歌詞が残らない', async ({ page }) => {
  // NK-S001 は最初の歌詞が 12.9 秒と遅く、ヘッドレス並列実行の低速化では
  // 既定の制限（テスト30秒・歌詞待ち25秒）に収まらないため、このテストだけ
  // 上限を延ばす（検証対象の assertion 自体は変えない）
  test.setTimeout(120_000);
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // 歌詞が出るまで待つ
  await expect(page.locator('#lyric-current')).not.toHaveText('', { timeout: 60_000 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('#result-screen')).toBeVisible({ timeout: 10_000 });
  // 次の曲の読み込みを遅らせて、読み込み中の歌詞表示を確かめる
  await page.route('**/*.mp3', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.locator('#next-button').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#lyric-prev')).toHaveText('');
  await expect(page.locator('#lyric-current')).toHaveText('');
  await expect(page.locator('#lyric-next')).toHaveText('');
});

test('曲を変えるとメニューの背景ジャケットも即座に切り替わる', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  const bgImage = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.getElementById('menu-bg')!).backgroundImage);
  const slideFile = (song: string): Promise<string> =>
    page.evaluate(
      (s) =>
        document
          .querySelector(`.carousel-slide[data-song="${s}"] img`)!
          .getAttribute('src')!
          .split('/')
          .pop()!,
      song,
    );
  // 初期表示の背景は選択中の曲（先頭）のジャケット
  await expect.poll(async () => (await bgImage()).includes(await slideFile('chocomint'))).toBe(true);
  // ドットで別の曲へ: 背景も遅延なくその曲のジャケットになる（前の曲が残らない）
  await page.locator('.carousel-dot[data-song="tokeruyoru"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-song', 'tokeruyoru');
  await expect
    .poll(async () => (await bgImage()).includes(await slideFile('tokeruyoru')), { timeout: 1_000 })
    .toBe(true);
});

test('中断確認の「つづける」で、止めた位置から再開する', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const songMs = (): Promise<number> =>
    page.evaluate(
      () =>
        (window as unknown as { __pwaTest: { getGameState: () => { songMs: number } } }).__pwaTest.getGameState()
          .songMs,
    );
  // 曲が少し進んでから止める
  await expect.poll(songMs, { timeout: 30_000 }).toBeGreaterThan(300);
  await page.locator('#game-canvas').dispatchEvent('pointerdown', { clientX: 30, clientY: 29 });
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  const frozen = await songMs();
  expect(frozen).toBeGreaterThan(300);
  // 凍結中は位置が進まない
  await page.waitForTimeout(400);
  expect(await songMs()).toBe(frozen);
  // 「つづける」→ READY（約1秒）をはさんで再開し、止めた位置から進む
  await page.locator('#pause-resume-button').click();
  await expect(page.locator('#pause-screen')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 5_000 });
  await expect.poll(songMs, { timeout: 5_000 }).toBeGreaterThan(frozen);
});

test('アプリ切替（画面が隠れる）と中断確認が出て、演奏は進まない', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // 戻ってきてもカードは開いたまま。ここでは中断してメニューへ
  await expect(page.locator('#pause-screen')).toBeVisible();
  await page.locator('#pause-abort-button').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'menu');
});

test('演奏中に音声時計が凍ると中断確認が出て、復帰すれば止めた位置から再開する', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const songMs = (): Promise<number> =>
    page.evaluate(
      () =>
        (window as unknown as { __pwaTest: { getGameState: () => { songMs: number } } }).__pwaTest.getGameState()
          .songMs,
    );
  const setAudio = (audio: string): Promise<void> =>
    page.evaluate((a) => {
      const api = (window as unknown as { __pwaTest?: { setGameState?: (p: Record<string, unknown>) => void } })
        .__pwaTest;
      api?.setGameState?.({ audio: a });
    }, audio);
  // 曲が少し進んでから、時計だけを止める（iOS の音声割り込みで currentTime が
  // 止まる症状の再現。state は running のまま）
  await expect.poll(songMs, { timeout: 30_000 }).toBeGreaterThan(300);
  await setAudio('stick');
  // 即座にメニューへは戻らず、中断確認カードが出て演奏画面に留まる
  // （オーナー決定 2026-11-24: 凍結はまずポーズ）
  await expect(page.locator('#pause-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  await expect(page.locator('#game-screen')).toBeVisible();
  const frozen = await songMs();
  expect(frozen).toBeGreaterThan(300);
  // ポーズ中は位置が進まない
  await page.waitForTimeout(400);
  expect(await songMs()).toBe(frozen);
  // 時計を復帰させる。自動では再開せず、カードは開いたまま
  await setAudio('unstick');
  await page.waitForTimeout(500);
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  await expect(page.locator('#pause-screen')).toBeVisible();
  // 「つづける」で止めた位置から再開する（頭からではない）
  await page.locator('#pause-resume-button').click();
  await expect(page.locator('#pause-screen')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 5_000 });
  await expect.poll(songMs, { timeout: 5_000 }).toBeGreaterThan(frozen);
  expect(await songMs()).toBeLessThan(frozen + 3_000);
});

test('音声時計の凍結が長く直らなければ、最後の手段としてメニューへ戻る', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const songMs = (): Promise<number> =>
    page.evaluate(
      () =>
        (window as unknown as { __pwaTest: { getGameState: () => { songMs: number } } }).__pwaTest.getGameState()
          .songMs,
    );
  await expect.poll(songMs, { timeout: 30_000 }).toBeGreaterThan(300);
  // resume しても二度と戻らない壊れた context を再現する
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { setGameState?: (p: Record<string, unknown>) => void } })
      .__pwaTest;
    api?.setGameState?.({ audio: 'poison' });
  });
  // まずポーズ（中断確認）になる
  await expect(page.locator('#pause-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  // 時計が復帰しないまま10秒（FREEZE_PAUSE_ABORT_MS）経過したら、最後の手段として
  // 作り直してメニューへ戻る
  await expect(page.locator('body')).toHaveAttribute('data-game', 'menu', { timeout: 30_000 });
  await expect(page.locator('#menu-screen')).toBeVisible();
});

test('結果は演奏画面の上に重なって出て、コンボ段階がコンボ数で上がる', async ({ page }) => {
  // デバッグ API（finishNow / setCombo）を使うため ?debug=1 で開き直す
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // コンボ 120 で演出段階は最上段（tier 4）
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { setCombo?: (n: number) => void } }).__pwaTest;
    api?.setCombo?.(120);
  });
  await expect(page.locator('body')).toHaveAttribute('data-combo-tier', '4');
  // いまの成績で結果へ進む: 演奏画面は出したまま、結果カードが上に重なる
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'result');
  await expect(page.locator('#game-screen')).toBeVisible();
  await expect(page.locator('#result-screen')).toBeVisible();
  await expect(page.locator('#menu-screen')).toBeHidden();
  // メニューに戻ると、ベストのパネルに今回のランクが残っている
  await page.locator('#back-button').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('#menu-best-rank')).toHaveText(/^[SABC]$/);
});

test('結果画面の「次の曲」で、難易度そのまま次の曲が始まる', async ({ page }) => {
  // 結果へすぐ進めるよう、デバッグ API（finishNow）を使うため ?debug=1 で開き直す
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  // 1曲目（chocomint）を難易度「むずかしい」で演奏する
  await page.locator('.carousel-slide[data-song="chocomint"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-song', 'chocomint');
  await page.locator('#diff-row [data-diff="hard"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-difficulty', 'hard');
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'result');
  await expect(page.locator('#result-screen')).toBeVisible();
  await expect(page.locator('#next-button')).toBeVisible();
  // 「次の曲」: メニューを経由せず、2曲目（tokeruyoru）が同じ難易度で始まる
  await page.locator('#next-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'game');
  await expect(page.locator('body')).toHaveAttribute('data-song', 'tokeruyoru');
  await expect(page.locator('body')).toHaveAttribute('data-difficulty', 'hard');
  await expect(page.locator('#result-screen')).toBeHidden();
});

test('最後の曲の結果で「次の曲」を押すと先頭の曲に戻る', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  // 最後の曲（tokeruyoru）を選んで演奏する
  await page.locator('.carousel-dot[data-song="tokeruyoru"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-song', 'tokeruyoru');
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'result');
  // 「次の曲」: 先頭の曲（chocomint）に回って演奏が始まる
  await page.locator('#next-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-song', 'chocomint');
});

test('リズムゲーム画面からトップへ戻れる（設定の横の「戻る」ボタン）', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await expect(page.locator('#view-game')).toBeVisible();
  await page.locator('.game-back').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'cover');
  await expect(page.locator('#view-cover')).toBeVisible();
  // もう一度入っても、メニュー画面から始まる
  await page.locator('#btn-open-game').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
});

test('プレイ中の「戻る」（端スワイプ）は無効化されて演奏が続き、退出後は履歴が掃除される', async ({ page }) => {
  // 曲位置の進行を見るため ?debug=1 で開き直す
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  // ゲームモード中は、端スワイプ対策の履歴ガードが積まれている
  await expect
    .poll(() => page.evaluate(() => (history.state as { rhythmGameGuard?: boolean } | null)?.rhythmGameGuard))
    .toBe(true);
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const songMs = (): Promise<number> =>
    page.evaluate(
      () =>
        (window as unknown as { __pwaTest: { getGameState: () => { songMs: number } } }).__pwaTest.getGameState()
          .songMs,
    );
  await expect.poll(songMs, { timeout: 30_000 }).toBeGreaterThan(300);
  // ブラウザの「戻る」＝ 端スワイプ「戻る」
  await page.goBack();
  // アプリは閉じず、確認カードも出ず、演奏が続く（オーナー決定 2026-11-24 で完全無効化）
  await expect(page.locator('body')).toHaveAttribute('data-view', 'game');
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing');
  await expect(page.locator('#pause-screen')).toBeHidden();
  const atBack = await songMs();
  await expect.poll(songMs, { timeout: 5_000 }).toBeGreaterThan(atBack);
  // 中断ボタンからは従来どおり確認カードが出て、メニューに戻れる
  await page.locator('#game-canvas').dispatchEvent('pointerdown', { clientX: 30, clientY: 29 });
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'paused');
  await page.locator('#pause-abort-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'menu');
  await expect(page.locator('#menu-screen')).toBeVisible();
  // ガードは積み直されているので、もう一度「戻る」を押しても閉じない
  await expect
    .poll(() => page.evaluate(() => (history.state as { rhythmGameGuard?: boolean } | null)?.rhythmGameGuard))
    .toBe(true);
  await page.goBack();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'game');
  await expect(page.locator('#menu-screen')).toBeVisible();
  // 本当にやめる（メニュー下部の「戻る」ボタン）とトップへ戻り、履歴ガードは掃除される
  await page.locator('.game-back').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'cover');
  await expect.poll(() => page.evaluate(() => history.state)).toBeNull();
});

test('広い画面ではプレイ画面がスマホ比率のステージになる（案B）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const box = await page.locator('#game-screen').boundingBox();
  expect(box).not.toBeNull();
  // ステージは高さいっぱい、幅は高さ × 390/844、左右中央に置かれる
  expect(Math.abs(box!.height - 800)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - (800 * 390) / 844)).toBeLessThanOrEqual(2);
  expect(Math.abs(box!.x - (1280 - box!.width) / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box!.y)).toBeLessThanOrEqual(1);
  // 歌詞はステージ内のジャケット（ステージ幅の正方形）のすぐ下に出る
  const lyric = await page.locator('#lyrics').evaluate((el) => {
    const stage = document.querySelector('#game-screen')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { relTop: r.top - stage.top, stageWidth: stage.width, stageHeight: stage.height };
  });
  expect(lyric.relTop).toBeGreaterThanOrEqual(lyric.stageWidth);
  expect(lyric.relTop).toBeLessThan(lyric.stageHeight * 0.82);
});

test('ノーツ速度の設定がステッパーで変わり、再読み込みしても保存されている', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // 遊び方にフリックの説明がある
  await expect(page.locator('#settings-dialog')).toContainText('フリック');
  // 既定は ×1.0
  await expect(page.locator('#speed-value')).toHaveText('×1.0');
  await expect(page.locator('body')).toHaveAttribute('data-speed', '1');
  // ＋ を2回で ×1.2
  await page.locator('#speed-plus').click();
  await page.locator('#speed-plus').click();
  await expect(page.locator('#speed-value')).toHaveText('×1.2');
  await expect(page.locator('body')).toHaveAttribute('data-speed', '1.2');
  // 上限は ×2.0 で止まる
  for (let i = 0; i < 12; i++) await page.locator('#speed-plus').click();
  await expect(page.locator('#speed-value')).toHaveText('×2.0');
  // 下限は ×0.8 で止まる
  for (let i = 0; i < 15; i++) await page.locator('#speed-minus').click();
  await expect(page.locator('#speed-value')).toHaveText('×0.8');
  // 永続化の確認用に ×1.3 へ戻して閉じる
  for (let i = 0; i < 5; i++) await page.locator('#speed-plus').click();
  await expect(page.locator('#speed-value')).toHaveText('×1.3');
  await page.locator('#settings-close').click();
  // 再読み込みしても速度設定が残っている（storage に保存されている）
  await page.reload();
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await expect(page.locator('body')).toHaveAttribute('data-speed', '1.3');
  await page.locator('#settings-open').click();
  await expect(page.locator('#speed-value')).toHaveText('×1.3');
});

async function tapLatency(page: Page, expectedStatus: string): Promise<void> {
  await expect(async () => {
    await page.locator('#latency-tap').dispatchEvent('pointerdown');
    await expect(page.locator('#latency-status')).toHaveText(expectedStatus, { timeout: 300 });
  }).toPass({ timeout: 10_000 });
}

test('遅延チェックは開いたらすぐ始まり、6タップで自動でオフセットに反映される', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-offset', '0');
  await page.locator('#latency-open').click();
  await expect(page.locator('#latency-dialog')).toBeVisible();
  // スタート・やめる・反映ボタンは廃止した
  await expect(page.locator('#latency-start')).toHaveCount(0);
  await expect(page.locator('#latency-cancel')).toHaveCount(0);
  await expect(page.locator('#latency-apply')).toHaveCount(0);
  // 開いた時点で計測が始まっていて、タップが受け付けられる
  await expect(page.locator('body')).toHaveAttribute('data-latency', 'running');
  await expect(page.locator('#latency-tap')).toBeEnabled();
  await expect(page.locator('#latency-status')).toHaveText('タップ 0 / 6');
  // 6回タップする（6回目は完了してステータスが変わる）
  for (let n = 1; n <= 5; n++) await tapLatency(page, `タップ ${n} / 6`);
  await tapLatency(page, '計測が終わりました');
  // 完了したら結果だけが出て、オフセットへ自動で反映されている
  await expect(page.locator('#latency-result')).toBeVisible();
  await expect(page.locator('#latency-status')).toHaveText('計測が終わりました');
  const meanText = await page.locator('#latency-mean').textContent();
  const applied = Number.parseInt(meanText ?? '0', 10);
  await expect(page.locator('body')).toHaveAttribute('data-offset', String(applied));
  await expect(page.locator('#latency-tap')).toBeDisabled();
  // 閉じても反映済みのまま
  await page.locator('#latency-close').click();
  await expect(page.locator('#latency-dialog')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-offset', String(applied));
  await expect(page.locator('#offset-value')).toHaveText(`${applied > 0 ? '+' : ''}${applied}ms`);
});

test('遅延チェックを途中で閉じたらオフセットは変わらない', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // 先に手動で +10 にしておく
  await page.locator('#offset-plus').click();
  await expect(page.locator('body')).toHaveAttribute('data-offset', '10');
  await page.locator('#latency-open').click();
  await expect(page.locator('#latency-dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-latency', 'running');
  // 2回だけタップして、終わる前に閉じる
  await tapLatency(page, 'タップ 1 / 6');
  await tapLatency(page, 'タップ 2 / 6');
  await page.locator('#latency-close').click();
  await expect(page.locator('#latency-dialog')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-offset', '10');
  await expect(page.locator('#offset-value')).toHaveText('+10ms');
});

test('判定ラインはタッチ位置「上」固定（H×0.74）で、設定にタッチ位置の項目はない', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();

  // 設定ダイアログにタッチ位置の項目（標準／上の2択）はもう無い（タッチ位置を
  // 「上」に固定したオーナー決定 2026-11-23 で撤去）
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#touch-standard')).toHaveCount(0);
  await expect(page.locator('#touch-high')).toHaveCount(0);
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();

  // 判定ラインの位置: Canvas の中で「ほぼ白い横帯」が最も広い行の高さ比率を測る。
  // 判定ラインはレーン領域の幅いっぱいに引かれる白線なので（2026-11-24 から両脇に
  // 余白。測定はレーン領域の内側だけを数える）、その行が比率として返る。
  // ただし開始直後は、地の色で消された Canvas に最初のフレームがまだ描かれて
  // いない瞬間があり、そのときは明るい画素が1つも見つからない（bestY = -1）。
  // CI の並行負荷下で実際にこの瞬間を掴んで失敗したため、1回の実測は信じず、
  // 白線の行（明るい画素の割合が 0.9 以上）が見つかるまでポーリングしてから測る
  const measureLine = (): Promise<{ ratio: number; frac: number }> =>
    page.evaluate(() => {
      const c = document.getElementById('game-canvas') as HTMLCanvasElement;
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = c.height;
      const ctx = t.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let bestY = -1;
      let best = 0;
      for (let y = Math.floor(c.height * 0.55); y < c.height * 0.95; y++) {
        let bright = 0;
        let total = 0;
        // レーン領域（両脇の余白を除いた内側）だけを数える
        for (let x = Math.floor(c.width * 0.06); x < c.width * 0.94; x += 2) {
          const i = (y * c.width + x) * 4;
          total++;
          if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
        }
        const frac = bright / total;
        if (frac > best) {
          best = frac;
          bestY = y;
        }
      }
      return { ratio: bestY / c.height, frac: best };
    });
  const lineRatio = async (): Promise<number> => {
    let ratio = -1;
    await expect
      .poll(
        async () => {
          const m = await measureLine();
          if (m.frac >= 0.9) ratio = m.ratio;
          return m.frac;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(0.9);
    return ratio;
  };

  // 判定ラインは常に「上」の位置（H×0.74）で、設定で変える手段はない
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const ratio = await lineRatio();
  expect(ratio).toBeGreaterThan(0.71);
  expect(ratio).toBeLessThan(0.77);
});

test('フルコンボでハイスコアも更新すると、印が両方出てボイスが続けて鳴る', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  // 達成ボイスが鳴った順序を記録する
  await page.evaluate(() => {
    const w = window as unknown as { __voices: string[] };
    w.__voices = [];
    document.addEventListener('app:sound', (e) => {
      const kind = (e as CustomEvent).detail?.kind as string | undefined;
      if (kind === 'voice-fullcombo' || kind === 'voice-newrecord') w.__voices.push(kind);
    });
  });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const songMs = (): Promise<number> =>
    page.evaluate(() => {
      const api = (window as unknown as { __pwaTest?: { getGameState?: () => { songMs: number } } }).__pwaTest;
      return api?.getGameState?.().songMs ?? -1;
    });
  // 既定の曲・難易度（chocomint / easy）の最初のノーツを譜面から読む
  const charts = JSON.parse(readFileSync(new URL('../src/game/data/charts.json', import.meta.url), 'utf8')) as Record<
    string,
    { charts: Record<string, [number, number, number?, string?][]> }
  >;
  const [firstMs, firstLane, firstHoldMs] = charts['chocomint'].charts['easy'][0];
  // ノーツの少し手前まで曲位置を待って、そのレーンのキー（D/F/J/K）を押す
  for (;;) {
    const ms = await songMs();
    if (ms >= firstMs - 80) break;
    await page.waitForTimeout(30);
  }
  // NK-S001 では冒頭ノーツが長押し（3要素目＝長さms）: 長押しの判定は
  // 押し切った時点で集計されるため、タップではなく完走まで押し続ける
  // （タップだと判定ノーツ0件になり、フルコンボの前提が崩れる）。
  const isHold = typeof firstHoldMs === 'number';
  await page.evaluate(
    ({ key, hold }) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      if (!hold) window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    },
    { key: 'dfjk'[firstLane], hold: isHold },
  );
  if (isHold) {
    await expect(page.locator('body')).toHaveAttribute('data-holds-completed', '1', { timeout: 10_000 });
    await page.evaluate(
      ({ key }) => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })),
      { key: 'dfjk'[firstLane] },
    );
  }
  await expect(page.locator('body')).not.toHaveAttribute('data-score', '0', { timeout: 5_000 });
  // 1ノーツ取った時点（ミス0）で結果へ進む：フルコンボ＋初回ベスト＝ハイスコア更新
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('#result-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#result-fullcombo')).toBeVisible();
  await expect(page.locator('#result-fullcombo')).toHaveText('FULL COMBO!');
  await expect(page.locator('#result-newrecord')).toBeVisible();
  await expect(page.locator('#result-newrecord')).toHaveText('ハイスコア更新！');
  await expect(page.locator('#game-live')).toContainText('ハイスコア更新');
  // ベストスコアは今回のスコアで作られている
  await expect(page.locator('#result-best')).toHaveText(await page.locator('#result-score').innerText());
  // ボイスは フルコンボ→ハイスコア更新 の順に続けて鳴る
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __voices: string[] }).__voices))
    .toEqual(['voice-fullcombo', 'voice-newrecord']);
});

test('オートプレイのフルコンボでは印とボイスは出るが、ハイスコア更新は出ない', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __voices: string[] };
    w.__voices = [];
    document.addEventListener('app:sound', (e) => {
      const kind = (e as CustomEvent).detail?.kind as string | undefined;
      if (kind === 'voice-fullcombo' || kind === 'voice-newrecord') w.__voices.push(kind);
    });
    // デバッグモード＋オートプレイをテスト API で有効化する（オートプレイは
    // デバッグモードでのみ効く。撮影スクリプトと同じ作法）
    const api = (window as unknown as { __pwaTest?: { setGameState?: (p: Record<string, unknown>) => void } }).__pwaTest;
    api?.setGameState?.({ debugMode: true, autoplay: true });
  });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // オートプレイが数ノーツ取るまで待ってから結果へ進む（全 PERFECT・ミス0）
  await expect(page.locator('body')).not.toHaveAttribute('data-score', '0', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await page.evaluate(() => {
    const api = (window as unknown as { __pwaTest?: { finishNow?: () => void } }).__pwaTest;
    api?.finishNow?.();
  });
  await expect(page.locator('#result-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#result-autoplay')).toBeVisible();
  await expect(page.locator('#result-fullcombo')).toBeVisible();
  // オートプレイの結果はベストに残らないので、ハイスコア更新の印は出ない
  await expect(page.locator('#result-newrecord')).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __voices: string[] }).__voices))
    .toEqual(['voice-fullcombo']);
});

test('中断確認の「はじめからやりなおす」で、同じ曲を頭から開始し直す', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const state = (): Promise<{ songMs: number; life: number; song: string }> =>
    page.evaluate(
      () =>
        (window as unknown as { __pwaTest: { getGameState: () => { songMs: number; life: number; song: string } } })
          .__pwaTest.getGameState(),
    );
  // 曲が進み、ミスでライフが減った状態にする
  await expect.poll(async () => (await state()).songMs, { timeout: 30_000 }).toBeGreaterThan(300);
  await expect.poll(async () => (await state()).life, { timeout: 30_000 }).toBeLessThan(100);
  const songBefore = (await state()).song;
  // 中断してカードを出す。リトライボタンが見えていること
  await page.locator('#game-canvas').dispatchEvent('pointerdown', { clientX: 30, clientY: 29 });
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect(page.locator('#pause-retry-button')).toBeVisible();
  const frozen = (await state()).songMs;
  expect(frozen).toBeGreaterThan(300);
  // リトライ: 確認なしでカードが閉じ、同じ曲のまま頭から演奏が始まる
  await page.locator('#pause-retry-button').click();
  await expect(page.locator('#pause-screen')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 10_000 });
  // 状態がリセットされる: ライフは満タン、曲位置は凍結位置より手前に戻る
  await expect.poll(async () => (await state()).life, { timeout: 10_000 }).toBe(100);
  await expect.poll(async () => (await state()).songMs, { timeout: 10_000 }).toBeLessThan(frozen);
  expect((await state()).song).toBe(songBefore);
});

test('ノーツを逃し続けると、ライフが尽きてゲームオーバーになる', async ({ page }) => {
  test.setTimeout(120_000);
  await page.locator('#btn-open-game').click();
  // ゲームオーバー音が鳴ったことと、達成ボイスが鳴らなかったことを記録する
  await page.evaluate(() => {
    const w = window as unknown as { __gameOverSound: boolean; __voices: string[] };
    w.__gameOverSound = false;
    w.__voices = [];
    document.addEventListener('app:sound', (e) => {
      const kind = (e as CustomEvent).detail?.kind as string | undefined;
      if (kind === 'gameover') w.__gameOverSound = true;
      if (kind === 'voice-fullcombo' || kind === 'voice-newrecord') w.__voices.push(kind);
    });
  });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // 何も叩かずに待ち続ける。ミスのたびにライフが減り（MISS −4）、25ノーツ目の
  // ミスでライフが 0 になってゲームオーバーになり、音が鳴ってから結果カードが出る
  await expect(page.locator('#result-screen')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#result-gameover')).toBeVisible();
  await expect(page.locator('#result-gameover')).toHaveText('GAME OVER');
  // ゲームオーバーの回はランクを出さない（オーナー指示 2026-11-22）。読み上げテキストにもランクは入らない
  await expect(page.locator('#result-rank')).toBeHidden();
  await expect(page.locator('#game-live')).toContainText('ゲームオーバー');
  await expect(page.locator('#game-live')).not.toContainText('ランク');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __gameOverSound: boolean }).__gameOverSound))
    .toBe(true);
  // ゲームオーバーの回は、フルコンボ・ハイスコア更新の印もボイスも出ない
  await expect(page.locator('#result-fullcombo')).toBeHidden();
  await expect(page.locator('#result-newrecord')).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __voices: string[] }).__voices))
    .toEqual([]);
  // 失敗の回は、途中までの成績（精度 0.0%）が出て、「次の曲」は出ない
  await expect(page.locator('#result-accuracy')).toHaveText('0.0');
  await expect(page.locator('#next-button')).toBeHidden();
  await expect(page.locator('#again-button')).toBeVisible();
  await expect(page.locator('#back-button')).toBeVisible();
  // ベストスコア・ベストランクは更新されない（メニューに戻っても 0 / — のまま）
  await page.locator('#back-button').click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('#menu-best')).toHaveText('0');
  await expect(page.locator('#menu-best-rank')).toHaveText('—');
});

test('ライフは満タンから始まり、ミスで減っていく', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?debug=1');
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  const life = (): Promise<number> =>
    page.evaluate(() => {
      const api = (window as unknown as { __pwaTest?: { getGameState?: () => { life: number } } }).__pwaTest;
      return api?.getGameState?.().life ?? -1;
    });
  // 開始直後は満タン
  await expect.poll(life).toBe(100);
  // 何も叩かなければ、ミス（−4）のたびに減っていく。数ノーツ逃した時点では
  // まだ 0 にはならず、演奏は続いている
  await expect.poll(life, { timeout: 30_000 }).toBeLessThanOrEqual(84);
  expect(await life()).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing');
});

test('設定にビジュアライザーのスタイル切替はない（周波数バー固定）', async ({ page }) => {
  await page.locator('#btn-open-game').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // スタイルは周波数バー固定（オーナー決定 2026-11-23）。切替ボタンは存在しない
  await expect(page.locator('#viz-bars')).toHaveCount(0);
  await expect(page.locator('#viz-wave')).toHaveCount(0);
  await expect(page.locator('#viz-mirror')).toHaveCount(0);
  await expect(page.locator('#viz-circle')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-visualizer', /.+/);
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
});

async function countRegionPixels(
  page: Page,
  yFrom: number,
  yTo: number,
): Promise<number> {
  return page.evaluate(
    ({ yFrom, yTo }) => {
      const c = document.getElementById('game-canvas') as HTMLCanvasElement;
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = c.height;
      const ctx = t.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const match = (r: number, g: number, b: number) => g > r + 25 && b > r + 25 && r < 120 && g < 180;
      let count = 0;
      for (let y = Math.floor(c.height * yFrom); y < c.height * yTo; y += 2) {
        for (let x = Math.floor(c.width * 0.04); x < c.width * 0.96; x += 2) {
          const i = (y * c.width + x) * 4;
          if (match(d[i], d[i + 1], d[i + 2])) count++;
        }
      }
      return count;
    },
    { yFrom, yTo },
  );
}

test('演奏中、判定ラインの下にビジュアライザー（周波数バー）が描かれる', async ({ page }) => {
  await page.goto('/?debug=1');
  await expect(page.locator('#view-cover')).toBeVisible();
  await page.locator('#btn-open-game').click();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-game', 'playing', { timeout: 30_000 });
  // 周波数バーの下端色（ティール #26525b 系）が、縮小した下部領域（y 0.83〜0.99）
  // に出るまで待つ。無音でも最小高さのバーが描かれるので、音の有無に依存しない
  await expect
    .poll(() => countRegionPixels(page, 0.86, 0.99), { timeout: 15_000 })
    .toBeGreaterThan(30);
});
