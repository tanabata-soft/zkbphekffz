import './style.css';
import { ALBUM, COLOPHON, FOOT_NOTE, HOWTO_EXTRA, LINER, LINER_TITLES, NOTE } from './album/album';
import { TRACKS } from './album/tracks';
import { SYNC } from './album/sync';
import { TRACK_AUDIO, TRACK_IMG } from './album/media';
import {
  buildPages,
  currentLineIndex,
  fmt,
  needsInterlude,
  nextIndex,
  prevAction,
  prevIndex,
} from './logic';
import { exposeTestApi, setData, setupDebug } from './debug';
import { setupInstallGuide } from './install';
import { setupUpdateBanner } from './pwa';
import { downloadAllAudio } from './download';

const $ = <T extends HTMLElement>(s: string): T => {
  const el = document.querySelector(s);
  if (!el) throw new Error(`${s} not found`);
  return el as T;
};
const audio = $<HTMLAudioElement>('#audio');

/** シングル形態（短冊型ジャケット＋裏面ノート、ブックレットなし）かどうか */
const SINGLE = ALBUM.layout === 'single';
if (SINGLE) document.body.classList.add('layout-single');

/* ---------- シングル形態の組み立て（ブックレットの代わりに裏面パネル） ---------- */
if (SINGLE) {
  // ブックレットのボタンは置かない
  $('#btn-open-booklet').closest('.abtn')?.remove();
  // 曲目ボタンも置かない（曲目は裏面パネルの表示専用リストで見せる。オーナー指示 2026-11-04）
  $('#btn-open-tracks').closest('.abtn')?.remove();
  // ジャケット裏面: 2曲のジャケットを結合した画像（back.jpg）の上に、
  // ライナーノート・曲目（長さ）・バージョン情報を載せる
  const panel = document.createElement('div');
  panel.className = 'backnote';
  const head = document.createElement('div');
  head.className = 'bn-head';
  const hCat = document.createElement('span');
  hCat.textContent = ALBUM.catalog;
  const hFmt = document.createElement('span');
  hFmt.textContent = ALBUM.format;
  head.append(hCat, hFmt);
  panel.append(head);
  for (const text of NOTE) {
    const p = document.createElement('p');
    p.className = 'bn-p';
    p.textContent = text;
    panel.append(p);
  }
  // 曲目リスト（表示専用：番号・タイトル・ジャンル・長さ。タップで遷移はしない）
  TRACKS.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'bn-track';
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = String(i + 1);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.append(document.createTextNode(t.title));
    const gn = document.createElement('span');
    gn.className = 'gn';
    gn.textContent = t.genre;
    nm.append(gn);
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = t.time;
    d.append(no, nm, tm);
    panel.append(d);
  });
  // バージョン表示は裏面パネルの下部へ移す（タップで反転しないよう伝播を止める）
  const vl = $('#version-line');
  vl.addEventListener('click', (e) => e.stopPropagation());
  panel.append(vl);
  $('.flip .face.back').append(panel);
  // 裏面はスクロールなしで全面が収まるように、パネルの font-size を自動調整する
  // （中身の寸法は style.css 側で em 連動。最小 6.5px まで縮める）オーナー指示 2026-11-12
  const fitBacknote = (): void => {
    let size = 12;
    panel.style.fontSize = `${size}px`;
    while (size > 6.5 && panel.scrollHeight > panel.clientHeight) {
      size -= 0.5;
      panel.style.fontSize = `${size}px`;
    }
  };
  fitBacknote();
  requestAnimationFrame(fitBacknote);
  addEventListener('resize', fitBacknote);
  // インストール入口（残った .book-foot）は曲目画面の末尾へ移す
  const foot = document.querySelector('.book-foot');
  if (foot) $('.backcover').append(foot);
}

let cur = -1;
let discMode = false;
let repeatOne = false;
let lastLine = -1;
let currentView = 'cover';

/* ---------- 画面遷移 ---------- */
function go(name: string): void {
  // トップへ戻っても再生は止めない（シングル・アルバム共通。オーナー指示 2026-11-12。
  // 旧シングル仕様「トップへ戻ると止まる」2026-11-04 は廃止）
  currentView = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('on'));
  $(`#view-${name}`).classList.add('on');
  window.scrollTo(0, 0);
  setData('view', name);
}
document.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.go) go(b.dataset.go);
  }),
);
if (!SINGLE)
  $('#btn-open-booklet').addEventListener('click', () => {
    renderPage(0);
    go('booklet');
  });
$('#btn-play-all').addEventListener('click', () => {
  // すでに再生中（または一時停止中）のときは、最初から再生し直さず再生画面へ戻るだけにする（オーナー指示 2026-11-05）
  if (cur >= 0 && !audio.ended) {
    go('player');
    return;
  }
  playTrack(0, true);
});
if (!SINGLE) $('#btn-open-tracks').addEventListener('click', () => go('tracks'));

/* ---------- 曲目（裏ジャケット） ---------- */
function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}
function buildTracklist(el: HTMLElement | null, jump: boolean): void {
  if (!el) return;
  TRACKS.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'trow';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.append(document.createTextNode(t.title));
    if (t.bonus) nm.append(span('bonus', 'BONUS'));
    nm.append(span('gn', t.genre));
    d.append(span('no', String(i + 1)), nm, span('tm', t.time));
    if (jump)
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        playTrack(i, true);
      });
    el.append(d);
  });
}
buildTracklist($('#tracklist'), true);
buildTracklist($('#tracklist2'), false);
$('#bc-foot').textContent = FOOT_NOTE;

/* ---------- ジャケットの反転（表⇔裏） ---------- */
const flipEl = $('#flip');
let flipped = false;
function setFlip(on: boolean): void {
  flipped = on;
  flipEl.classList.toggle('flipped', on);
}
flipEl.addEventListener('click', () => setFlip(!flipped));
let flipTouchX: number | null = null;
flipEl.addEventListener(
  'touchstart',
  (e) => {
    flipTouchX = e.touches[0].clientX;
  },
  { passive: true },
);
flipEl.addEventListener(
  'touchend',
  (e) => {
    if (flipTouchX === null) return;
    const dx = e.changedTouches[0].clientX - flipTouchX;
    flipTouchX = null;
    if (Math.abs(dx) > 48) setFlip(!flipped);
  },
  { passive: true },
);

/* ---------- ブックレット ---------- */
const PAGES = buildPages(TRACKS, SYNC, {
  liner: LINER,
  linerTitles: LINER_TITLES,
  howtoExtra: HOWTO_EXTRA,
  colophon: COLOPHON,
});
let pg = 0;
function renderPage(n: number): void {
  pg = Math.max(0, Math.min(PAGES.length - 1, n));
  const p = PAGES[pg];
  const nodes: Node[] = [];
  if (p.imgTrack !== undefined) {
    const img = document.createElement('img');
    img.className = 'pimg';
    img.src = TRACK_IMG[p.imgTrack];
    img.alt = '';
    nodes.push(img);
  }
  const h3 = document.createElement('h3');
  h3.textContent = p.h3;
  nodes.push(h3);
  if (p.meta) {
    const d = document.createElement('div');
    d.className = 'meta';
    d.textContent = p.meta;
    nodes.push(d);
  }
  for (const x of p.body) {
    const par = document.createElement('p');
    par.textContent = x;
    nodes.push(par);
  }
  if (p.lyrics) {
    const d = document.createElement('div');
    d.className = 'lyrics';
    d.textContent = p.lyrics;
    nodes.push(d);
  }
  const folio = document.createElement('div');
  folio.className = 'folio';
  folio.textContent = `${pg + 1} ／ ${PAGES.length}`;
  nodes.push(folio);
  $('#book-page').replaceChildren(...nodes);
  $('#book-ttl').textContent = p.h4;
  $('#pg-ind').textContent = `${pg + 1} / ${PAGES.length}`;
  $('.book-stage').scrollTop = 0;
  setData('page', pg);
}
let touchX: number | null = null;
const bookPageEl = $('#book-page');
bookPageEl.addEventListener('pointerdown', (e) => {
  touchX = e.clientX;
});
bookPageEl.addEventListener('pointerup', (e) => {
  if (touchX === null) return;
  const dx = e.clientX - touchX;
  touchX = null;
  if (dx < -48) renderPage(pg + 1);
  else if (dx > 48) renderPage(pg - 1);
});
bookPageEl.addEventListener('pointercancel', () => {
  touchX = null;
});
bookPageEl.addEventListener('dragstart', (e) => e.preventDefault());

/* ---------- 再生 ---------- */
function fitTitle(): void {
  const el = $('#p-title');
  if (!el.textContent) return;
  let s = 19;
  el.style.fontSize = `${s}px`;
  while (el.scrollWidth > el.clientWidth && s > 11) {
    s -= 0.5;
    el.style.fontSize = `${s}px`;
  }
}
window.addEventListener('resize', () => fitTitle());

function playTrack(i: number, autoplay: boolean): void {
  cur = i;
  lastLine = -1;
  const t = TRACKS[i];
  audio.src = TRACK_AUDIO[i];
  $<HTMLImageElement>('#p-img').src = TRACK_IMG[i];
  const pt = $('#p-title');
  pt.replaceChildren(document.createTextNode(t.title));
  if (t.bonus) {
    const sp = document.createElement('span');
    sp.className = 'bonus-sfx';
    sp.textContent = '（ボーナストラック）';
    pt.append(sp);
  }
  fitTitle();
  buildLyrics(t.src);
  go('player');
  setData('track', i);
  requestAnimationFrame(() => scrollLyricsToCurrent(false));
  if (autoplay) audio.play().catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      album: ALBUM.title,
      artwork: [{ src: TRACK_IMG[i], sizes: '1024x1024', type: 'image/jpeg' }],
    });
  }
}

function buildLyrics(src: string): void {
  const box = $('#lyrics-box');
  box.replaceChildren();
  const lines = SYNC[src] ?? [];
  if (needsInterlude(lines)) {
    const p = document.createElement('p');
    p.className = 'interlude';
    p.textContent = '♪';
    p.dataset.t = '0';
    box.append(p);
  }
  lines.forEach(([t, text]) => {
    const p = document.createElement('p');
    p.textContent = text;
    p.dataset.t = String(t);
    box.append(p);
  });
  box.scrollTop = 0;
  requestAnimationFrame(updateLyricsThumb);
}

function syncLyrics(): void {
  if (cur < 0) return;
  const lines = SYNC[TRACKS[cur].src] ?? [];
  const idx = currentLineIndex(lines, audio.currentTime);
  const box = $('#lyrics-box');
  const children = [...box.querySelectorAll('p')];
  const offset = children.length - lines.length;
  children.forEach((p) => p.classList.remove('cur'));
  if (idx >= 0 && children[idx + offset]) {
    children[idx + offset].classList.add('cur');
    if (idx !== lastLine && !lyrHold && !lyrTimer) scrollLyricsToCurrent(true);
  }
  lastLine = idx;
}

/* ---------- 歌詞の自由スクロール（手を離して3秒で再生位置へ戻る） ---------- */
let lyrHold = false;
let lyrTimer: ReturnType<typeof setTimeout> | null = null;
let lyrWheelTimer: ReturnType<typeof setTimeout> | null = null;
function scrollLyricsToCurrent(smooth: boolean): void {
  const box = $('#lyrics-box');
  const curEl = box.querySelector('p.cur');
  if (!curEl) return;
  box.scrollTo({
    top: Math.max(0, (curEl as HTMLElement).offsetTop - box.clientHeight * 0.38),
    behavior: smooth ? 'smooth' : 'auto',
  });
}
function updateLyricsThumb(): void {
  const box = $('#lyrics-box');
  const th = $('#lyrics-thumb');
  const h = Math.max(6, (box.clientHeight / Math.max(1, box.scrollHeight)) * 100);
  const max = box.scrollHeight - box.clientHeight;
  th.style.height = `${h}%`;
  th.style.top = `${max > 0 ? (box.scrollTop / max) * (100 - h) : 0}%`;
}
function lyrInteractStart(): void {
  lyrHold = true;
  if (lyrTimer) {
    clearTimeout(lyrTimer);
    lyrTimer = null;
  }
}
function lyrInteractEnd(): void {
  if (lyrTimer) clearTimeout(lyrTimer);
  lyrTimer = setTimeout(() => {
    lyrTimer = null;
    lyrHold = false;
    if (!audio.paused) scrollLyricsToCurrent(true);
  }, 3000);
}
const lyrBoxEl = $('#lyrics-box');
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
/* ---------- 歌詞タップでその行から再生（スクロール操作とは競合させない） ---------- */
let lyrDownX = 0;
let lyrDownY = 0;
let lyrDownScrollTop = 0;
lyrBoxEl.addEventListener('pointerdown', (e) => {
  lyrDownX = e.clientX;
  lyrDownY = e.clientY;
  lyrDownScrollTop = lyrBoxEl.scrollTop;
  lyrInteractStart();
});
lyrBoxEl.addEventListener('pointerup', lyrInteractEnd);
lyrBoxEl.addEventListener('pointercancel', lyrInteractEnd);
lyrBoxEl.addEventListener('click', (e) => {
  const p = (e.target as HTMLElement).closest('p');
  if (!p || !lyrBoxEl.contains(p)) return;
  // 押してからドラッグした（指・カーソルの移動が大きい、または実際にスクロールした）場合は
  // スクロール操作とみなしてシークしない
  const moved = Math.max(Math.abs(e.clientX - lyrDownX), Math.abs(e.clientY - lyrDownY));
  if (moved > 10 || Math.abs(lyrBoxEl.scrollTop - lyrDownScrollTop) > 1) return;
  const t = Number(p.dataset.t ?? '0');
  if (!Number.isFinite(t)) return;
  // シークするタップでは、自由スクロールの保留（3秒で再生位置へ戻る）を解除して選んだ行へ寄せる
  if (lyrTimer) {
    clearTimeout(lyrTimer);
    lyrTimer = null;
  }
  lyrHold = false;
  audio.currentTime = t;
  audio.play().catch(() => {});
  syncLyrics();
  scrollLyricsToCurrent(true);
});
lyrBoxEl.addEventListener(
  'wheel',
  () => {
    lyrInteractStart();
    if (lyrWheelTimer) clearTimeout(lyrWheelTimer);
    lyrWheelTimer = setTimeout(lyrInteractEnd, 350);
  },
  { passive: true },
);
lyrBoxEl.addEventListener('scroll', updateLyricsThumb, { passive: true });
audio.addEventListener('play', () => {
  if (!lyrHold && !lyrTimer) scrollLyricsToCurrent(true);
});

audio.addEventListener('timeupdate', () => {
  $('#t-cur').textContent = fmt(audio.currentTime);
  $('#t-dur').textContent = fmt(audio.duration);
  if (audio.duration) $<HTMLInputElement>('#seek').value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  syncLyrics();
});
audio.addEventListener('play', () => {
  $('#play-ic').setAttribute('d', 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z');
  $('#play-lb').textContent = '一時停止';
  $('#disc-wrap').classList.toggle('playing', true);
  updateDisc();
  setWakeLock(true);
  setData('playing', '1');
});
audio.addEventListener('pause', () => {
  $('#play-ic').setAttribute('d', 'M8 5v14l11-7z');
  $('#play-lb').textContent = '再生';
  updateDisc();
  setWakeLock(false);
  setData('playing', '0');
});
audio.addEventListener('ended', () => {
  if (cur < 0) return;
  if (repeatOne) {
    audio.currentTime = 0;
    lastLine = -1;
    audio.play().catch(() => {});
    syncLyrics();
    return;
  }
  playTrack(nextIndex(cur, TRACKS.length), true);
});
$('#btn-play').addEventListener('click', () => {
  if (cur < 0) {
    playTrack(0, true);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});
/* 戻る: 3秒より進んでいたら曲の先頭へ、3秒以内なら前の曲へ（Spotifyなど一般的な方式）。前後は端でループする */
function prevTrack(): void {
  if (cur < 0) return;
  if (prevAction(audio.currentTime) === 'restart') {
    audio.currentTime = 0;
    lastLine = -1;
    syncLyrics();
    if (!lyrHold && !lyrTimer) {
      if ($('#lyrics-box').querySelector('p.cur')) scrollLyricsToCurrent(true);
      else $('#lyrics-box').scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }
  playTrack(prevIndex(cur, TRACKS.length), true);
}
function nextTrack(): void {
  if (cur < 0) return;
  playTrack(nextIndex(cur, TRACKS.length), true);
}
$('#btn-prev').addEventListener('click', prevTrack);
$('#btn-next').addEventListener('click', nextTrack);
$('#btn-home').addEventListener('click', () => go('cover'));
document.querySelector('#btn-tracks2')?.addEventListener('click', () => go('tracks'));
/* リピート切替（シングル形態の再生画面）: 全曲リピート ⇔ 1曲リピート */
const repBtn = document.querySelector<HTMLButtonElement>('#btn-repeat');
repBtn?.addEventListener('click', () => {
  repeatOne = !repeatOne;
  repBtn.classList.toggle('one', repeatOne);
  repBtn.setAttribute('aria-label', repeatOne ? 'リピート: 1曲' : 'リピート: 全曲');
  const badge = repBtn.querySelector<HTMLElement>('.rep-one');
  if (badge) badge.hidden = !repeatOne;
  const lb = document.querySelector('#repeat-lb');
  if (lb) lb.textContent = repeatOne ? '1曲リピート' : '全曲リピート';
});
$<HTMLInputElement>('#seek').addEventListener('input', (e) => {
  if (audio.duration) audio.currentTime = (Number((e.target as HTMLInputElement).value) / 1000) * audio.duration;
});
function updateDisc(): void {
  $('#disc-wrap').classList.toggle('disc', discMode);
  $<HTMLImageElement>('#disc-wrap img').style.animationPlayState = discMode && !audio.paused ? 'running' : 'paused';
}
$('#disc-wrap').addEventListener('click', () => {
  discMode = !discMode;
  updateDisc();
});

window.addEventListener('resize', () => {
  updateLyricsThumb();
});

/* ---------- 画面スリープ防止（再生中） ---------- */
interface WakeLockLike {
  release(): Promise<void>;
}
let wakeLock: WakeLockLike | null = null;
async function setWakeLock(on: boolean): Promise<void> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> };
    };
    if (on && nav.wakeLock) {
      wakeLock = await nav.wakeLock.request('screen');
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // 対応していない環境では何もしない
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !audio.paused) void setWakeLock(true);
});

/* ---------- バックグラウンド再生（Media Session） ---------- */
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler('play', () => {
      audio.play().catch(() => {});
    });
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', () => prevTrack());
    ms.setActionHandler('nexttrack', () => nextTrack());
    ms.setActionHandler('seekto', (e) => {
      if (e.seekTime != null) audio.currentTime = e.seekTime;
    });
  } catch {
    // ハンドラ未対応の環境では何もしない
  }
}

/* ---------- テンプレート共通の配線 ---------- */
$('#version').textContent = __APP_VERSION__;
setupDebug($('#debug-panel'), $('#version-line'), [
  { label: '表', title: '表ジャケットへ', run: () => go('cover') },
  { label: '曲目', title: '曲目へ', run: () => go('tracks') },
  { label: '再生', title: '再生画面へ（選曲していなければ1曲目）', run: () => playTrack(cur < 0 ? 0 : cur, false) },
  ...(SINGLE
    ? []
    : [
        {
          label: '本',
          title: 'ブックレットへ',
          run: () => {
            renderPage(pg);
            go('booklet');
          },
        },
      ]),
]);
exposeTestApi({
  getState: () => ({ view: currentView, track: cur, page: pg, flipped, disc: discMode }),
  setState: (patch) => {
    if (typeof patch.track === 'number') playTrack(patch.track, false);
    if (typeof patch.page === 'number' && !SINGLE) {
      renderPage(patch.page);
      go('booklet');
    }
    if (typeof patch.view === 'string') go(patch.view);
    if (typeof patch.disc === 'boolean') {
      discMode = patch.disc;
      updateDisc();
    }
  },
});
setupUpdateBanner($('#update-banner'), $('#update-button'), $('#update-later'));
// 初回一括ダウンロード（全音源を端末に入れる）。最初の表示が落ち着いてから裏で始める。
{
  const dlBanner = $('#dl-banner');
  const dlLabel = $('#dl-label');
  window.setTimeout(() => {
    void downloadAllAudio(TRACK_AUDIO, (done, total) => {
      if (dlBanner.hidden) {
        dlBanner.hidden = false;
        setData('downloading', '1');
      }
      dlLabel.textContent = `ダウンロード中… ${done}/${total}曲`;
    }).then((result) => {
      if (result === 'complete') {
        dlLabel.textContent = 'ダウンロードが終わりました';
        window.setTimeout(() => {
          dlBanner.hidden = true;
          setData('downloading', '0');
        }, 1600);
      } else {
        dlBanner.hidden = true;
        setData('downloading', '0');
      }
    });
  }, 600);
}
const installButtons = ['#install-open', '#install-open-cover']
  .map((sel) => document.querySelector<HTMLButtonElement>(sel))
  .filter((b): b is HTMLButtonElement => b !== null);
setupInstallGuide(
  installButtons,
  $<HTMLDialogElement>('#install-dialog'),
  $<HTMLButtonElement>('#install-now'),
);
setData('view', 'cover');
setData('track', -1);

// ここまで来たら起動成功（public/boot.js が見ている）
window.__appStarted = true;
