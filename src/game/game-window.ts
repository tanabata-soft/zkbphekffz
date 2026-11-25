// 再生位置ウィンドウ（単位F）。譜面は時刻昇順である前提で、今の再生位置の
// 周りだけを描画・掃除の対象にするための範囲計算をここに置く。
// 毎フレーム全譜面（最大 ~900 ノーツ）を舐めていた箇所を、この範囲に
// 限定することで走査量を可視範囲＋余裕の分だけにする。
//
// ホールド（長押し）の尾の見切れ対策が要点:
// - 過去側の余裕には「譜面中の最大ホールド長」を必ず加える。頭がウィンドウ
//   の外（過去）でも、尾が表示範囲内にあるホールドは start 側に含まれる。
//   判定は timeMs ではなく timeMs + holdMs（尾の時刻）でも行い、尾が
//   画面下端を過ぎるまでは範囲から外れないことを保証する。
// - 未来側の余裕は落下時間の 2 倍 + 1 秒。頭の位置が画面上端より上に
//   あるノーツ（フリック矢印の余白込み）でも範囲に入る。
import { JUDGE_WINDOWS, type PlayNote } from './logic';

/** ウィンドウの範囲（notes の添字。end は含まない） */
export interface NoteWindow {
  start: number;
  end: number;
}

/** notes が時刻昇順か（ウィンドウ化の前提。崩れていたら全走査へ戻す） */
export function isSortedByTime(notes: readonly PlayNote[]): boolean {
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].timeMs < notes[i - 1].timeMs) return false;
  }
  return true;
}

/** 譜面中の最大ホールド長 (ms) */
export function maxHoldMsOf(notes: readonly PlayNote[]): number {
  let max = 0;
  for (const n of notes) if (n.holdMs > max) max = n.holdMs;
  return max;
}

/** timeMs が ms 以上になる最初の添字（二分探索） */
export function lowerBoundTime(notes: readonly PlayNote[], ms: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].timeMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** timeMs が ms より大きくなる最初の添字（二分探索） */
export function upperBoundTime(notes: readonly PlayNote[], ms: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].timeMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 描画・掃除用のウィンドウ。今の位置 nowMs を中心に、過去側は
 * 「落下時間×2 + 1秒 + 最大ホールド長」、未来側は「落下時間×2 + 1秒」。
 * 過去側の境界は頭の時刻ではなく尾の時刻（timeMs + holdMs）で決める:
 * start は「尾の時刻が境界より前になる最後のノーツ」の次から始める。
 * 尾ベースの境界は単調ではない（ホールド長がバラバラ）ため、頭ベースの
 * 二分探索で大まかに絞ってから、境界付近だけを後ろへ広げて取りこぼしを防ぐ。
 */
export function noteWindow(
  notes: readonly PlayNote[],
  nowMs: number,
  fallMs: number,
  maxHoldMs: number,
): NoteWindow {
  const pastMs = fallMs * 2 + 1000;
  const futureMs = fallMs * 2 + 1000;
  // 未来側: 頭が未来境界より先のノーツは画面に出ない
  const end = upperBoundTime(notes, nowMs + futureMs);
  // 過去側: 頭が「境界 − 最大ホールド長」より前なら、尾も必ず境界より前
  // （尾 = 頭 + holdMs ≤ 頭 + maxHoldMs < 境界）。そこを二分探索の下限にし、
  // そこから先は尾の時刻で1つずつ確認して、尾がまだ境界内にある最初の
  // ノーツまで start を進める。長いホールドが短いノーツの後ろに隠れて
  // いても、maxHoldMs の範囲内は全て確認するので取りこぼさない。
  let start = lowerBoundTime(notes, nowMs - pastMs - maxHoldMs);
  const tailBound = nowMs - pastMs;
  while (start < end) {
    const n = notes[start];
    if (n.timeMs + n.holdMs >= tailBound) break;
    // このノーツより後ろに、尾が境界内にある長いホールドが残っている
    // 可能性があるのは、頭が tailBound - maxHoldMs 以降の範囲だけ。
    // start のノーツ自身の尾は境界外でも、後続の長いホールドが境界内に
    // 届くことがあるため、頭がその範囲に入る間は start を進めない。
    if (n.timeMs >= tailBound - maxHoldMs) break;
    start++;
  }
  return { start, end };
}

/**
 * 判定探し（findHit 等）用の狭いウィンドウ。判定窓（good）より少しだけ
 * 広げ、該当レーンの候補が必ず含まれる範囲を返す。呼び出し側は
 * notes.slice(win.start, win.end) を既存の純関数へ渡す。
 */
export function judgeWindow(notes: readonly PlayNote[], nowMs: number): NoteWindow {
  const margin = JUDGE_WINDOWS.good + 1;
  return {
    start: lowerBoundTime(notes, nowMs - margin),
    end: upperBoundTime(notes, nowMs + margin),
  };
}
