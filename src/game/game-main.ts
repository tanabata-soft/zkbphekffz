// リズムゲームの配線（リズムゲームエンジンの src/main.ts を移植したもの）。
// CD 側の殻（画面遷移・インストール・更新バナー・起動復旧）は src/main.ts が担うので、
// ここにはゲーム固有の配線だけを置く。初期化は遅延させ、CD 側の main.ts が
// 「遊ぶ」ボタンで最初にリズムゲーム画面を開くときに enterGameMode() を呼ぶ。
// テスト用の入口は、CD 側の getState / setState と上書きし合わないよう
// getGameState / setGameState の名前で出す。

import './game.css';
import {
DIFFICULTIES,
SPEED_DEFAULT,
SPEED_STEP,
clampOffset,
clampSpeed,
isFullCombo,
isNewBest,
type ComboAppearance,
type Difficulty,
type LatencyStats,
type SongId,
} from './logic';
import { LatencyCheck } from './latency';
import { SONGS, songById, type SongEntry } from './charts';
import { comboPatternDef } from './presentation';
import { Game, type GameResult } from './game';
import {
  exposeTestApi,
  isDebug,
  refreshDebugPanel,
  registerDebugActions,
  setData,
  setDebug,
  type DebugAction,
} from '../debug';
import { detectPlatform } from '../install';
import { isSoundOn, playGameOverSound, playResultJingle, playResultVoices, playSwipeSound, playUiClick, preloadFlickSample, preloadGameOverSound, preloadHitSample, preloadResultJingle, preloadResultVoices, setSound, type ResultVoice } from './sound';
import { isVibrateOn, setVibrate } from './haptics';
import { audioContext, audioState, isUnlocked, unlockAudio } from './audio';
import { load, migrateStorage, requestPersist, save } from './storage';

function initGameMode(): { enter: () => void; exit: () => void } {

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  migrateStorage();

  // ---- 選択と記録 ----
  let selectedSong: SongId = load<SongId>('song', SONGS[0].id);
  if (!SONGS.some((s) => s.id === selectedSong)) selectedSong = SONGS[0].id;
  let selectedDiff: Difficulty = load<Difficulty>('difficulty', 'easy');
  if (!(selectedDiff in DIFFICULTIES)) selectedDiff = 'easy';
  let offsetMs = clampOffset(load<number>('offset', 0));
  // 音符の落下速度の倍率（プレイヤー設定。×1.0 がいままでの速度）
  let speedMul = clampSpeed(load<number>('speed', SPEED_DEFAULT));
  // ビジュアライザーは周波数バー固定で設定はない（オーナー決定 2026-11-23）。
  // 過去に保存したスタイル値（storage キー visualizer）は読まれない。
  // 効果音と歌詞表示のオンオフは廃止した（オーナー指示 2026-11-20）。どちらも常にオン。
  // 過去にオフで保存した端末でも戻せるよう、起動時に効果音をオンへ上書きしておく
  setSound(true);
  // オートプレイは設定には置かず、バージョン表示の5回タップで出るデバッグモードの
  // パネルから切り替える（オーナー指示 2026-11-20）。効くのはデバッグモード中だけ
  let autoplayOn = load<boolean>('autoplay', false);
  // メニューの背景（選曲のジャケットのぼかし）。差し替え済みの曲を覚えて、無駄なフェードをしない
  let menuBgSong = '';
  /** ベスト記録: スコアと、その記録を出した回のランクを一緒に持つ */
  interface BestEntry {
    score: number;
    rank?: string;
  }
  type BestMap = Record<string, BestEntry>;
  const bestKey = (song: SongId, diff: Difficulty): string => `${song}:${diff}`;
  const loadBests = (): BestMap => {
    // 旧形式（数値だけの保存）はランクなしとして読み替える
    const raw = load<Record<string, number | BestEntry>>('best', {});
    const out: BestMap = {};
    for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'number' ? { score: v } : v;
    return out;
  };
  const bestOf = (song: SongId, diff: Difficulty): number => loadBests()[bestKey(song, diff)]?.score ?? 0;
  const bestRankOf = (song: SongId, diff: Difficulty): string | undefined => loadBests()[bestKey(song, diff)]?.rank;

  // ---- 画面の出し分け ----
  type Screen = 'menu' | 'game' | 'result';
  let screen: Screen = 'menu';
  function show(next: Screen): void {
    screen = next;
    $('menu-screen').hidden = next !== 'menu';
    // 結果は演奏画面の上に重ねるので、結果表示中も演奏画面は出したままにする
    $('game-screen').hidden = next === 'menu';
    $('result-screen').hidden = next !== 'result';
    // 中断の確認カードは画面遷移では必ず閉じる（開くのは Game 側の onPause だけ）
    $('pause-screen').hidden = true;
    setData('screen', next);
  }

  // ---- メニューの組み立て（曲選択カルーセル） ----
  // ジャケットを主役にした左右スワイプ式。ビューポートは横スクロール＋
  // スクロールスナップで、中央に来たスライドが選択中の曲になる。スライドの
  // ジャケットは縦長の切り抜きで、絵の中の曲タイトルができるだけ収まる位置を
  // 曲データの slidePosition（作品データ songs.ts）で指定する。
  const carouselViewport = $<HTMLDivElement>('carousel-viewport');
  const carouselTrack = $<HTMLDivElement>('carousel-track');
  const carouselDots = $<HTMLDivElement>('carousel-dots');
  const slides = new Map<SongId, HTMLButtonElement>();
  const dotButtons = new Map<SongId, HTMLButtonElement>();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  for (const entry of SONGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'carousel-slide';
    b.dataset.song = entry.id;
    b.setAttribute('aria-label', entry.data.title);
    const img = document.createElement('img');
    img.src = entry.jacketUrl;
    img.alt = '';
    img.draggable = false;
    if (entry.slidePosition) img.style.objectPosition = entry.slidePosition;
    // 紙枠（frameInset）がある絵は、枠がスライドの外に出るよう拡大して表示する
    // （ゲーム中の絵は game.ts が同じ frameInset で切り抜いている。選曲画面も揃える）
    if (entry.frameInset > 0) {
      img.style.transform = `scale(${1024 / (1024 - 2 * entry.frameInset)})`;
    }
    const overlay = document.createElement('span');
    overlay.className = 'slide-overlay';
    const title = document.createElement('span');
    title.className = 'slide-title';
    title.textContent = entry.data.title;
    const chips = document.createElement('span');
    chips.className = 'slide-chips';
    if (entry.bonus) {
      // ボーナストラックは CD 側の裏面バッジと同じ金色の BONUS チップを先頭に置く
      const bonus = document.createElement('span');
      bonus.className = 'chip bonus-chip';
      bonus.textContent = 'BONUS';
      chips.append(bonus);
    }
    const album = document.createElement('span');
    album.className = 'chip slide-album';
    album.textContent = entry.album;
    const bpm = document.createElement('span');
    bpm.className = 'chip';
    bpm.textContent = `BPM ${Math.round(entry.data.bpm)}`;
    const sec = Math.round(entry.data.durationMs / 1000);
    const len = document.createElement('span');
    len.className = 'chip';
    len.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    chips.append(album, bpm, len);
    overlay.append(title, chips);
    b.append(img, overlay);
    b.addEventListener('click', () => selectSong(entry.id, true));
    carouselTrack.append(b);
    slides.set(entry.id, b);

    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'carousel-dot';
    d.dataset.song = entry.id;
    d.setAttribute('aria-label', `${entry.data.title}を選ぶ`);
    d.addEventListener('click', () => selectSong(entry.id, true));
    carouselDots.append(d);
    dotButtons.set(entry.id, d);
  }

  const slideIndex = (id: SongId): number => SONGS.findIndex((s) => s.id === id);

  let carouselAnim = 0;
  /** プログラム側のアニメーション中は true（スワイプによる確定判定を止める） */
  let carouselAnimating = false;

  /** スライドをビューポートの中央へスクロールする */
  function scrollToSong(id: SongId, smooth: boolean): void {
    const slide = slides.get(id);
    if (!slide) return;
    const left = slide.offsetLeft - (carouselViewport.clientWidth - slide.clientWidth) / 2;
    cancelAnimationFrame(carouselAnim);
    carouselAnimating = false;
    if (!smooth || reduceMotion.matches) {
      carouselViewport.scrollLeft = left;
      return;
    }
    // ブラウザ標準の smooth は間延びするので、自前で短くアニメーションする
    // （速く出てきびきび収まる easeOutQuart、260ms。オーナー指摘 2026-11-20「もっとこぎみよく」）
    const from = carouselViewport.scrollLeft;
    const delta = left - from;
    if (delta === 0) return;
    carouselAnimating = true;
    const start = performance.now();
    const DURATION_MS = 260;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 4);
      carouselViewport.scrollLeft = from + delta * eased;
      if (t < 1) {
        carouselAnim = requestAnimationFrame(step);
      } else {
        carouselAnimating = false;
      }
    };
    carouselAnim = requestAnimationFrame(step);
  }

  // アニメーション中に触ったら、利用者の操作を優先して止める
  const cancelCarouselAnim = (): void => {
    cancelAnimationFrame(carouselAnim);
    carouselAnimating = false;
  };
  carouselViewport.addEventListener('pointerdown', cancelCarouselAnim);
  carouselViewport.addEventListener('wheel', cancelCarouselAnim, { passive: true });

  /** 曲を選ぶ。選択の保存と表示の更新をして、必要なら中央へスクロールする */
  function selectSong(id: SongId, scroll: boolean): void {
    if (!SONGS.some((s) => s.id === id)) return;
    const changed = id !== selectedSong;
    selectedSong = id;
    save('song', selectedSong);
    renderMenu();
    if (changed) playSwipeSound();
    if (scroll) scrollToSong(id, true);
  }

  function stepSong(dir: number): void {
    const i = Math.min(SONGS.length - 1, Math.max(0, slideIndex(selectedSong) + dir));
    selectSong(SONGS[i].id, true);
  }
  $('carousel-prev').addEventListener('click', () => stepSong(-1));
  $('carousel-next').addEventListener('click', () => stepSong(1));

  /** いま中央に一番近いスライドの曲 */
  function nearestSongId(): SongId {
    const center = carouselViewport.scrollLeft + carouselViewport.clientWidth / 2;
    let best = selectedSong;
    let bestDist = Infinity;
    for (const entry of SONGS) {
      const slide = slides.get(entry.id);
      if (!slide) continue;
      const d = Math.abs(slide.offsetLeft + slide.clientWidth / 2 - center);
      if (d < bestDist) {
        bestDist = d;
        best = entry.id;
      }
    }
    return best;
  }

  /** 選択中の曲を id に合わせる（スワイプ確定用。スクロール自体は利用者の操作に任せる） */
  function confirmSong(id: SongId): void {
    if (id === selectedSong) return;
    selectedSong = id;
    save('song', selectedSong);
    renderMenu();
    playSwipeSound();
  }

  // スワイプ中も、中央に一番近い曲が変わった時点で選択を確定する。
  // 静止を待ってから確定すると間延びする（オーナー指摘 2026-11-20「確定までが長い」）。
  // 中間点を過ぎればスナップの着地先は決まるので、その時点で確定してよい
  let confirmRaf = 0;
  carouselViewport.addEventListener(
    'scroll',
    () => {
      if (carouselAnimating || confirmRaf) return;
      confirmRaf = requestAnimationFrame(() => {
        confirmRaf = 0;
        if (carouselAnimating) return;
        confirmSong(nearestSongId());
      });
    },
    { passive: true },
  );

  // 落ち着いた時点でもう一度合わせる（上の即時確定を取りこぼした場合の保険）
  let scrollSettleTimer = 0;
  carouselViewport.addEventListener(
    'scroll',
    () => {
      window.clearTimeout(scrollSettleTimer);
      scrollSettleTimer = window.setTimeout(() => confirmSong(nearestSongId()), 120);
    },
    { passive: true },
  );

  const diffButtons = [...document.querySelectorAll<HTMLButtonElement>('#diff-row [data-diff]')];
  for (const b of diffButtons) {
    b.addEventListener('click', () => {
      const next = b.dataset.diff as Difficulty;
      if (next === selectedDiff) return;
      selectedDiff = next;
      save('difficulty', selectedDiff);
      renderMenu();
      playUiClick();
    });
  }

  function renderToggle(id: string, on: boolean): void {
    const button = $(id);
    button.setAttribute('aria-pressed', String(on));
    const state = button.querySelector('.toggle-state');
    if (state) state.textContent = on ? 'オン' : 'オフ';
  }

  /** 選んでいる曲のテーマ色を、画面のアクセント色（枠・光・ボタン）へ反映する */
  function applyAccent(): void {
    const entry = songById(selectedSong);
    const root = $<HTMLElement>('view-game');
    root.style.setProperty('--primary', entry.accent);
    root.style.setProperty('--song-accent-rgb', entry.accentRgb);
  }

  function renderMenu(): void {
    applyAccent();
    for (const [id, b] of slides) {
      b.setAttribute('aria-pressed', String(id === selectedSong));
      b.dataset.active = String(id === selectedSong);
    }
    for (const [id, d] of dotButtons) {
      if (id === selectedSong) d.setAttribute('aria-current', 'true');
      else d.removeAttribute('aria-current');
    }
    $<HTMLButtonElement>('carousel-prev').disabled = slideIndex(selectedSong) <= 0;
    $<HTMLButtonElement>('carousel-next').disabled = slideIndex(selectedSong) >= SONGS.length - 1;
    for (const b of diffButtons) b.setAttribute('aria-pressed', String(b.dataset.diff === selectedDiff));
    $('menu-best-label').textContent = `${songById(selectedSong).data.title}・${DIFFICULTIES[selectedDiff].label} のベストスコア`;
    $('menu-best').textContent = String(bestOf(selectedSong, selectedDiff));
    const rank = bestRankOf(selectedSong, selectedDiff);
    const rankEl = $('menu-best-rank');
    rankEl.textContent = rank ?? '—';
    rankEl.classList.toggle('none', !rank);
    // 背景のぼかしジャケットを選曲に即追随させる。以前はフェードアウト（180ms の
    // 遅延＋0.35s の遷移）を挟んでいたため、曲を変えても前の曲の背景が一瞬残った
    // （オーナー指摘 2026-11-21）。ジャケットはカルーセルのスライド画像として
    // 読み込み済みのはずなので、その場で差し替える。未読込のときだけ、読み終わって
    // から差し替える（その間は前の背景のまま。空白にはしない）。連続で切り替えた
    // ときは、最後に選んだ曲以外は反映しない
    if (menuBgSong !== selectedSong) {
      menuBgSong = selectedSong;
      const bg = $('menu-bg');
      const jacketUrl = songById(selectedSong).jacketUrl;
      const img = new Image();
      img.src = jacketUrl;
      const apply = (): void => {
        if (menuBgSong !== selectedSong) return;
        bg.style.backgroundImage = `url("${jacketUrl}")`;
      };
      if (img.complete && img.naturalWidth > 0) apply();
      else img.onload = apply;
    }
    $('offset-value').textContent = `${offsetMs > 0 ? '+' : ''}${offsetMs}ms`;
    $('speed-value').textContent = `×${speedMul.toFixed(1)}`;
    renderToggle('vibrate-button', isVibrateOn());
    setData('song', selectedSong);
    setData('difficulty', selectedDiff);
    setData('offset', offsetMs);
    setData('speed', speedMul);
    setData('sound', isSoundOn() ? 'on' : 'off');
    setData('vibrate', isVibrateOn() ? 'on' : 'off');
    setData('lyrics', 'on');
    setData('debugMode', isDebug() ? 'on' : 'off');
    setData('autoplay', autoplayOn ? 'on' : 'off');
  }

  function setOffset(next: number): void {
    const clamped = clampOffset(next);
    if (clamped === offsetMs) return;
    offsetMs = clamped;
    save('offset', offsetMs);
    renderMenu();
    playUiClick();
  }
  $('offset-minus').addEventListener('click', () => setOffset(offsetMs - 10));
  $('offset-plus').addEventListener('click', () => setOffset(offsetMs + 10));
  function setSpeed(next: number): void {
    const clamped = clampSpeed(next);
    if (clamped === speedMul) return;
    speedMul = clamped;
    save('speed', speedMul);
    renderMenu();
    playUiClick();
  }
  $('speed-minus').addEventListener('click', () => setSpeed(speedMul - SPEED_STEP));
  $('speed-plus').addEventListener('click', () => setSpeed(speedMul + SPEED_STEP));
  $('vibrate-button').addEventListener('click', () => {
    setVibrate(!isVibrateOn());
    renderMenu();
    playUiClick();
  });
  // オートプレイの切り替えはデバッグパネル側（バージョン表示の5回タップで出る）に置く。
  // パネルのボタンは押すたびにラベルを描き直して、今の状態が見えるようにする
  const autoplayAction: DebugAction = {
    label: '自動',
    title: 'オートプレイ（リズムゲーム）',
    run: () => {
      autoplayOn = !autoplayOn;
      save('autoplay', autoplayOn);
      syncAutoplayAction();
      refreshDebugPanel();
      renderMenu();
    },
  };
  function syncAutoplayAction(): void {
    autoplayAction.label = autoplayOn ? '自動✓' : '自動';
    autoplayAction.title = `オートプレイ（リズムゲーム）: ${autoplayOn ? 'オン' : 'オフ'}。全ノーツを自動で PERFECT にします。結果はベストスコアに残りません`;
  }
  syncAutoplayAction();
  registerDebugActions([autoplayAction]);

  // ---- 設定モーダル ----
  const settingsDialog = $<HTMLDialogElement>('settings-dialog');
  function openSettings(): void {
    renderMenu();
    if (!settingsDialog.open) {
      settingsDialog.showModal();
      // 開いている間は背面のスクロールを止める（閉じたら 'close' イベントで戻す）
      document.body.classList.add('dialog-open');
    }
  }
  function closeSettings(): void {
    if (settingsDialog.open) settingsDialog.close();
  }
  $('settings-open').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  settingsDialog.addEventListener('click', (e) => {
    // 背景（ダイアログ自身の余白部分）のタップで閉じる
    if (e.target === settingsDialog) closeSettings();
  });
  settingsDialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
  });

  // ---- 遅延チェック（設定モーダルから開く。拍に合わせてタップし、ずれを測る） ----
  const latencyDialog = $<HTMLDialogElement>('latency-dialog');
  type LatencyUi = 'idle' | 'running' | 'done';
  let latencyUi: LatencyUi = 'idle';
  let latencyResult: LatencyStats | null = null;
  const latencyCheck = new LatencyCheck({
    onBeat: () => {
      const flash = $('latency-flash');
      flash.classList.add('on');
      window.setTimeout(() => flash.classList.remove('on'), 140);
    },
    onProgress: (taps, needed) => {
      if (latencyUi === 'running') $('latency-status').textContent = `タップ ${taps} / ${needed}`;
    },
    onFinish: (stats) => {
      latencyResult = stats;
      // 計測が終わったら、その場でオフセットへ自動で反映する（反映ボタンは廃止した）。
      // 符号は logic.ts の遅延チェックの約束どおり: 拍より遅れてタップした量（+）を
      // そのままオフセットにする（ノーツの判定時刻が後ろへずれて、遅れを打ち消せる）
      setOffset(Math.round(stats.meanMs));
      latencyUi = 'done';
      renderLatency();
    },
  });

  function renderLatency(): void {
    setData('latency', latencyUi);
    const tap = $<HTMLButtonElement>('latency-tap');
    if (latencyUi === 'idle') {
      $('latency-result').hidden = true;
      tap.disabled = true;
    } else if (latencyUi === 'running') {
      $('latency-result').hidden = true;
      tap.disabled = false;
    } else {
      if (latencyResult) {
        // 表示は、実際にオフセットへ入った値（10ms刻みに丸め・範囲内に収めたもの）に合わせる
        const applied = clampOffset(Math.round(latencyResult.meanMs));
        $('latency-mean').textContent = `${applied > 0 ? '+' : ''}${applied}ms`;
      }
      $('latency-status').textContent = '計測が終わりました';
      $('latency-result').hidden = false;
      tap.disabled = true;
    }
  }

  function openLatency(): void {
    // 開いたらすぐ計測を始める（スタートボタンは廃止した）
    latencyCheck.stop();
    latencyUi = 'running';
    latencyResult = null;
    renderLatency();
    if (!latencyDialog.open) latencyDialog.showModal();
    unlockAudio();
    latencyCheck.start();
  }
  function closeLatency(): void {
    latencyCheck.stop();
    if (latencyDialog.open) latencyDialog.close();
  }
  $('latency-open').addEventListener('click', openLatency);
  $('latency-close').addEventListener('click', closeLatency);
  latencyDialog.addEventListener('close', () => {
    // Esc・✕で閉じた場合も計測を止める。途中で閉じたら何も反映しない
    // （反映は計測が終わった瞬間にだけ行うので、完了後に閉じても反映済みのまま）
    latencyCheck.stop();
    latencyUi = 'idle';
    latencyResult = null;
    renderLatency();
  });
  // タップは pointerdown で受ける（click より遅延が小さい。ゲーム本体の入力と同じ方式）
  $('latency-tap').addEventListener('pointerdown', () => latencyCheck.tap());
  renderLatency();

  // ---- コンボ演出の登場（30コンボごと）と歌詞表示 ----
  // 絵は game.ts が Canvas の背景として描く。ここではセリフとコンボ数の表示だけを担当する。
  // セリフは素材スロット（src/presentation.ts）のパターン定義から引く。
  /** パターンごとのセリフのローテーション位置 */
  const comboLineIndexes = new Map<string, number>();
  let comboHideTimer = 0;

  /**
   * 登場の滞在時間（ms）。CSS のフェード（combo-fade）と game.ts の背景の滞在時間
   * （COMBO_BG_DURATION_SEC）と合わせる
   * （フェードイン 0.9秒 → キープ → フェードアウト 0.8秒）:
   * 通常は約3.7秒（キープ約2秒）、big は約4.4秒（キープ約2.7秒）。
   */
  const COMBO_SHOW_MS = 3700;
  const COMBO_SHOW_BIG_MS = 4400;

  function showComboShow(combo: number, appearance: ComboAppearance): void {
    const pop = $('combo-pop');
    const { pattern, zoom, big } = appearance;
    const lines = comboPatternDef(pattern)?.lines ?? [];
    if (lines.length > 0) {
      const idx = comboLineIndexes.get(pattern) ?? 0;
      $('combo-line').textContent = lines[idx % lines.length];
      comboLineIndexes.set(pattern, idx + 1);
    } else {
      $('combo-line').textContent = '';
    }
    $('combo-num').textContent = String(combo);
    pop.dataset.pattern = pattern;
    pop.dataset.zoom = zoom;
    pop.classList.toggle('big', big);
    // フェードを最初から再生する
    pop.classList.remove('show');
    pop.hidden = false;
    void pop.offsetWidth;
    pop.classList.add('show');
    window.clearTimeout(comboHideTimer);
    comboHideTimer = window.setTimeout(() => {
      pop.hidden = true;
      pop.classList.remove('show');
    }, big ? COMBO_SHOW_BIG_MS : COMBO_SHOW_MS);
  }

  /** 歌詞の3行（前／今／次）を出す。今の行が変わるたびに game から呼ばれる */
  function showLyric(index: number): void {
    const lines = lastEntry.lyrics;
    const cur = $('lyric-current');
    const text = index >= 0 ? (lines[index]?.text ?? '') : '';
    $('lyric-prev').textContent = index > 0 ? lines[index - 1].text : '';
    cur.textContent = text;
    $('lyric-next').textContent = index >= 0 && index + 1 < lines.length ? lines[index + 1].text : '';
    if (text) {
      cur.classList.remove('pop');
      void cur.offsetWidth;
      cur.classList.add('pop');
    }
  }

  // ---- ゲーム ----
  const game = new Game($<HTMLCanvasElement>('game-canvas'), $<HTMLCanvasElement>('notes-canvas'), {
    onFinish: (result) => {
      // ゲームオーバー（ライフが尽きた失敗）のときは、ジングルの代わりに
      // ゲームオーバー音（オーナー提供の音源ファイル）を鳴らし始めてから、
      // 少し待って失敗の結果カードを出す。効果音オフのときは待ちなしで即表示
      if (result.failed) {
        const waitMs = playGameOverSound();
        if (waitMs > 0) {
          window.setTimeout(() => showResult(result), waitMs);
        } else {
          showResult(result);
        }
        return;
      }
      // 結果発表ジングル（オーナー提供の音源ファイル。2026-11-22 にアプリ内合成
      // から差し替え）を鳴らし始めてから、少し待って結果カードを出す。表示までの
      // 待ち時間は差し替え前と同じ。効果音オフのときはジングルなし（待ちなし）で
      // 即表示する。（2026-11-20 の「締めの演出は挟まず結果へ直行」はこの指示で置換。
      // フルコンボの印は従来どおり結果カードの中に出す）
      const waitMs = playResultJingle(result.rank);
      if (waitMs > 0) {
        window.setTimeout(() => showResult(result), waitMs);
      } else {
        showResult(result);
      }
    },
    onAbort: () => {
      show('menu');
      renderMenu();
    },
    onPause: (open) => {
      $('pause-screen').hidden = !open;
    },
    onComboShow: (combo, appearance) => showComboShow(combo, appearance),
    onLyric: (index) => showLyric(index),
  });

  // ---- 端スワイプ・「戻る」対策（v1.2.2、無効化のみは 2026-11-24） ----
  // 端スワイプの「戻る」は OS が最優先で処理するため、発動自体は止められない。
  // 代わりに、ゲームモード中は履歴を1つ積んで popstate を捕捉し、「戻る」が
  // 来てもアプリを閉じさせず・画面遷移もさせずに、この場に留まる。
  // 2026-11-21（案1）から 2026-11-23 までは、プレイ中の「戻る」で演奏を凍結して
  // 中断の確認カードを出していたが、オーナー決定 2026-11-24 で「演奏中の戻るは
  // 完全無効化」に置き換えた: popstate は状態を問わず消費して積み直すだけで、
  // カードは出さない（iPhone の左端スワイプがプレイ中に誤って演奏を止めてしまう
  // ため）。中断の導線は画面内の中断ボタンと Esc に一本化される。本当にやめる
  // 操作（メニュー下部の「戻る」ボタン等で CD 側へ出る）ときは exit() が積んだ
  // 履歴を取り消し、通常の「戻る」に戻す。
  let historyGuardArmed = false;

  function pushGuardState(): boolean {
    try {
      history.pushState({ rhythmGameGuard: true }, '');
      return true;
    } catch {
      // 単体プレビュー（file: やサンドボックス）など、履歴を触れない環境では諦める
      return false;
    }
  }

  const onPopState = (): void => {
    if (!historyGuardArmed) return;
    if (!pushGuardState()) {
      // 積み直せない環境では捕捉をやめる（この popstate 自体は素通りさせる）
      historyGuardArmed = false;
      window.removeEventListener('popstate', onPopState);
    }
    // 「戻る」はここで無効化するだけ（オーナー決定 2026-11-24）。演奏中でも
    // ポーズや確認カードは出さない
  };

  function armHistoryGuard(): void {
    if (historyGuardArmed) return;
    if (!pushGuardState()) return;
    historyGuardArmed = true;
    window.addEventListener('popstate', onPopState);
  }

  function disarmHistoryGuard(): void {
    if (!historyGuardArmed) return;
    historyGuardArmed = false;
    window.removeEventListener('popstate', onPopState);
    // 積んだ分を1つ取り消して、ゲームへ入る前の履歴状態に戻す。
    // この back() による popstate は、リスナーを外した後なので素通りする
    history.back();
  }

  let lastEntry: SongEntry = songById(selectedSong);
  let lastDiff: Difficulty = selectedDiff;

  async function startGame(): Promise<void> {
    // スタートボタンのタップ（ジェスチャ）の中で、await より先に音声を unlock する（iPhone 対策）
    unlockAudio();
    // ヒット音のサンプル素材も先読みしておく（最初のヒットで読み込み待ちにならないように）
    preloadHitSample();
    // フリック音のサンプル素材も先読みしておく（最初のフリックで読み込み待ちにならないように）
    preloadFlickSample();
    // 結果発表ジングルの素材も先読みしておく（演奏終了の瞬間に鳴らし始めるため）
    preloadResultJingle();
    // ゲームオーバー音の素材も先読みしておく（確定の瞬間に鳴らし始めるため）
    preloadGameOverSound();
    // 結果ボイスの素材も先読みしておく（結果表示の瞬間に鳴らし始めるため）
    preloadResultVoices();
    const entry = songById(selectedSong);
    lastEntry = entry;
    lastDiff = selectedDiff;
    const status = $('start-status');
    const startButton = $<HTMLButtonElement>('start-button');
    startButton.disabled = true;
    status.textContent = '読み込み中…';
    try {
      show('game');
      // オートプレイはデバッグモードがオンのときだけ効く
      await game.start(entry, selectedDiff, offsetMs, isDebug() && autoplayOn, speedMul);
      status.textContent = '';
    } catch {
      show('menu');
      status.textContent = '音の読み込みに失敗しました。ページを開き直してください。';
    } finally {
      startButton.disabled = false;
    }
  }
  $('start-button').addEventListener('click', () => void startGame());

  function showResult(result: GameResult): void {
    const bests = loadBests();
    const key = bestKey(lastEntry.id, lastDiff);
    // オートプレイの結果はベストスコアに残さない（表示は保存済みのベストのまま）。
    // ゲームオーバー（失敗）の結果もベストスコア・ベストランクを更新しない。
    // ベストを更新したときは、その回のランクも一緒に保存する（メニューのパネルに出す）
    const prev = bests[key];
    const best = result.autoplay || result.failed ? (prev?.score ?? 0) : Math.max(prev?.score ?? 0, result.score);
    if (!result.autoplay && !result.failed && result.score >= (prev?.score ?? 0)) {
      bests[key] = { score: best, rank: result.rank };
      save('best', bests);
    }
    // ハイスコア更新（保存済みベストを上回った回だけ。初回プレイでベストが
    // 作られる回も含む。オートプレイ・失敗の回はベストを更新しないので対象外）
    const newRecord = !result.autoplay && !result.failed && isNewBest(prev?.score, result.score);
    const fullCombo = !result.failed && isFullCombo(result.counts);
    $('result-rank').textContent = result.rank;
    // ゲームオーバーの回はランクを出さない（オーナー指示 2026-11-22「ゲームオーバーはランクなしでいい」）
    $('result-rank').hidden = result.failed;
    $('result-gameover').hidden = !result.failed;
    $('result-autoplay').hidden = !result.autoplay;
    // 失敗の回にフルコンボの印は出さない（全 GOOD でも GOOD の −1 が積もればライフは尽きうる）
    $('result-fullcombo').hidden = !fullCombo;
    $('result-newrecord').hidden = !newRecord;
    $('result-song').textContent = `${result.songTitle}（${DIFFICULTIES[lastDiff].label}）`;
    $('result-score').textContent = String(result.score);
    $('result-best').textContent = String(best);
    $('result-counts').textContent = `PERFECT ${result.counts.perfect} / GREAT ${result.counts.great} / GOOD ${result.counts.good} / MISS ${result.counts.miss}`;
    $('result-accuracy').textContent = result.accuracy.toFixed(1);
    $('result-combo').textContent = String(result.maxCombo);
    // 失敗の回は「次の曲」へ進めない（もう一度／メニューへのみ）
    $('next-button').hidden = result.failed;
    // 読み上げも、ゲームオーバーの回はランクを読み上げない（「ゲームオーバー」＋成績の形）
    $('game-live').textContent = result.failed
      ? `結果: ゲームオーバー、スコア${result.score}、精度${result.accuracy.toFixed(1)}%${result.autoplay ? '（オートプレイ）' : ''}`
      : `結果: ランク${result.rank}、スコア${result.score}、精度${result.accuracy.toFixed(1)}%${fullCombo ? '、フルコンボ' : ''}${newRecord ? '、ハイスコア更新' : ''}${result.autoplay ? '（オートプレイ）' : ''}`;
    show('result');
    renderMenu();
    // 達成ボイスは結果カードが出た瞬間に鳴らす（ジングルの頭は表示待ちの間に
    // 鳴り終わっている。両方達成なら フルコンボ→ハイスコア更新 の順に続ける。
    // ゲームオーバーの回はどちらも鳴らさない）
    if (!result.failed) {
      const voices: ResultVoice[] = [];
      if (fullCombo) voices.push('fullcombo');
      if (newRecord) voices.push('newrecord');
      playResultVoices(voices);
    }
  }
  $('again-button').addEventListener('click', () => {
    selectedSong = lastEntry.id;
    selectedDiff = lastDiff;
    void startGame();
  });
  $('next-button').addEventListener('click', () => {
    // 曲順（SONGS の並び＝トラック順）で次の曲へ。最後の曲の次は先頭に戻る
    // （オーナー指示 2026-11-21）。難易度はいまの演奏のまま変えない
    const next = SONGS[(slideIndex(lastEntry.id) + 1) % SONGS.length];
    selectedSong = next.id;
    selectedDiff = lastDiff;
    save('song', selectedSong);
    renderMenu();
    void startGame();
  });
  $('back-button').addEventListener('click', () => {
    show('menu');
    renderMenu();
  });
  // 中断の確認カード: 「つづける」は READY をはさんで再開、「はじめからやりなおす」は
  // 同じ曲・難易度を頭から開始し直す、「メニューに戻る」は記録せずメニューへ
  $('pause-resume-button').addEventListener('click', () => {
    game.resume();
  });
  $('pause-retry-button').addEventListener('click', () => {
    game.restart();
  });
  $('pause-abort-button').addEventListener('click', () => {
    game.abort();
  });

  // 初回のタップで音声を unlock する（iPhone ではジェスチャの中で AudioContext を起こす必要がある）
  window.addEventListener('pointerdown', () => unlockAudio());

  exposeTestApi({
    getGameState: () => ({
      screen,
      song: selectedSong,
      difficulty: selectedDiff,
      offset: offsetMs,
      speed: speedMul,
      playing: game.isPlaying,
      life: game.lifeValue,
      songMs: game.songPositionMs(),
      sound: isSoundOn(),
      vibrate: isVibrateOn(),
      lyrics: true,
      debugMode: isDebug(),
      autoplay: autoplayOn,
      latency: latencyUi,
      gameAutoplay: game.isAutoplay,
      audioUnlocked: isUnlocked(),
      audioState: audioState(),
    }),
    setGameState: (patch: Record<string, unknown>) => {
      if (typeof patch.song === 'string' && SONGS.some((s) => s.id === patch.song)) {
        selectedSong = patch.song as SongId;
        scrollToSong(selectedSong, false);
      }
      if (typeof patch.difficulty === 'string' && patch.difficulty in DIFFICULTIES) selectedDiff = patch.difficulty as Difficulty;
      if (typeof patch.offset === 'number') offsetMs = clampOffset(patch.offset);
      if (typeof patch.speed === 'number') speedMul = clampSpeed(patch.speed);
      if (typeof patch.debugMode === 'boolean') {
        // デバッグモードは CD 側と共有の旗（バージョン表示の5回タップと同じもの）
        setDebug(patch.debugMode);
        refreshDebugPanel();
      }
      if (typeof patch.autoplay === 'boolean') {
        autoplayOn = patch.autoplay;
        save('autoplay', autoplayOn);
        syncAutoplayAction();
        refreshDebugPanel();
      }
      // E2E 用: 音声時計の凍結（iOS の interrupted 再現）と復帰
      if (patch.audio === 'suspend') void audioContext().suspend();
      if (patch.audio === 'resume') void audioContext().resume();
      // E2E 用: resume しても二度と戻らない壊れた context の再現（実機の再現手順用）
      if (patch.audio === 'poison') {
        const ac = audioContext() as AudioContext & { resume: () => Promise<void> };
        ac.resume = () => new Promise<void>(() => undefined);
        void ac.suspend();
      }
      // E2E 用: state は running のまま currentTime だけが止まる状態の再現
      // （メニューで背景へ行き復帰してから始めた実機の症状用）
      if (patch.audio === 'stick') {
        const ac = audioContext();
        const fixed = ac.currentTime;
        Object.defineProperty(ac, 'currentTime', { configurable: true, get: () => fixed });
      }
      // E2E 用: 'stick' の差し替えを外して時計を復帰させる
      if (patch.audio === 'unstick') {
        const ac = audioContext() as unknown as Record<string, unknown>;
        delete ac['currentTime'];
      }
      renderMenu();
    },
    startGame: () => startGame(),
    // 撮影・E2E 用: プレイ中なら、いまの成績で結果へ進む（デバッグパネルの「結果へ」と同じ）
    finishNow: () => game.finishNow(),
    // 撮影・E2E 用: プレイ中のコンボ数を直接セットする（コンボ連動エフェクトの確認用）
    setCombo: (n: unknown) => {
      if (typeof n === 'number') game.debugSetCombo(n);
    },
  });
  requestPersist();

  // リズムゲーム画面へ入るたびに、メニュー画面から始める
  function enter(): void {
    show('menu');
    renderMenu();
    scrollToSong(selectedSong, false);
    armHistoryGuard();
    // 端スワイプの誤発そのものを減らすため、入場時にフルスクリーンを試みる
    // （1回目の端スワイプがシステム UI の表示で済む端末が多い）。ただし対象は
    // Android のみ（オーナー決定 2026-11-21）: フルスクリーンは端スワイプ対策
    // なので、ジェスチャーナビゲーションの無い PC 等では、入場時にウィンドウを
    // 勝手に全画面にしない。非対応の環境や拒否された場合は何もしない
    if (
      !document.fullscreenElement &&
      detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) === 'android'
    ) {
      try {
        const p = document.documentElement.requestFullscreen?.() as Promise<void> | undefined;
        p?.catch(() => undefined);
      } catch {
        /* 非対応環境では無視する */
      }
    }
  }

  // リズムゲームから出るとき（CD 側の画面へ戻るとき）の後片付け
  function exit(): void {
    disarmHistoryGuard();
    if (document.fullscreenElement) {
      try {
        const p = document.exitFullscreen() as Promise<void> | undefined;
        p?.catch(() => undefined);
      } catch {
        /* 解除できない環境では無視する */
      }
    }
  }
  return { enter, exit };
}
let gameMode: { enter: () => void; exit: () => void } | null = null;

/** リズムゲームへ入る（初回は初期化し、毎回メニュー画面から始める） */
export function enterGameMode(): void {
  gameMode ??= initGameMode();
  gameMode.enter();
}

/** リズムゲームから出る（履歴ガードの掃除とフルスクリーンの解除） */
export function exitGameMode(): void {
  gameMode?.exit();
}
