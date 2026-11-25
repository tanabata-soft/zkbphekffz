// 遅延チェックの計測の進行（拍のスケジュール、タップの収集、結果の計算）。
// 拍は AudioContext の時刻基準で先行スケジュールする（setInterval の壁時計では測らない）。
// 計算（ズレ・平均・標準偏差）は logic.ts の純関数に寄せ、ここは時刻と状態だけを持つ。
import { audioContext } from './audio';
import {
  LATENCY_TAP_COUNT,
  filterTapTimes,
  latencyDeltas,
  latencyIntervalMs,
  latencyStats,
  type LatencyStats,
} from './logic';
import { playLatencyClickAt } from './sound';

export interface LatencyCallbacks {
  /** 拍の瞬間に呼ばれる（画面のフラッシュ用）。引数は拍の番号（0始まり） */
  onBeat: (beatIndex: number) => void;
  /** 受け付けたタップ数が変わったときに呼ばれる */
  onProgress: (taps: number, needed: number) => void;
  /** 必要なタップ数が集まって計測が終わったときに呼ばれる */
  onFinish: (stats: LatencyStats) => void;
}

/** スタートを押してから最初の拍までの待ち時間（秒）。心の準備の時間 */
const LEAD_IN_SEC = 1.0;
/** 先行スケジュールの幅（秒）。長押しの連打と同じ方式で、タイマーの揺れで拍が潰れないようにする */
const LOOKAHEAD_SEC = 0.12;
/** スケジューラの確認間隔 (ms) */
const TIMER_MS = 25;

export class LatencyCheck {
  private timer: ReturnType<typeof setInterval> | undefined;
  private raf = 0;
  /** 最初の拍の AudioContext 時刻（秒） */
  private startAtSec = 0;
  /** 次に予約する拍の番号 */
  private nextBeat = 0;
  /** 予約済みの拍の AudioContext 時刻（秒） */
  private beatsSec: number[] = [];
  /** フラッシュ済みの拍の数 */
  private flashedBeats = 0;
  /** 受け付けたタップの生の時刻（AudioContext 時刻の ms） */
  private rawTapsMs: number[] = [];
  private running = false;

  constructor(private readonly cb: LatencyCallbacks) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** 計測を始める。すでに計測中なら、最初からやり直す */
  start(): void {
    this.stop();
    const ac = audioContext();
    void ac.resume().catch(() => undefined);
    this.startAtSec = ac.currentTime + LEAD_IN_SEC;
    this.nextBeat = 0;
    this.beatsSec = [];
    this.flashedBeats = 0;
    this.rawTapsMs = [];
    this.running = true;
    const intervalSec = latencyIntervalMs() / 1000;
    const schedule = (): void => {
      const ahead = ac.currentTime + LOOKAHEAD_SEC;
      for (;;) {
        const t = this.startAtSec + this.nextBeat * intervalSec;
        if (t > ahead) break;
        this.beatsSec.push(t);
        playLatencyClickAt(t);
        this.nextBeat++;
      }
    };
    schedule();
    this.timer = setInterval(schedule, TIMER_MS);
    // フラッシュは拍の AudioContext 時刻に合わせて出す（描画フレームごとに確認する）
    const flashLoop = (): void => {
      if (!this.running) return;
      const now = ac.currentTime;
      while (this.flashedBeats < this.beatsSec.length && this.beatsSec[this.flashedBeats] <= now) {
        this.cb.onBeat(this.flashedBeats);
        this.flashedBeats++;
      }
      this.raf = requestAnimationFrame(flashLoop);
    };
    this.raf = requestAnimationFrame(flashLoop);
    this.cb.onProgress(0, LATENCY_TAP_COUNT);
  }

  /** タップを1回受け付ける。計測中でなければ何もしない */
  tap(): void {
    if (!this.running) return;
    this.rawTapsMs.push(audioContext().currentTime * 1000);
    const taps = filterTapTimes(this.rawTapsMs);
    this.cb.onProgress(taps.length, LATENCY_TAP_COUNT);
    if (taps.length < LATENCY_TAP_COUNT) return;
    const stats = latencyStats(latencyDeltas(taps, this.startAtSec * 1000, latencyIntervalMs()));
    this.stop();
    if (stats) this.cb.onFinish(stats);
  }

  /** 計測を止める（結果は出さない）。閉じる・やめるときに呼ぶ */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    cancelAnimationFrame(this.raf);
  }
}
