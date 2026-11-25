// 曲の再生（Web Audio）。デコード済みのバッファは曲ごとに保持し、再プレイで再デコードしない
// （元ゲームは再プレイのたびに数MBをデコードし直していた）。
//
// iPhone で音が出ない問題への対策（v1.2.0）:
//  1. マナーモード（消音スイッチ）で Web Audio が消音される iOS の仕様への対策として、
//     Audio Session API（iOS 17+）が使える環境では navigator.audioSession.type = 'playback' にする。
//  2. ジェスチャの外で作られた AudioContext は suspended のままになることがあるため、
//     利用者の操作（pointerdown / スタートボタン）の中で unlockAudio() を呼び、
//     生成・resume・無音バッファの再生で音声を unlock する。
//  3. 再生開始の直前と、ゲーム中のタップでも resume を試みる（game.ts 側）。
// 曲とヒット音は共通のマスター GainNode 経由で destination へつなぐ（経路の一元化）。

interface AudioSessionLike {
  type: string;
}

interface NavigatorWithAudioSession {
  audioSession?: AudioSessionLike;
}

let ctx: AudioContext | undefined;
let master: GainNode | undefined;
const buffers = new Map<string, AudioBuffer>();
let current: AudioBufferSourceNode | undefined;
let unlocked = false;
/** AudioContext の世代。作り直すたびに進む（作り直しに追随してノードを作り直す側が参照する） */
let generation = 0;

export const audioGeneration = (): number => generation;

/**
 * AudioContext を作り直す。バックグラウンド復帰などで iOS の AudioContext が
 * 壊れたまま（resume しても running に戻らず、時計が凍る）になることがあり、
 * その場合は同じ context を起こし続けても直らないため、新しい context に替える。
 * デコード済みバッファは context に依存しないので保持する。ノード類（マスターや
 * sound.ts のヒット音バス）は世代を見て作り直すこと。
 */
export function recreateAudioContext(): void {
  const old = ctx;
  ctx = undefined;
  master = undefined;
  current = undefined;
  unlocked = false;
  generation++;
  if (old) {
    try {
      void old.close().catch(() => undefined);
    } catch {
      // 閉じられなくても続行する
    }
  }
}

/**
 * Audio Session API が使える環境（iOS 17+ の Safari）では、音声セッションを 'playback' にする。
 * これをしないと、iPhone のマナーモードで Web Audio が消音される。非対応環境では何もしない。
 */
export function applyAudioSession(): void {
  try {
    const nav = navigator as Navigator & NavigatorWithAudioSession;
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    // 非対応環境では何もしない
  }
}

export function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    applyAudioSession();
  }
  return ctx;
}

/** 曲・効果音の共通の出口（マスター GainNode）。destination への接続はここに一元化する。 */
export function audioOutput(): AudioNode {
  const ac = audioContext();
  if (!master) {
    master = ac.createGain();
    master.gain.value = 1;
    master.connect(ac.destination);
  }
  return master;
}

// ---- 曲専用の合流点（ビジュアライザー用のアナライザを挟む） ----
// 曲は ゲイン（×1、そのまま通過）→ AnalyserNode（通過）→ マスター の順に流す。
// どちらも音量・タイミングを変えないので、効果音やジングル（マスター直結）には
// 影響せず、解析対象は曲だけになる。AudioContext が作り直されたら（世代が
// 変わったら）ノードも作り直す（sound.ts のヒット音バスと同じ流儀）。
let musicTap: { input: GainNode; analyser: AnalyserNode } | undefined;
let musicTapGeneration = -1;

function ensureMusicTap(): { input: GainNode; analyser: AnalyserNode } {
  const ac = audioContext();
  if (!musicTap || musicTapGeneration !== audioGeneration()) {
    musicTapGeneration = audioGeneration();
    const input = ac.createGain();
    input.gain.value = 1;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    input.connect(analyser);
    analyser.connect(audioOutput());
    musicTap = { input, analyser };
  }
  return musicTap;
}

/** 曲の再生先（曲専用の合流点の入口）。曲はここへつなぐ */
export function musicInput(): AudioNode {
  return ensureMusicTap().input;
}

/**
 * ビジュアライザー用: 曲のアナライザ。AudioContext がまだ無い、または作り直しで
 * 世代が変わっているときは undefined（呼び出し側は「データなし」として扱う）
 */
export function musicAnalyser(): AnalyserNode | undefined {
  if (!ctx || !musicTap || musicTapGeneration !== audioGeneration()) return undefined;
  return musicTap.analyser;
}

export function nowSeconds(): number {
  return audioContext().currentTime;
}

/** AudioContext の状態（未生成なら 'none'）。テスト用の入口から状態を確認するために使う。 */
export function audioState(): AudioContextState | 'none' {
  return ctx ? ctx.state : 'none';
}

/** 無音バッファによる unlock が済んでいるか */
export const isUnlocked = (): boolean => unlocked;

/**
 * 音声の unlock。利用者のジェスチャの中で呼ぶこと。
 * AudioContext を生成して resume し、無音の短いバッファを1回だけ再生する
 * （iOS Safari で Web Audio を鳴らせる状態にするための定番の処理）。
 * 2回目以降は resume のみ（無音バッファは再生し直さない）。
 */
export function unlockAudio(): void {
  const ac = audioContext();
  applyAudioSession();
  try {
    void Promise.resolve(ac.resume()).catch(() => undefined);
  } catch {
    // resume できなくても続行する
  }
  if (unlocked) return;
  unlocked = true;
  try {
    const len = Math.max(1, Math.floor(ac.sampleRate * 0.05));
    const silent = ac.createBuffer(1, len, ac.sampleRate);
    const src = ac.createBufferSource();
    src.buffer = silent;
    src.connect(audioOutput());
    src.start(0);
  } catch {
    // unlock の音が出なくても続行する
  }
}

/** AudioContext を running に戻す（audioSession の設定もやり直す）。 */
export async function resumeAudio(): Promise<void> {
  const ac = audioContext();
  applyAudioSession();
  try {
    // 壊れた context では resume() の Promise が二度と解決しないことがある。
    // 呼び出し側（曲の読み込みや開始処理）が止まってしまわないよう、短い
    // タイムアウトで見切って続行する（2026-11-20 の再現テストで発覚）
    await Promise.race([
      ac.resume(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 600);
      }),
    ]);
  } catch {
    // 戻せなくても続行する
  }
}

/**
 * data: URL をバイト列へ戻す。Safari / WebKit は fetch で data: URL を読めないため、
 * 単体ファイルプレビュー（音源が data: URL で埋め込まれる）では fetch 経由だと
 * 音源が読み込めずゲームが始まらない。data: のときは自前でデコードする。
 */
function dataUriToArrayBuffer(url: string): ArrayBuffer {
  const comma = url.indexOf(',');
  const meta = url.slice(0, comma);
  const data = url.slice(comma + 1);
  if (meta.includes(';base64')) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(data)).buffer as ArrayBuffer;
}

/** 曲の音源を読み込んでデコードする。2回目以降は保持したバッファを返す。 */
export async function loadBuffer(url: string): Promise<AudioBuffer> {
  const cached = buffers.get(url);
  if (cached) return cached;
  const ac = audioContext();
  await resumeAudio();
  let raw: ArrayBuffer;
  if (url.startsWith('data:')) {
    raw = dataUriToArrayBuffer(url);
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`音源を読み込めませんでした (${res.status})`);
    raw = await res.arrayBuffer();
  }
  const buf = await ac.decodeAudioData(raw);
  buffers.set(url, buf);
  return buf;
}

/** バッファを指定時刻に再生開始する。offsetSec はバッファ内の開始位置（途中からの再開用）。 */
export function playBuffer(buf: AudioBuffer, when: number, offsetSec = 0): AudioBufferSourceNode {
  stopCurrent();
  const src = audioContext().createBufferSource();
  src.buffer = buf;
  // 曲だけは専用の合流点（アナライザ経由）を通す。音量・タイミングは変わらない
  src.connect(musicInput());
  src.start(when, Math.max(0, offsetSec));
  current = src;
  return src;
}

export function stopCurrent(): void {
  if (!current) return;
  try {
    current.stop();
  } catch {
    // すでに止まっている
  }
  current = undefined;
}
