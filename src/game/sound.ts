// 効果音は Web Audio で合成するのが基本。オン/オフ設定は必ず用意する。
// 例外は音声ファイルだけ: ヒット音のサンプル音源と、フルコンボ演出の
// ボイス（どちらも任意の素材スロット。src/presentation.ts と下記参照）と、
// フリック音のサンプル音源・結果発表ジングル・ゲームオーバー音・結果画面の
// 達成ボイス2種（いずれもテンプレート標準素材として同梱。下記の各節を参照）。
// 標準素材の音源は NK-S006 でオーナーが選定したもの（フリック音は試聴で
// 選んだ H2 サンプル、ジングルとゲームオーバー音はオーナー提供ファイル）で、
// v1.8.1 で共通仕様として取り込んだ。ミス音だけは合成のまま。
// 音は、曲の再生と同じ AudioContext（src/audio.ts）を使う。
//
// ヒット音は「サンプル音源方式」: src/assets/hit-sample.wav（テンプレート付属の
// 自作パーカッション音。作品ごとに差し替える前提）を読み込んで鳴らす。
// MP3 化するとエンコーダ遅延でアタックがずれうるため、無遅延でデコードできる
// WAV のまま取り込む（小さなファイルにすること）。
//   判定別: PERFECT は大きく・長く・明るく、GREAT はその中間、
//   GOOD は小さく・短く・鈍く（ローパスを下げ、途中で切る）。
//   コンボ tier の変化はピッチではなく明るさ（ローパス）で付ける:
//   打撃系のサンプルは、ピッチを変えると別の音に聞こえてしまうため。
// サンプルが読み込めなかった場合のフォールバックとして、合成ブリップ
// （矩形波の2音）でも鳴らせるようにしてある（hitToneFor / HIT_BLIP）。
// ヒット音は専用バス（ゲイン→コンプレッサー）を通し、重なってもクリップしにくくする。
//
// 長押し中は「ヒット音の連打」: 頭のヒットと同時に、曲の16分音符の間隔で
// ヒット音を連続して鳴らす。連打は通常ヒットより小さく・短く、進行に合わせて
// 明るさが少しずつ上がる。周期的な揺れ（ビブラート等）は入れない。
// 拍 tick の音は鳴らさない（tick スコアの計算は logic.ts）。
// 完走音（3音ブリップ）・失敗音・空タップ音は、ヒット音とは役割の違う
// 小さな合成音として据え置く（ヒット音と聞き分けられるようにするため）。
import { audioContext, audioGeneration, audioOutput, loadBuffer } from './audio';
import { load, save } from './storage';
import { hitPitchMultiplier, type Judge, type Rank } from './logic';
import hitSampleUrl from './assets/hit-sample.wav';
import flickSampleUrl from './assets/flick-sample.wav';
import resultJingleUrl from './assets/result-jingle.mp3';
import gameOverUrl from './assets/game-over.mp3';
import voiceFullComboUrl from './assets/voice-fullcombo.mp3';
import voiceNewRecordUrl from './assets/voice-newrecord.mp3';

export type HitJudge = Exclude<Judge, 'miss'>;

/** 8bit系ブリップ1音分のパラメータ */
export interface BlipToneParams {
  /** 1音目の周波数 (Hz)。tier のピッチ補正はここにかかる */
  freq1: number;
  /** 2音目の周波数 (Hz)。0 なら2音目は鳴らさない */
  freq2: number;
  /** 3音目の周波数 (Hz)。0 なら3音目は鳴らさない（完走音用） */
  freq3: number;
  /** 1音目の長さ (秒) */
  dur1: number;
  /** 2音目の長さ (秒) */
  dur2: number;
  /** 3音目の長さ (秒) */
  dur3: number;
  /** 減衰の余分 (秒)。全体の長さに足して指数減衰させる */
  decaySec: number;
  /** 音量（曲を邪魔しない控えめな値） */
  peak: number;
  /** 頭のクリックの音量。0 でなし */
  clickPeak: number;
  /** クリックの長さ (秒) */
  clickSec: number;
}

/** サンプル素材の長さ（秒）。テンプレート付属の単発パーカッション（44.1kHz・モノラル） */
export const SAMPLE_DURATION_SEC = 0.12;

/** サンプル1発の鳴らし方（判定・tier・進行から決まる） */
export interface SampleToneParams {
  /** 音量（素材のピーク 0.9 に対する再生ゲイン） */
  peak: number;
  /** 鳴らす長さ（秒）。素材より短いときは、末尾に短いフェードを付けて切る */
  durSec: number;
  /** ローパスのカットオフ (Hz)。明るさの制御に使う（ピッチは変えない） */
  lowpassHz: number;
}

/** 判定ごとのサンプルの鳴らし方。PERFECT は最も大きく・長く・明るく、GOOD は小さく・短く・鈍く */
export const SAMPLE_HIT: Record<HitJudge, SampleToneParams> = {
  perfect: { peak: 0.5, durSec: SAMPLE_DURATION_SEC, lowpassHz: 9500 },
  great: { peak: 0.42, durSec: 0.1, lowpassHz: 8000 },
  good: { peak: 0.32, durSec: 0.075, lowpassHz: 5200 },
};

/** コンボ tier で明るさ（ローパス）が上がる付け方。ピッチは変えない */
export const SAMPLE_TIER_BRIGHTNESS = {
  /** 1 tier ごとのローパスの上昇率 */
  perTier: 0.15,
  /** 上限の tier（logic.ts の最高 tier と同じ 4） */
  maxTier: 4,
} as const;

/** tier 分の明るさ倍率（tier 0 で 1、上限 tier で 1 + perTier × maxTier） */
function tierBrightness(tier: number): number {
  const t = Math.min(SAMPLE_TIER_BRIGHTNESS.maxTier, Math.max(0, Math.floor(tier)));
  return 1 + SAMPLE_TIER_BRIGHTNESS.perTier * t;
}

/**
 * 長押し中の連打の1発のサンプル。通常ヒットより小さく・短い。
 */
export const SAMPLE_HOLD: SampleToneParams = { peak: 0.24, durSec: 0.06, lowpassHz: 7500 };

/** 連打の明るさが、ホールドの進行（頭→尾）で上がる倍率 */
export const HOLD_SAMPLE_RISE = 1.5;

/** 長押し中の連打の進め方 */
export const HOLD_STREAM = {
  /** 同時に鳴らす連打の上限（超えたら古いものから止める） */
  maxVoices: 4,
  /** 先行スケジュールの幅（秒）。AudioContext 時刻で予約するので、フレーム落ちで間隔が潰れない */
  lookaheadSec: 0.12,
  /** スケジューラの確認間隔 (ms) */
  timerMs: 25,
  /** 尾を過ぎても止め忘れた場合に、自分で止まるまでの余分（秒） */
  safetySec: 0.6,
  /** 止めるときの減衰の長さ（秒）。予約済みの音も声ごとの出口を絞ってまとめて消す */
  releaseSec: 0.03,
} as const;

/** 連打の間隔（秒）: 曲の BPM の16分音符（126 → 約119ms、150 → 100ms） */
export function holdStreamIntervalSec(bpm: number): number {
  const b = bpm > 0 ? bpm : 120;
  return 60 / b / 4;
}

// ---- 合成ブリップ（フォールバックと小さな効果音） ----

/**
 * 合成ヒット音（フォールバック用）。サンプル音源が読み込めなかったときに使う、
 * 矩形波の2音「ピロッ」（1568Hz → 2093Hz、指数減衰、頭に小さなクリック）。
 * 判定別: PERFECT は明るく長め / GREAT は少し短く / GOOD は1音目だけ低めで短く鈍く。
 * tier ではピッチが +1 半音/tier（上限 +4）上がる（logic.ts の hitPitchMultiplier）。
 */
export const HIT_BLIP: Record<HitJudge, BlipToneParams> = {
  perfect: { freq1: 1568, freq2: 2093, freq3: 0, dur1: 0.032, dur2: 0.05, dur3: 0, decaySec: 0.03, peak: 0.22, clickPeak: 0.06, clickSec: 0.005 },
  great: { freq1: 1568, freq2: 2093, freq3: 0, dur1: 0.028, dur2: 0.04, dur3: 0, decaySec: 0.024, peak: 0.17, clickPeak: 0.05, clickSec: 0.005 },
  good: { freq1: 1397, freq2: 0, freq3: 0, dur1: 0.03, dur2: 0, dur3: 0, decaySec: 0.02, peak: 0.12, clickPeak: 0.03, clickSec: 0.004 },
};

/** 長押し中の連打の合成音（フォールバック用）。通常ヒットより小さく・短いブリップ */
export const HOLD_BLIP: BlipToneParams = {
  freq1: 1568,
  freq2: 2093,
  freq3: 0,
  dur1: 0.02,
  dur2: 0.03,
  dur3: 0,
  decaySec: 0.018,
  peak: 0.11,
  clickPeak: 0.03,
  clickSec: 0.004,
};

/** 判定と tier から、合成ヒット音のパラメータと各音の周波数を決める */
export function hitToneFor(
  judge: HitJudge,
  tier: number,
): { tone: BlipToneParams; freq1: number; freq2: number } {
  const tone = HIT_BLIP[judge];
  const mul = hitPitchMultiplier(tier);
  return { tone, freq1: tone.freq1 * mul, freq2: tone.freq2 * mul };
}

/** 連打の合成音の周波数。tier のピッチに、進行で最大 +2 半音まで上乗せする */
export function holdToneFor(tier: number, progress: number): { freq1: number; freq2: number } {
  const p = Math.min(1, Math.max(0, progress));
  const mul = hitPitchMultiplier(tier) * Math.pow(2, (2 * p) / 12);
  return { freq1: HOLD_BLIP.freq1 * mul, freq2: HOLD_BLIP.freq2 * mul };
}

/**
 * 空タップ音。ノーツのないレーンを押したときに鳴らし、「タッチすれば何か鳴る」状態にする。
 * ヒット音と聞き分けられるよう、合成ブリップで1音だけ・低め（1046Hz）・短い・小さめにする。
 */
export const EMPTY_BLIP: BlipToneParams = {
  freq1: 1046,
  freq2: 0,
  freq3: 0,
  dur1: 0.03,
  dur2: 0,
  dur3: 0,
  decaySec: 0.015,
  peak: 0.08,
  clickPeak: 0.03,
  clickSec: 0.004,
};

/**
 * 長押しの完走音。2音ブリップにもう1音（1オクターブ上）を足した3音で達成感を出す。
 * 頭の判定で音色を変え、ピークは通常ヒット音以下に抑える（他のヒット音と重なっても破綻しない）。
 * GOOD は2音目がない代わりに、1音目→オクターブ上の2音にする。
 */
export const COMPLETE_BLIP: Record<HitJudge, BlipToneParams> = {
  perfect: { freq1: 1568, freq2: 2093, freq3: 3136, dur1: 0.03, dur2: 0.04, dur3: 0.08, decaySec: 0.04, peak: 0.2, clickPeak: 0.08, clickSec: 0.006 },
  great: { freq1: 1568, freq2: 2093, freq3: 3136, dur1: 0.028, dur2: 0.036, dur3: 0.06, decaySec: 0.03, peak: 0.16, clickPeak: 0.06, clickSec: 0.006 },
  good: { freq1: 1397, freq2: 0, freq3: 2794, dur1: 0.026, dur2: 0, dur3: 0.05, decaySec: 0.024, peak: 0.12, clickPeak: 0.04, clickSec: 0.005 },
};

/** 長押しの失敗音。短く下がる小さな2音で「切れた」ことを耳でも知らせる */
export const FAIL_BLIP: BlipToneParams = {
  freq1: 784,
  freq2: 523,
  freq3: 0,
  dur1: 0.05,
  dur2: 0.08,
  dur3: 0,
  decaySec: 0.03,
  peak: 0.08,
  clickPeak: 0,
  clickSec: 0,
};

/**
 * 判定と tier から、サンプルの鳴らし方を決める。
 * tier の変化はピッチではなく明るさ（ローパス）で付ける（音量と長さは判定だけで決まる）。
 */
export function sampleToneFor(judge: HitJudge, tier: number): SampleToneParams {
  const base = SAMPLE_HIT[judge];
  return { peak: base.peak, durSec: base.durSec, lowpassHz: base.lowpassHz * tierBrightness(tier) };
}

/** 完走音のパラメータと各音の周波数（ピッチはヒット音と同じ規則で tier 連動） */
export function completeToneFor(
  judge: HitJudge,
  tier: number,
): { tone: BlipToneParams; freq1: number; freq2: number; freq3: number } {
  const tone = COMPLETE_BLIP[judge];
  const mul = hitPitchMultiplier(tier);
  return { tone, freq1: tone.freq1 * mul, freq2: tone.freq2 * mul, freq3: tone.freq3 * mul };
}

/**
 * 連打の1発の鳴らし方。tier で明るくなる（ヒット音と同じ規則）に加えて、
 * ホールドの進行（progress: 0=頭、1=尾）で明るさが HOLD_SAMPLE_RISE 倍まで上がる
 * （ピッチは変えない）。
 * 押し直しで再開するときは、経過分の progress から始めるので上がり具合を引き継げる。
 */
export function holdSampleFor(tier: number, progress: number): SampleToneParams {
  const p = Math.min(1, Math.max(0, progress));
  const bright = tierBrightness(tier) * (1 + (HOLD_SAMPLE_RISE - 1) * p);
  return { peak: SAMPLE_HOLD.peak, durSec: SAMPLE_HOLD.durSec, lowpassHz: SAMPLE_HOLD.lowpassHz * bright };
}

let enabled = load('sound', true);

export const isSoundOn = (): boolean => enabled;

export function setSound(on: boolean): void {
  enabled = on;
  save('sound', on);
  // オフにしたら、鳴っている長押しの連打も止める
  if (!on) stopAllHoldSounds();
}

// ヒット音専用の出口（ゲイン → コンプレッサー → マスター）。
// 密集したノーツで音が重なってもクリップしにくくする。曲の経路には影響しない。
// AudioContext が作り直されたら（世代が変わったら）バスも作り直す
let bus: AudioNode | undefined;
let busGeneration = -1;

function hitBus(): AudioNode {
  const ac = audioContext();
  if (!bus || busGeneration !== audioGeneration()) {
    busGeneration = audioGeneration();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 18;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    const gain = ac.createGain();
    gain.gain.value = 0.9;
    gain.connect(comp).connect(audioOutput());
    bus = gain;
  }
  return bus;
}

// 頭のクリック用の短いノイズは使い回す（ヒットのたびに作り直さない）。減衰はゲイン側で付ける
let noiseBuffer: AudioBuffer | undefined;

function getNoiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ac.sampleRate) return noiseBuffer;
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.05));
  noiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

/** ブリップを1つ合成して鳴らす（矩形波の1〜3音＋頭のクリック） */
function playBlip(tone: BlipToneParams, freq1: number, freq2: number, freq3 = 0): void {
  playBlipAt(tone, freq1, freq2, freq3, audioContext().currentTime, hitBus());
}

/** ブリップを、指定した AudioContext 時刻・出口で鳴らす（長押しの連打の先行スケジュール用） */
function playBlipAt(tone: BlipToneParams, freq1: number, freq2: number, freq3: number, t: number, out: AudioNode): void {
  const ac = audioContext();
  // 鳴らす音の並び（周波数 0 の音は飛ばし、詰めてつなぐ）
  const segs: { f: number; d: number }[] = [{ f: freq1, d: tone.dur1 }];
  if (freq2 > 0) segs.push({ f: freq2, d: tone.dur2 });
  if (freq3 > 0) segs.push({ f: freq3, d: tone.dur3 });
  const total = segs.reduce((s, x) => s + x.d, 0);

  const osc = ac.createOscillator();
  osc.type = 'square';
  let at = t;
  for (const s of segs) {
    osc.frequency.setValueAtTime(s.f, at);
    at += s.d;
  }
  const oscGain = ac.createGain();
  oscGain.gain.setValueAtTime(tone.peak, t);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, t + total + tone.decaySec);
  osc.connect(oscGain).connect(out);
  osc.start(t);
  osc.stop(t + total + tone.decaySec + 0.02);

  // 頭のクリック: ハイパスした短いノイズで打撃感を出す
  if (tone.clickPeak > 0) {
    const noise = ac.createBufferSource();
    noise.buffer = getNoiseBuffer(ac);
    const high = ac.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 3200;
    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(tone.clickPeak, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + tone.clickSec);
    noise.connect(high).connect(noiseGain).connect(out);
    noise.start(t);
    noise.stop(t + tone.clickSec + 0.02);
  }
}

// ---- サンプル素材（音声ファイル）の読み込みと再生 ----
// 読み込んだバッファは保持する（loadBuffer が URL 単位で保持するが、
// 連打の先行スケジュールでは同期待ちなしに使いたいので、解決済みの参照も持つ）。
// 読み込みに失敗したら、合成ブリップのフォールバックに切り替える。
let sampleBuf: AudioBuffer | undefined;
let sampleState: 'loading' | 'ready' | 'failed' = 'loading';
let sampleLoading: Promise<AudioBuffer> | undefined;

function loadSample(): Promise<AudioBuffer> {
  if (!sampleLoading) {
    sampleLoading = loadBuffer(hitSampleUrl).then(
      (buf) => {
        sampleBuf = buf;
        sampleState = 'ready';
        return buf;
      },
      (err: unknown) => {
        sampleState = 'failed';
        throw err;
      },
    );
  }
  return sampleLoading;
}

/** 演奏開始のときにサンプル素材を先読みしておく（最初のヒットや連打で読み込み待ちにならないように） */
export function preloadHitSample(): void {
  void loadSample().catch(() => undefined);
}

/**
 * サンプルを1発、指定した AudioContext 時刻・出口で鳴らす。
 * ローパス（明るさ）→ ゲイン（音量）の順につなぐ。素材より短く切り取るときは、
 * 末尾 8ms のフェードで落としてクリック音を防ぐ。
 * バッファがまだ読み込めていない場合は、その1発だけ諦めて読み込みを始める
 * （演奏開始時に先読みするので、通常は起きない）。
 */
function playSample(tone: SampleToneParams, when: number, out: AudioNode): void {
  if (!sampleBuf) {
    void loadSample().catch(() => undefined);
    return;
  }
  const ac = audioContext();
  const src = ac.createBufferSource();
  src.buffer = sampleBuf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = tone.lowpassHz;
  lp.Q.value = 0.7;
  const gain = ac.createGain();
  const dur = Math.min(tone.durSec, sampleBuf.duration);
  gain.gain.setValueAtTime(tone.peak, when);
  if (dur < sampleBuf.duration - 0.004) {
    gain.gain.setValueAtTime(tone.peak, when + Math.max(0, dur - 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  }
  src.connect(lp).connect(gain).connect(out);
  src.start(when, 0, dur + 0.02);
}

/** ノーツに当たった瞬間のヒット音。tier が高いほど明るくなる（フォールバック時はピッチが上がる） */
export function playHitSound(judge: HitJudge, tier = 0): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    // iPhone では操作のあとに resume が必要
    void ac.resume();
    if (sampleState === 'failed') {
      const { tone, freq1, freq2 } = hitToneFor(judge, tier);
      playBlip(tone, freq1, freq2);
    } else {
      playSample(sampleToneFor(judge, tier), ac.currentTime, hitBus());
    }
    // テストが「どの音が鳴ったか」を確認できるようにイベントを出す
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'hit', judge, tier } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 長押しを押し切った瞬間の完走音。2音ブリップにもう1音足した3音で達成感を出す */
export function playCompleteSound(judge: HitJudge, tier = 0): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    void ac.resume();
    const { tone, freq1, freq2, freq3 } = completeToneFor(judge, tier);
    playBlip(tone, freq1, freq2, freq3);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'complete', judge, tier, frequency: freq1 } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 長押しが途中で切れた（猶予切れ）瞬間の失敗音。短く下がる小さな音 */
export function playFailSound(): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    void ac.resume();
    playBlip(FAIL_BLIP, FAIL_BLIP.freq1, FAIL_BLIP.freq2);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'fail', frequency: FAIL_BLIP.freq1 } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 遅延チェックの拍クリック。拍の瞬間がはっきり分かる、短く明るい1音 */
export const LATENCY_CLICK = { freq: 2000, durSec: 0.03, decaySec: 0.02, peak: 0.18 } as const;

/**
 * 遅延チェックの拍クリックを、指定した AudioContext 時刻に鳴らす。
 * 効果音のオン/オフ設定には従わない: 遅延チェックは「音に合わせてタップする」のが
 * 計測の前提で、鳴るのは利用者が計測のスタートを押したときだけだからである
 * （光だけでは、ゲームで実際に効く音の遅れを測れない）。
 * 拍の予定時刻は app:sound（kind: 'latency'、detail.at が AudioContext 時刻）でも出す。
 */
export function playLatencyClickAt(whenSec: number): void {
  try {
    const ac = audioContext();
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = LATENCY_CLICK.freq;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(LATENCY_CLICK.peak, whenSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, whenSec + LATENCY_CLICK.durSec + LATENCY_CLICK.decaySec);
    osc.connect(gain).connect(hitBus());
    osc.start(whenSec);
    osc.stop(whenSec + LATENCY_CLICK.durSec + LATENCY_CLICK.decaySec + 0.02);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'latency', at: whenSec } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/**
 * フルコンボ演出のボイス（「FULL COMBO!」の叫びなど、約1〜2秒の音声ファイル）。
 * URL は素材スロット（src/presentation.ts の FULLCOMBO_VOICE_URL）から渡す。
 * 未設定（undefined）なら何もしない（ボイスなしで演出が成立する）。
 * 合成音ではなく音声ファイルなのは、人の声は合成では作れないため。
 *
 * 効果音のオン/オフ設定には従わない: このボイスは効果音ではなく、演奏の締めの
 * 演出そのもの（曲と同じ立場）で、鳴るのはフルコンボを達成した演奏の最後だけだからである
 * （遅延チェックの拍クリックが設定に従わないのと同じ考え方）。
 * 曲の再生管理（audio.ts の current）は触らず、マスターへ直接つないで鳴らす
 * （演奏終了の時点では曲は止まっている）。
 */
export function preloadFullComboVoice(url?: string): void {
  if (!url) return;
  // 演奏開始のときに先読みしておく（締めで読み込み待ちにならないように）。
  // 失敗しても演出は続行する（playFullComboVoice 側でも読み直す）
  void loadBuffer(url).catch(() => undefined);
}

export async function playFullComboVoice(url?: string): Promise<void> {
  if (!url) return;
  try {
    const buf = await loadBuffer(url);
    const ac = audioContext();
    void ac.resume();
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(audioOutput());
    src.start();
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'fullcombo' } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/**
 * 結果発表ジングル（オーナー指示 2026-11-22 で、アプリ内合成からオーナー提供の
 * 音源ファイルへ差し替え）。素材は cyber_result_sleek_triumph_3sec.wav（3.0秒）を
 * MP3 192kbps に変換した src/game/assets/result-jingle.mp3 で、ビルドで dist に
 * 出力され Service Worker の precache に入る（workbox の globPatterns に mp3 あり）。
 * 旧・合成ファンファーレ（C メジャーの上行4音→終止和音、S ランクはきらめき追加）は
 * 素材に一本化して削除した（重ね掛けもしない）。
 *
 * 結果カードの表示タイミングは差し替え前と変えない: 演奏が終わったらジングルを
 * 鳴らし始め、resultJingleDurationMs の長さだけ待ってから結果カードが出る
 * （出す側の game-main.ts が、返ってきた長さだけ表示を遅らせる）。
 * 素材は 3.0 秒あるので、カードが出たあとも鳴り続ける（結果表示と合わせて鳴る形）。
 * 効果音のオン/オフ設定に従う: オフのときは鳴らさず、長さ 0 を返す（結果は即表示）。
 */

/** 結果カードを出すまでの待ち時間（ms）。S ランクだけ少し長い */
export const RESULT_JINGLE_WAIT_MS: Record<Rank, number> = {
  S: 1480,
  A: 1260,
  B: 1260,
  C: 1260,
};

/**
 * ジングルを鳴らしてから結果カードを出すまでの長さ（ms）。
 * 値は差し替え前の合成ジングルの長さ（最後の音が消える時刻＋80ms）をそのまま
 * 引き継いだもので、表示タイミングを変えないための定数。S ランクが長いのは、
 * 旧合成で「きらめき（高音2音）」が入って和音が遅れた名残（待ち時間の差だけ残した）。
 */
export function resultJingleDurationMs(rank: Rank): number {
  return RESULT_JINGLE_WAIT_MS[rank];
}

/** 演奏開始のときにジングル素材を先読みしておく（結果表示で読み込み待ちにならないように） */
export function preloadResultJingle(): void {
  void loadBuffer(resultJingleUrl).catch(() => undefined);
}

/**
 * 結果発表ジングル（素材ファイル）を鳴らし始めて、結果カードを出すまでの
 * 長さ（ms）を返す。効果音オフのときは鳴らさず 0 を返す（結果は即表示）。
 * 再生は効果音の出口（hitBus）経由で、曲の再生管理には触らない。
 * 素材の読み込み・デコードに失敗しても、表示の流れは止めない（待ち時間は返す）。
 */
export function playResultJingle(rank: Rank): number {
  if (!enabled) return 0;
  try {
    const ac = audioContext();
    void ac.resume();
    void loadBuffer(resultJingleUrl)
      .then((buf) => {
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(hitBus());
        src.start();
      })
      .catch(() => undefined);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'jingle', rank } }));
    return resultJingleDurationMs(rank);
  } catch {
    return 0;
  }
}

/**
 * ゲームオーバー音（オーナー提供 WAV「cyber_failed_hard_3sec.wav」3.0秒を
 * MP3 192kbps に変換した src/game/assets/game-over.mp3。2026-11-22 追加）。
 * 結果発表ジングルと同じ方式: ビルドで dist に出力され Service Worker の
 * precache に入り、演奏開始時に先読みし、ゲームオーバー確定時に鳴らし始める。
 * 結果カード（失敗表示）は、音の頭が聞き取れるだけ待ってから出す（出す側の
 * game-main.ts が、返ってきた長さだけ表示を遅らせる。素材は 3.0 秒あるので、
 * カードが出たあとも鳴り続ける）。
 * 効果音オフのときは鳴らさず、長さ 0 を返す（結果は即表示）。
 */

/** ゲームオーバー音を鳴らしてから結果カードを出すまでの長さ (ms) */
export const GAME_OVER_WAIT_MS = 1500;

/** 演奏開始のときにゲームオーバー素材を先読みしておく（確定の瞬間に鳴らし始めるため） */
export function preloadGameOverSound(): void {
  void loadBuffer(gameOverUrl).catch(() => undefined);
}

/**
 * ゲームオーバー音（素材ファイル）を鳴らし始めて、結果カードを出すまでの
 * 長さ（ms）を返す。効果音オフのときは鳴らさず 0 を返す（結果は即表示）。
 * 再生は効果音の出口（hitBus）経由で、曲の再生管理には触らない。
 * 素材の読み込み・デコードに失敗しても、表示の流れは止めない（待ち時間は返す）。
 */
export function playGameOverSound(): number {
  if (!enabled) return 0;
  try {
    const ac = audioContext();
    void ac.resume();
    void loadBuffer(gameOverUrl)
      .then((buf) => {
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(hitBus());
        src.start();
      })
      .catch(() => undefined);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'gameover' } }));
    return GAME_OVER_WAIT_MS;
  } catch {
    return 0;
  }
}

/**
 * 結果画面の達成ボイス（NK-S006 試作で追加し、テンプレート v1.8.0 で標準化）。
 * 「フルコンボ！」と「ハイスコア更新！」の2フレーズで、素材は Gemini TTS
 * （gemini-3.8-flash-tts、声 Leda）で生成した音声を MP3 192kbps 化し、
 * ジングルと同水準（約 −13 LUFS）にそろえた src/game/assets/voice-*.mp3 を
 * テンプレートの標準素材として同梱する（汎用フレーズなので作品ごとに
 * 差し替える必要はない。差し替える場合は同名ファイルを置き換える）。
 * ビルドで dist に出力され Service Worker の precache に入り、演奏開始時に
 * 先読みする。
 *
 * 鳴らすタイミング: 結果カードが出る瞬間（ジングルの頭の部分はカード表示の
 * 待ち時間で鳴り終わっている）。両方達成したときは、フルコンボ→
 * ハイスコア更新の順に、前のフレーズが終わってから次を続けて鳴らす。
 * 効果音のオン/オフ設定に従う（隣で鳴るジングルと同じ扱い。オフなら無音で、
 * 結果カードの印だけが出る）。ゲームオーバーの結果では鳴らさない。
 */

/** 結果ボイスの種類（結果カードの印と対応する） */
export type ResultVoice = 'fullcombo' | 'newrecord';

const RESULT_VOICE_URLS: Record<ResultVoice, string> = {
  fullcombo: voiceFullComboUrl,
  newrecord: voiceNewRecordUrl,
};

/** 続けて鳴らすときの、フレーズ間の間（秒） */
const RESULT_VOICE_GAP_SEC = 0.15;

/** 演奏開始のときに結果ボイス素材を先読みしておく（結果表示で読み込み待ちにならないように） */
export function preloadResultVoices(): void {
  for (const url of Object.values(RESULT_VOICE_URLS)) {
    void loadBuffer(url).catch(() => undefined);
  }
}

/**
 * 結果ボイスを、渡された順に続けて鳴らす。効果音オフのときは何もしない。
 * 素材の読み込み・デコードに失敗しても、結果表示の流れは止めない。
 * 鳴らし始めは app:sound（kind: 'voice-fullcombo' / 'voice-newrecord'）でも出す。
 */
export function playResultVoices(voices: ResultVoice[]): void {
  if (!enabled || voices.length === 0) return;
  try {
    const ac = audioContext();
    void ac.resume();
    void (async () => {
      let at = ac.currentTime;
      for (const voice of voices) {
        const buf = await loadBuffer(RESULT_VOICE_URLS[voice]).catch(() => undefined);
        if (!buf) continue;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(hitBus());
        src.start(Math.max(at, ac.currentTime));
        document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: `voice-${voice}` } }));
        at = Math.max(at, ac.currentTime) + buf.duration + RESULT_VOICE_GAP_SEC;
      }
    })();
  } catch {
    // 音が出せなくても続行する
  }
}

/** 選択を変えたときの確認音（曲・難易度・設定の切替など）。空タップ音より少し高く、短く小さく鳴らす */
export const UI_CLICK: BlipToneParams = {
  freq1: 1568,
  freq2: 0,
  freq3: 0,
  dur1: 0.035,
  dur2: 0,
  dur3: 0,
  decaySec: 0.02,
  peak: 0.1,
  clickPeak: 0.04,
  clickSec: 0.004,
};

export function playUiClick(): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    void ac.resume();
    playBlip(UI_CLICK, UI_CLICK.freq1, UI_CLICK.freq2);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'ui', frequency: UI_CLICK.freq1 } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/**
 * 曲変更の音（オーナー指示 2026-11-20: 曲変更はクリックではなくスワイプ音に統一。
 * スワイプでもタップでも同じ音。難易度・設定の変更は playUiClick のまま）。
 * バンドパスの中心周波数を上へ掃引するノイズで「シュッ」という短い音にする
 */
export function playSwipeSound(): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    void ac.resume();
    const t = ac.currentTime;
    const dur = 0.16;
    const noise = ac.createBufferSource();
    noise.buffer = getNoiseBuffer(ac);
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    band.frequency.setValueAtTime(700, t);
    band.frequency.exponentialRampToValueAtTime(2600, t + dur);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise.connect(band).connect(gain).connect(hitBus());
    noise.start(t);
    noise.stop(t + dur + 0.02);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'swipe' } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/**
 * フリックノーツ専用のヒット音は「サンプル音源方式」（v1.4.5 で合成から切り替え）。
 * 経緯: v1.4.1 で合成（上昇スイープ＋グリッサンド＋きらめき）、v1.4.3 で合成の
 * 「シャキーン」に作り替えたが、オーナー評価が「しっくりこない」だった。
 * そのため試聴プレビューで方向性（H: ヒュッ＋キラッ）を絞り、バリエーション
 * 5案（H2〜H6）からオーナーが選んだ H2（ウッシュ強め＋チャイム1音）を、
 * コード合成で寄せるのではなく、選ばれた音源そのものを素材として取り込んだ
 * （オーナーに「聞いたそのままの音で入れる」と伝えてある）。
 * 素材は src/game/assets/flick-sample.wav（0.35秒・44.1kHz・モノラル、ピーク 0.7）。
 * MP3 化するとエンコーダ遅延でアタックがずれうるため、ヒット音サンプルと
 * 同じく WAV のまま取り込む（ビルドで dist に出力され、Service Worker の
 * precache に入る。workbox の globPatterns に wav あり）。
 *
 * 判定・tier のピッチ変化は、サンプルの playbackRate で付ける（合成時代の
 * flickToneFor は削除した）。PERFECT が素材そのままの音（レート 1）に
 * 一番近くなるよう、GREAT は −1 半音、GOOD は −2 半音を基準にし、
 * tier では hitPitchMultiplier（+1 半音/tier、上限 +4）の規則を重ねる。
 * 音量は、素材ピーク 0.7 に対するゲインで、ヒット音サンプルの出力ピーク
 * （素材ピーク 0.9 × 0.5/0.42/0.32 ≒ 0.45/0.38/0.29）とほぼ揃う値にした。
 */

/** フリック素材の長さ（秒） */
export const FLICK_SAMPLE_DURATION_SEC = 0.35;

/** フリック素材1発の鳴らし方（判定・tier から決まる） */
export interface FlickSampleToneParams {
  /** 再生レート（ピッチ）。1 で素材そのままの音 */
  rate: number;
  /** 音量（素材のピーク 0.7 に対する再生ゲイン） */
  peak: number;
}

/** 判定ごとのフリック素材の鳴らし方。PERFECT は素材そのまま、GOOD は低く・小さく */
export const FLICK_SAMPLE: Record<HitJudge, FlickSampleToneParams> = {
  perfect: { rate: 1, peak: 0.65 },
  great: { rate: Math.pow(2, -1 / 12), peak: 0.55 },
  good: { rate: Math.pow(2, -2 / 12), peak: 0.42 },
};

/**
 * 判定と tier から、フリック素材の鳴らし方を決める。tier ではピッチが
 * hitPitchMultiplier の規則どおり上がる（音量は変えない）。
 */
export function flickSampleToneFor(judge: HitJudge, tier: number): FlickSampleToneParams {
  const base = FLICK_SAMPLE[judge];
  return { rate: base.rate * hitPitchMultiplier(tier), peak: base.peak };
}

// フリック素材の読み込み（ヒット音サンプルと同じ保持の仕方）。
// 読み込みに失敗したらフリック音だけ無音にする（フォールバックの合成音は持たない:
// オーナーが選んだ音そのものが素材なので、別の音で代替しない）。
let flickBuf: AudioBuffer | undefined;
let flickState: 'loading' | 'ready' | 'failed' = 'loading';
let flickLoading: Promise<AudioBuffer> | undefined;

function loadFlickSample(): Promise<AudioBuffer> {
  if (!flickLoading) {
    flickLoading = loadBuffer(flickSampleUrl).then(
      (buf) => {
        flickBuf = buf;
        flickState = 'ready';
        return buf;
      },
      (err: unknown) => {
        flickState = 'failed';
        throw err;
      },
    );
  }
  return flickLoading;
}

/** 演奏開始のときにフリック素材を先読みしておく（最初のフリックで読み込み待ちにならないように） */
export function preloadFlickSample(): void {
  void loadFlickSample().catch(() => undefined);
}

/**
 * フリック素材を1発、指定した AudioContext 時刻・出口で鳴らす。
 * レートでピッチ（と長さ）が変わる以外は素材そのまま（フィルタはかけない）。
 * バッファがまだ読み込めていない場合は、その1発だけ諦めて読み込みを始める
 * （演奏開始時に先読みするので、通常は起きない）。
 */
function playFlickSample(tone: FlickSampleToneParams, when: number, out: AudioNode): void {
  if (!flickBuf) {
    void loadFlickSample().catch(() => undefined);
    return;
  }
  const ac = audioContext();
  const src = ac.createBufferSource();
  src.buffer = flickBuf;
  src.playbackRate.value = tone.rate;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(tone.peak, when);
  src.connect(gain).connect(out);
  src.start(when);
}

/**
 * フリックノーツに当たった瞬間の専用音。通常ヒット音の代わりに鳴らす
 * （通常ノーツをフリックで叩いたときは従来の playHitSound のまま）。
 * 鳴らし方は flickSampleToneFor のパラメータどおり（素材＋レート＋音量）。
 */
export function playFlickSound(judge: HitJudge, tier = 0): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    // iPhone では操作のあとに resume が必要
    void ac.resume();
    if (flickState !== 'failed') {
      playFlickSample(flickSampleToneFor(judge, tier), ac.currentTime, hitBus());
    }
    // テストが「どの音が鳴ったか」を確認できるようにイベントを出す
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'flick', judge, tier } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/**
 * ミス音のパラメータ（v1.4.3 で新設。オーナーが試聴3案から G 案「ポッ」を選択）。
 * それまで MISS 判定は無音だった。丸く柔らかい短い下降サイン音で、
 * 音量はヒット音（サンプル peak 0.5/0.42/0.32）より小さく、
 * 連発しても耳障りにならない控えめな値にする。
 */
export interface MissToneParams {
  /** 下降の開始周波数 (Hz) */
  fromHz: number;
  /** 下降の終了周波数 (Hz) */
  toHz: number;
  /** 減衰の時定数 (秒) */
  tauSec: number;
  /** 立ち上がりの長さ (秒)。短いが、指数ランプで柔らかく立ち上げる */
  attackSec: number;
  /** 音量 */
  peak: number;
}

export const MISS_TONE: MissToneParams = {
  fromHz: 320,
  toHz: 180,
  tauSec: 0.055,
  attackSec: 0.012,
  peak: 0.14,
};

/** ミス音のパラメータを返す（判定や tier では変えない） */
export function missToneFor(): MissToneParams {
  return MISS_TONE;
}

/** ミス音の最小発音間隔 (ms)。密集地帯でミスが連続したときに重なりすぎないための抑制 */
export const MISS_MIN_INTERVAL_MS = 60;

/** 前回鳴らした時刻から見て、次に鳴らしてよいか（playMissSound の抑制判定） */
export function missSoundDue(lastPlayedAtMs: number, nowMs: number): boolean {
  return nowMs - lastPlayedAtMs >= MISS_MIN_INTERVAL_MS;
}

let lastMissPlayedAtMs = Number.NEGATIVE_INFINITY;

/**
 * ノーツを取り逃がした（MISS）瞬間の専用音。鳴らす経路は game.ts の
 * MISS 確定箇所（ノーツ通過の掃除と長押しの失敗）から呼ばれる。
 * 短時間にミスが連続する場面では MISS_MIN_INTERVAL_MS 未満の間隔の発音を抑える。
 */
export function playMissSound(): void {
  if (!enabled) return;
  const nowMs = performance.now();
  if (!missSoundDue(lastMissPlayedAtMs, nowMs)) return;
  lastMissPlayedAtMs = nowMs;
  try {
    const ac = audioContext();
    void ac.resume();
    const tone = missToneFor();
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(tone.fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(tone.toHz, t + tone.tauSec * 2);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(tone.peak, t + tone.attackSec);
    gain.gain.setTargetAtTime(0, t + tone.attackSec, tone.tauSec);
    osc.connect(gain).connect(hitBus());
    osc.start(t);
    osc.stop(t + tone.attackSec + tone.tauSec * 8 + 0.05);
    // テストが「どの音が鳴ったか」を確認できるようにイベントを出す
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'miss' } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 空タップ音。ノーツのないレーンを押したときに鳴らす（ヒット音とは別の小さな音） */
export function playEmptySound(): void {
  if (!enabled) return;
  try {
    const ac = audioContext();
    void ac.resume();
    playBlip(EMPTY_BLIP, EMPTY_BLIP.freq1, EMPTY_BLIP.freq2);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'empty', frequency: EMPTY_BLIP.freq1 } }));
  } catch {
    // 音が出せなくても続行する
  }
}

// ---- 長押し中の連打。同時保持があり得るので、ホールドごとに独立した声を持ち、上限を設ける ----
// 連打は AudioContext 時刻で先行スケジュールする（lookahead 方式）。フレーム落ちや
// タイマーの揺れで間隔が潰れず、16分音符の間隔を保てる。各声は専用の出口（ゲイン）を持ち、
// 止めるときはその出口を絞ることで、予約済みの音もまとめて消える。

interface HoldStreamVoice {
  /** この声専用の出口（ゲイン）。予約済みの音もここを通る */
  out: GainNode;
  /** スケジューラのタイマー（声を作った直後にセットする） */
  timer: ReturnType<typeof setInterval> | undefined;
  /** 連打を始めた AudioContext 時刻 */
  startAt: number;
  /** 次に予約する1発の AudioContext 時刻 */
  nextAt: number;
  /** 尾の AudioContext 時刻（これ以降の1発は予約しない） */
  endAt: number;
  /** 開始時点のホールド進行（0=頭、1=尾）。押し直し再開時に経過分を引き継ぐ */
  progress0: number;
  /** 開始から尾までの残り時間（秒）。進行の計算に使う */
  durationSec: number;
  /** 開始時点のコンボ tier（明るさに使う） */
  tier: number;
  /** 連打の間隔（秒） */
  intervalSec: number;
}

/** 鳴っている連打。キーはホールドを識別するオブジェクト（game.ts はノーツ自身を渡す） */
const holdVoices = new Map<object, HoldStreamVoice>();

/**
 * 長押し中の連打を鳴らし始める。頭のヒットと同時に呼ぶ。
 * durationMs は尾までの残り時間、progress は開始時点の進行（0=頭、1=尾）、
 * bpm は曲の BPM（連打の間隔＝16分音符を決める）。
 */
export function startHoldSound(key: object, tier: number, durationMs: number, progress = 0, bpm = 120): void {
  if (!enabled) return;
  try {
    stopHoldSound(key);
    // 上限を超えたら古いものから止める
    while (holdVoices.size >= HOLD_STREAM.maxVoices) {
      const oldest = holdVoices.keys().next().value;
      if (oldest === undefined) break;
      stopHoldSound(oldest);
    }
    const ac = audioContext();
    void ac.resume();
    const out = ac.createGain();
    out.gain.value = 1;
    out.connect(hitBus());
    const now = ac.currentTime;
    const durationSec = Math.max(0.05, durationMs / 1000);
    const voice: HoldStreamVoice = {
      out,
      timer: undefined,
      startAt: now,
      nextAt: now,
      endAt: now + durationSec,
      progress0: Math.min(1, Math.max(0, progress)),
      durationSec,
      tier,
      intervalSec: holdStreamIntervalSec(bpm),
    };
    const schedule = (): void => {
      try {
        const ahead = ac.currentTime + HOLD_STREAM.lookaheadSec;
        while (voice.nextAt < voice.endAt && voice.nextAt < ahead) {
          const elapsed = voice.nextAt - voice.startAt;
          const prog = voice.progress0 + (1 - voice.progress0) * Math.min(1, elapsed / voice.durationSec);
          if (sampleState === 'failed') {
            const { freq1, freq2 } = holdToneFor(voice.tier, prog);
            playBlipAt(HOLD_BLIP, freq1, freq2, 0, voice.nextAt, voice.out);
          } else {
            playSample(holdSampleFor(voice.tier, prog), voice.nextAt, voice.out);
          }
          document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'hold-hit', tier: voice.tier } }));
          voice.nextAt += voice.intervalSec;
        }
        // 安全弁: 通常は尾の時刻に stopHoldSound で止めるが、止め忘れても鳴りっぱなしにしない
        if (ac.currentTime > voice.endAt + HOLD_STREAM.safetySec) stopHoldSound(key);
      } catch {
        // 音が出せなくても続行する
      }
    };
    voice.timer = setInterval(schedule, HOLD_STREAM.timerMs);
    holdVoices.set(key, voice);
    schedule(); // 最初の1発は即座に予約する
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'hold-start', tier } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 長押し中の連打を止める（離した・完走した・失敗した・演奏を止めたとき） */
export function stopHoldSound(key: object): void {
  const v = holdVoices.get(key);
  if (!v) return;
  holdVoices.delete(key);
  clearInterval(v.timer);
  try {
    const ac = audioContext();
    const t = ac.currentTime;
    // 声の出口を絞れば、先行スケジュール済みの音もまとめて消える
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(Math.max(0.0001, v.out.gain.value), t);
    v.out.gain.exponentialRampToValueAtTime(0.0001, t + HOLD_STREAM.releaseSec);
    window.setTimeout(() => {
      try {
        v.out.disconnect();
      } catch {
        // 切断済みなら何もしない
      }
    }, 100);
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'hold-stop' } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/** 鳴っている連打をすべて止める（演奏終了・中止・効果音オフのとき） */
export function stopAllHoldSounds(): void {
  for (const key of [...holdVoices.keys()]) stopHoldSound(key);
}
