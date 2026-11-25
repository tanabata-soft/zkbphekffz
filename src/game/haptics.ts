// ヒット時の振動（navigator.vibrate）。対応していない環境（iPhone Safari など）では何もしない。
// オン/オフ設定は効果音と同じ作法で storage に保存する。
import { load, save } from './storage';
import type { Judge } from './logic';

export type HitJudge = Exclude<Judge, 'miss'>;

/** 判定ごとの振動の長さ (ms)。PERFECT をいちばん長く、はっきりさせる */
export const HIT_VIBRATE_MS: Record<HitJudge, number> = { perfect: 15, great: 10, good: 8 };

let enabled = load('vibrate', true);

export const isVibrateOn = (): boolean => enabled;

export function setVibrate(on: boolean): void {
  enabled = on;
  save('vibrate', on);
}

/** ヒットした瞬間に短く振動させる。非対応環境・オフのときは何もしない。 */
export function vibrateHit(judge: HitJudge): void {
  if (!enabled) return;
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(HIT_VIBRATE_MS[judge]);
    // テストが「どの振動が起きたか」を確認できるようにイベントを出す
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('app:vibrate', { detail: { judge, ms: HIT_VIBRATE_MS[judge] } }));
    }
  } catch {
    // 振動できなくても続行する
  }
}
