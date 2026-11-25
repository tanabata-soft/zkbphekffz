// ゲームのルール・計算は DOM に触れない純関数にして、tests/ で単体テストする。
// 基本仕様:
//   判定 PERFECT ±50ms / GREAT ±100ms / GOOD ±160ms、スコア 1000/700/400（倍率なし）
//   精度 = (PERFECT + GREAT×0.7 + GOOD×0.4) / 全ノーツ ×100、ランク S≥95 / A≥85 / B≥70 / C

/** 曲の ID（src/charts.ts の SONGS の id と対応する文字列。曲を足すときはここは変えない） */
export type SongId = string;
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Judge = 'perfect' | 'great' | 'good' | 'miss';

/**
 * ノーツの種別。'flick' はフリックノーツ（ポインタのタップでは取れず、上フリック必須。
 * キーボードだけは例外で、通常のキー押しでそのまま取れる）
 */
export type NoteKind = 'flick';

/**
 * 譜面のノーツ。[時刻(ms), レーン(0-3), 長押し(ms)?, 種別?]
 * 3要素目があるノーツは長押し（ホールド）で、頭からその時間だけ押し続ける。
 * 4要素目が 'flick' のノーツはフリックノーツ。JSON では [t, lane, 0, "flick"] と書く
 * （長押しは持たないので3要素目は 0）。
 */
export type NoteData = readonly [number, number, number?, NoteKind?];

export interface ChartSet {
  easy: NoteData[];
  normal: NoteData[];
  hard: NoteData[];
}

export interface SongData {
  title: string;
  durationMs: number;
  bpm: number;
  /** FEVER区間 [開始秒, 終了秒) */
  fever: [number, number][];
  charts: ChartSet;
}

export const DIFFICULTIES: Record<Difficulty, { label: string; fallSeconds: number }> = {
  easy: { label: 'かんたん', fallSeconds: 2.0 },
  normal: { label: 'ふつう', fallSeconds: 1.6 },
  hard: { label: 'むずかしい', fallSeconds: 1.3 },
};

export const LANE_COUNT = 4;
/** レーンの色（左から） */
export const LANE_COLORS = ['#ff6b6b', '#ffd166', '#4ecdc4', '#6c8cff'] as const;

/** 判定幅 (ms) */
export const JUDGE_WINDOWS = { perfect: 50, great: 100, good: 160 } as const;
export const JUDGE_SCORES: Record<Exclude<Judge, 'miss'>, number> = { perfect: 1000, great: 700, good: 400 };

/** オフセット調整の範囲 (ms) */
export const OFFSET_MIN = -200;
export const OFFSET_MAX = 200;
export const OFFSET_STEP = 10;

export function clampOffset(ms: number): number {
  const stepped = Math.round(ms / OFFSET_STEP) * OFFSET_STEP;
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, stepped));
}

// ---- 音符の落下速度の調整（プレイヤー設定。難易度の fallSeconds に倍率で重なる） ----

/** 速度の倍率の下限・上限と刻み幅。×1.0 がいままでの速度（既定） */
export const SPEED_MIN = 0.8;
export const SPEED_MAX = 2.0;
export const SPEED_STEP = 0.1;
export const SPEED_DEFAULT = 1.0;

/** 倍率を刻みに丸めて範囲に収める。不正な値は既定（×1.0）にする */
export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return SPEED_DEFAULT;
  const stepped = Math.round(value / SPEED_STEP) * SPEED_STEP;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, stepped));
  // 0.1 刻みの浮動小数誤差（1.3000000000000003 など）を落とす
  return Math.round(clamped * 10) / 10;
}

/** 実効の落下時間（秒）。倍率が大きいほど速く落ちる（落下時間は短くなる） */
export function effectiveFallSeconds(fallSeconds: number, speed: number): number {
  return fallSeconds / clampSpeed(speed);
}

// ---- 判定ラインの高さ（タッチ位置は「上」固定。オーナー決定 2026-11-23） ----

/**
 * 判定ラインの位置（画面の高さに対する比率）。タッチ位置は「上」で固定する
 * （旧「標準」の 0.82 から画面高さの約8%分上げた 0.74。指が画面下端に寄り
 * すぎない位置で叩ける）。以前は設定で 標準／上 を選べたが、オーナー決定
 * （2026-11-23）で「上」を標準として固定し、設定は撤去した。過去に「標準」で
 * 保存した端末でも、保存値は読まれないので常にこの位置になる。
 */
export const HIT_Y_RATIO = 0.74;

// ---- オーディオビジュアライザー（周波数バー固定） ----
// タッチ位置を「上」に固定したことで空いたプレイ画面の下部スペースに、再生中の
// 曲から取った周波数を描く（オーナー決定 2026-11-23）。当初はスタイル4種を
// 設定で切り替えられる形で入れたが、同日の実機確認を経たオーナー決定で
// 周波数バー固定に変更し、設定は撤去した（過去に保存したスタイル値は読まれない）。
// 色と明るさは控えめにして、譜面から目が離れないようにする。描画そのものは
// game.ts、データ取得は audio.ts の曲専用アナライザが担い、ここには純粋な
// 集計だけを置く。

/** 周波数バーの本数 */
export const VISUALIZER_FREQ_BARS = 36;
/** 周波数を対数グループ化する範囲（Hz） */
export const VISUALIZER_FREQ_MIN_HZ = 40;
export const VISUALIZER_FREQ_MAX_HZ = 13000;

/**
 * 周波数データ（AnalyserNode の getByteFrequencyData、0..255）を対数スケールで
 * groups 本に平均化し、0..1 の配列で返す。プレビュー（render_visualizer.py の
 * grouped）と同方式：40Hz〜13kHz を対数で等分し、各帯域のビンを平均する。
 */
export function groupFreqBins(freq: ArrayLike<number>, groups: number, sampleRate: number): number[] {
  const binHz = sampleRate / 2 / Math.max(1, freq.length - 1);
  const logLo = Math.log(VISUALIZER_FREQ_MIN_HZ);
  const logHi = Math.log(VISUALIZER_FREQ_MAX_HZ);
  const out: number[] = [];
  for (let i = 0; i < groups; i++) {
    const loHz = Math.exp(logLo + ((logHi - logLo) * i) / groups);
    const hiHz = Math.exp(logLo + ((logHi - logLo) * (i + 1)) / groups);
    const lo = Math.max(1, Math.floor(loHz / binHz));
    const hi = Math.min(freq.length, Math.max(lo + 1, Math.floor(hiHz / binHz)));
    let sum = 0;
    for (let b = lo; b < hi; b++) sum += freq[b];
    out.push(hi > lo ? sum / (hi - lo) / 255 : 0);
  }
  return out;
}

// ---- 遅延チェック（拍に合わせてタップし、タイミングのずれを実測する） ----
// 端末やイヤホンの遅延で「タップが拍より遅れる」量を測り、オフセットへ反映する。
// 符号の約束: ズレ = タップ時刻 − 最寄りの拍の時刻（+ は拍より遅れてタップした）。
// ゲーム側のオフセットは makePlayNotes でノーツの判定時刻を +offsetMs だけ後ろへ
// ずらすので、「遅れてタップする量（+）」をそのままオフセットにすれば打ち消せる
// （手動調整の注記「ノーツが遅れて感じる → ＋」とも一致する）。

/** 遅延チェックの拍の速さ (BPM)。1拍 1000ms で、落ち着いて合わせられる速さにする */
export const LATENCY_BPM = 60;
/** 必要なタップ回数（簡略化で 10 → 6。手間と精度の釣り合いで決めた） */
export const LATENCY_TAP_COUNT = 6;
/** 練習として捨てる最初のタップ回数 */
export const LATENCY_DROP_COUNT = 1;
/** 直前のタップからこの間隔 (ms) 未満のタップは、二度押しとして数えない */
export const LATENCY_MIN_TAP_GAP_MS = 200;

/** 拍の間隔 (ms) */
export function latencyIntervalMs(): number {
  return 60000 / LATENCY_BPM;
}

/** 近すぎるタップ（二度押し・ボタンの跳ね返り）を除く。時刻は昇順の前提 */
export function filterTapTimes(tapTimesMs: readonly number[], minGapMs = LATENCY_MIN_TAP_GAP_MS): number[] {
  const kept: number[] = [];
  for (const t of tapTimesMs) {
    if (kept.length === 0 || t - kept[kept.length - 1] >= minGapMs) kept.push(t);
  }
  return kept;
}

/**
 * タップ時刻（拍と同じ時計の ms）の列から、各タップと最寄りの拍とのズレ（符号付き ms）を返す。
 * startMs は最初の拍の時刻、intervalMs は拍の間隔。
 */
export function latencyDeltas(tapTimesMs: readonly number[], startMs: number, intervalMs: number): number[] {
  return tapTimesMs.map((t) => {
    const beatIndex = Math.round((t - startMs) / intervalMs);
    return t - (startMs + beatIndex * intervalMs);
  });
}

export interface LatencyStats {
  /** 平均のズレ (ms)。+ は拍より遅れてタップしている */
  meanMs: number;
  /** ばらつき（標準偏差、ms） */
  stddevMs: number;
  /** 計算に使ったタップ数 */
  usedCount: number;
}

/**
 * ズレの列から、最初の drop 件を練習として捨てて平均と標準偏差を出す。
 * 捨てたあとに残りがなければ null。
 */
export function latencyStats(deltasMs: readonly number[], drop = LATENCY_DROP_COUNT): LatencyStats | null {
  const used = deltasMs.slice(Math.max(0, drop));
  if (used.length === 0) return null;
  const mean = used.reduce((s, d) => s + d, 0) / used.length;
  const variance = used.reduce((s, d) => s + (d - mean) * (d - mean), 0) / used.length;
  return { meanMs: mean, stddevMs: Math.sqrt(variance), usedCount: used.length };
}

/** ズレ (ms, 符号なし) から判定を返す。窓の外は null（ノーツを消費しない） */
export function judgeFor(absDeltaMs: number): Exclude<Judge, 'miss'> | null {
  if (absDeltaMs <= JUDGE_WINDOWS.perfect) return 'perfect';
  if (absDeltaMs <= JUDGE_WINDOWS.great) return 'great';
  if (absDeltaMs <= JUDGE_WINDOWS.good) return 'good';
  return null;
}

export function scoreFor(judge: Exclude<Judge, 'miss'>): number {
  return JUDGE_SCORES[judge];
}

export interface JudgementCounts {
  perfect: number;
  great: number;
  good: number;
  miss: number;
}

export const emptyCounts = (): JudgementCounts => ({ perfect: 0, great: 0, good: 0, miss: 0 });

export function totalNotes(counts: JudgementCounts): number {
  return counts.perfect + counts.great + counts.good + counts.miss;
}

/** 精度 (%)。ノーツがなければ 0 */
export function accuracy(counts: JudgementCounts): number {
  const total = totalNotes(counts);
  if (total === 0) return 0;
  return ((counts.perfect + counts.great * 0.7 + counts.good * 0.4) / total) * 100;
}

export type Rank = 'S' | 'A' | 'B' | 'C';

/**
 * フルコンボか（ミスが1つもなく、判定されたノーツが1つ以上ある）。
 * 長押しの失敗も game.ts の集計で counts.miss に数えられるので、この定義で
 * 「演奏の集計」と一致する。判定ノーツが0の結果（デバッグの即時終了など）は
 * フルコンボにしない。
 */
export function isFullCombo(counts: JudgementCounts): boolean {
  return counts.miss === 0 && totalNotes(counts) > 0;
}

/**
 * ハイスコア更新か（保存済みベストを上回ったか）。
 * 初回プレイ（ベスト未保存＝undefined）は、ベストが新たに作られる回なので
 * 「更新」に含める（ベスト保存の条件＝前回ベスト以上、と対になる考え方。
 * ただし同点は更新にしない：上回ったときだけ印とボイスを出す）。
 * スコア 0 は更新にしない（何も叩かずに終わった回で印を出さないため）。
 * オートプレイ・失敗の回はベスト自体を更新しないので、呼び出し側で除外する。
 */
export function isNewBest(prevScore: number | undefined, score: number): boolean {
  return score > 0 && score > (prevScore ?? 0);
}

/** ランクの境目（精度 %）。C は最低ランクなので境目を持たない */
export const RANK_THRESHOLDS: Record<Exclude<Rank, 'C'>, number> = { S: 95, A: 85, B: 70 };

export function rankFor(acc: number): Rank {
  if (acc >= RANK_THRESHOLDS.S) return 'S';
  if (acc >= RANK_THRESHOLDS.A) return 'A';
  if (acc >= RANK_THRESHOLDS.B) return 'B';
  return 'C';
}

/**
 * ライフ（演奏中のメーターとゲームオーバーの仕組み。案1：ライフ制）。
 * オーナー指示 2026-11-22: 累計精度でメーターとゲームオーバーを決める方式
 * （v1.4.4〜v1.4.10）は「序盤は1ミスが重く、後半はミスしてもほぼ下がらない」
 * 歪みがあるため考え直し、古典的なライフ制に作り替えた（v1.4.12）。
 * - メーターはライフ専用。精度とランクは結果画面でのみ出す（rankFor は不変）。
 * - ライフは満タンから始まり、判定のたびに増減する。上限で頭打ちになるため
 *   回復の効きは「判定の並び順」に依存する＝累計（counts）からは再計算できない。
 *   呼び出し側（game.ts）が判定の発生順に applyLifeDelta で積み上げる。
 * - 0 になったらその場でゲームオーバー。猶予は設けない（満タン開始が緩衝）。
 */

/** ライフの最大値。演奏は満タンから始める */
export const LIFE_MAX = 100;

/**
 * 判定ごとのライフ増減。MISS は大きく減り、GOOD でも少し減る。
 * PERFECT／GREAT の回復は控えめで、満タン付近では頭打ちになる分だけ
 * 「序盤のミスを取り返すには良い判定を重ねる必要がある」効き方になる。
 * 目安（hard 約600ノーツ）: ミス25連続で満タンから 0。ミス1割・PERFECT7割の
 * 演奏では終盤に 10〜20 残る程度で、理不尽には落ちない。
 */
export const LIFE_DELTAS: Record<Judge, number> = { perfect: 0.4, great: 0.2, good: -1, miss: -4 };

/** ライフの帯。caution 以下で注意、danger 以下で危険（表示色と点滅に使う） */
export const LIFE_CAUTION = 50;
export const LIFE_DANGER = 30;

export type LifeZone = 'safe' | 'caution' | 'danger';

/** 判定をライフへ反映した新しい値を返す（0〜LIFE_MAX に丸める）。times は同時ミスの個数用 */
export function applyLifeDelta(life: number, judge: Judge, times = 1): number {
  return Math.min(LIFE_MAX, Math.max(0, life + LIFE_DELTAS[judge] * times));
}

/** ライフの帯（表示用） */
export function lifeZone(life: number): LifeZone {
  if (life <= LIFE_DANGER) return 'danger';
  if (life <= LIFE_CAUTION) return 'caution';
  return 'safe';
}

/** ライフが尽きてゲームオーバーか。オートプレイで発動させないのは呼び出し側の責務 */
export function isLifeGameOver(life: number): boolean {
  return life <= 0;
}

/** 長押しの頭の判定（ミス以外） */
export type HeadJudge = Exclude<Judge, 'miss'>;

/** 長押しの進行状態。none=未開始（通常ノーツもこれ） */
export type HoldPhase = 'none' | 'holding' | 'grace' | 'done' | 'failed';

/** プレイ中のノーツ。state: 0=未判定, 1=ヒット, 2=ミス */
export interface PlayNote {
  timeMs: number;
  lane: number;
  state: 0 | 1 | 2;
  /** 長押しの長さ (ms)。0 は通常ノーツ */
  holdMs: number;
  /** フリックノーツか（タップでは取れず、上フリックでのみ取れる） */
  flick: boolean;
  /** 長押しの頭の判定。頭を押したときだけ入る */
  headJudge: HeadJudge | null;
  /** 長押しの進行状態 */
  holdPhase: HoldPhase;
  /** grace（離し直しの猶予）に入った時刻 (ms) */
  graceStartMs: number;
  /** tick スコアの間隔 (ms)。beginHold で決まる */
  tickMs: number;
  /** 次に tick スコアが入る時刻 (ms) */
  nextTickMs: number;
}

export function makePlayNotes(chart: NoteData[], offsetMs: number): PlayNote[] {
  return chart.map(([t, lane, hold, kind]) => ({
    timeMs: t + offsetMs,
    lane,
    state: 0 as const,
    holdMs: hold ?? 0,
    flick: kind === 'flick',
    headJudge: null,
    holdPhase: 'none' as const,
    graceStartMs: 0,
    tickMs: 0,
    nextTickMs: 0,
  }));
}

// ---- 長押し（ホールド）の状態遷移。仕様は docs/CHART-DESIGN.md ----

/** 離してから押し直すまでの猶予 (ms)。指のブレ対策 */
export const HOLD_GRACE_MS = 100;
/** 押し続けている間に1拍ごとに入るスコア */
export const HOLD_TICK_SCORE = 100;
/** 押し切ったときのボーナス（頭のスコアの半分） */
export const HOLD_COMPLETE_BONUS: Record<HeadJudge, number> = { perfect: 500, great: 350, good: 200 };

/** 頭を押して長押しを開始する。tickMs は1拍の長さ */
export function beginHold(note: PlayNote, judge: HeadJudge, tickMs: number): void {
  note.headJudge = judge;
  note.holdPhase = 'holding';
  note.tickMs = tickMs;
  note.nextTickMs = note.timeMs + tickMs;
}

/** 押し続けている途中で離した。猶予（grace）に入る */
export function releaseHold(note: PlayNote, nowMs: number): void {
  if (note.holdPhase !== 'holding') return;
  note.holdPhase = 'grace';
  note.graceStartMs = nowMs;
}

/** 猶予中に押し直した。復帰できたら true */
export function repressHold(note: PlayNote, nowMs: number): boolean {
  if (note.holdPhase !== 'grace') return false;
  if (nowMs - note.graceStartMs > HOLD_GRACE_MS) return false;
  note.holdPhase = 'holding';
  // 猶予の間に来た拍境界は捨てる（tick は押せている間だけ数える）
  while (note.tickMs > 0 && note.nextTickMs <= nowMs) note.nextTickMs += note.tickMs;
  return true;
}

export interface HoldAdvance {
  /** 今回入った tick スコアの回数 */
  ticks: number;
  /** 押し切った */
  completed: boolean;
  /** 失敗した（猶予を過ぎても押し直されなかった） */
  failed: boolean;
}

/**
 * 長押しの時間を進める。毎フレーム nowMs で呼ぶ。
 * tick は「押せている間」だけ数える（grace 中に来た拍境界は捨てる）。
 * 離したまま尾を過ぎた場合も、猶予内に尾へ届いていれば完走扱いにする。
 */
export function advanceHold(note: PlayNote, nowMs: number): HoldAdvance {
  const res: HoldAdvance = { ticks: 0, completed: false, failed: false };
  if (note.holdPhase !== 'holding' && note.holdPhase !== 'grace') return res;
  const tailMs = note.timeMs + note.holdMs;
  const limit = Math.min(nowMs, tailMs);
  while (note.tickMs > 0 && note.nextTickMs <= limit) {
    if (note.holdPhase === 'holding') res.ticks++;
    note.nextTickMs += note.tickMs;
  }
  if (note.holdPhase === 'grace') {
    if (nowMs >= tailMs && note.graceStartMs + HOLD_GRACE_MS >= tailMs) {
      note.holdPhase = 'done';
      res.completed = true;
    } else if (nowMs - note.graceStartMs > HOLD_GRACE_MS) {
      note.holdPhase = 'failed';
      res.failed = true;
    }
    return res;
  }
  if (nowMs >= tailMs) {
    note.holdPhase = 'done';
    res.completed = true;
  }
  return res;
}

/** フリックとみなす上方向の移動量 (px)。これ以上、上へ動いたらフリック発火 */
export const FLICK_MIN_UP_PX = 40;
/** フリックとして認める、押し始めからの時間 (ms)。これを過ぎた上移動はフリックにしない */
export const FLICK_TIME_LIMIT_MS = 400;

/**
 * レーン内の未判定ノーツから、条件に合うもののうち時刻がいちばん近いものを探す。
 * notes は時刻昇順である前提（判定窓より先のノーツで打ち切る）。
 */
function closestPending(
  notes: PlayNote[],
  lane: number,
  nowMs: number,
  accept: (n: PlayNote) => boolean,
): { note: PlayNote; delta: number } | null {
  let best: PlayNote | null = null;
  let bestDelta = Infinity;
  for (const n of notes) {
    if (n.timeMs - nowMs > JUDGE_WINDOWS.good) break;
    if (n.state !== 0 || n.lane !== lane || !accept(n)) continue;
    const d = Math.abs(n.timeMs - nowMs);
    if (d < bestDelta) {
      best = n;
      bestDelta = d;
    }
  }
  return best ? { note: best, delta: bestDelta } : null;
}

/**
 * タップしたレーンで、いちばん近い未判定ノーツを探す。
 * 判定窓の外なら null。フリックノーツはタップでは取れないので対象外にする。
 */
export function findHit(notes: PlayNote[], lane: number, nowMs: number): { note: PlayNote; judge: Exclude<Judge, 'miss'> } | null {
  const found = closestPending(notes, lane, nowMs, (n) => !n.flick);
  if (!found) return null;
  const judge = judgeFor(found.delta);
  return judge ? { note: found.note, judge } : null;
}

/**
 * フリックしたレーンで取るノーツを探す。フリックノーツを最優先し、
 * 無ければ通常のタップノーツ（長押しの頭は対象にしない）を取る。
 * 判定窓の外なら null。
 */
export function findFlickHit(notes: PlayNote[], lane: number, nowMs: number): { note: PlayNote; judge: Exclude<Judge, 'miss'> } | null {
  const flick = closestPending(notes, lane, nowMs, (n) => n.flick);
  if (flick) {
    const judge = judgeFor(flick.delta);
    return judge ? { note: flick.note, judge } : null;
  }
  const tap = closestPending(notes, lane, nowMs, (n) => !n.flick && n.holdMs === 0);
  if (!tap) return null;
  const judge = judgeFor(tap.delta);
  return judge ? { note: tap.note, judge } : null;
}

/**
 * キーボードで叩いたレーンで取るノーツを探す。キーボードにはフリックの
 * ジェスチャが無いので、フリックノーツも通常のタップノーツと同じキー押しで
 * 取れるようにする（オーナー指示 2026-11-22「キーボードは、フリックもそのまま
 * 叩ける判定にして」）。種別を問わずいちばん近い未判定ノーツを、タップと同じ
 * 判定窓・区分（PERFECT/GREAT/GOOD）で返す。判定窓の外なら null。
 * 長押しの頭も従来どおり対象に含む（キーボードの長押し処理は無変更）。
 */
export function findKeyboardHit(notes: PlayNote[], lane: number, nowMs: number): { note: PlayNote; judge: Exclude<Judge, 'miss'> } | null {
  const found = closestPending(notes, lane, nowMs, () => true);
  if (!found) return null;
  const judge = judgeFor(found.delta);
  return judge ? { note: found.note, judge } : null;
}

/**
 * レーン内の判定窓にある未判定ノーツのうち、いちばん近いもの（種別は問わない）。
 * 「最寄りがフリックノーツならタップ入力を無効にする」判定に使う。窓の外なら null。
 */
export function findNearestNote(notes: PlayNote[], lane: number, nowMs: number): PlayNote | null {
  const found = closestPending(notes, lane, nowMs, () => true);
  if (!found) return null;
  return judgeFor(found.delta) ? found.note : null;
}

/** 判定窓を過ぎた未判定ノーツをミスにする。ミスにした数を返す */
export function sweepMisses(notes: PlayNote[], nowMs: number): number {
  let missed = 0;
  for (const n of notes) {
    if (n.timeMs - nowMs > JUDGE_WINDOWS.good) break;
    if (n.state === 0 && nowMs - n.timeMs > JUDGE_WINDOWS.good) {
      n.state = 2;
      missed++;
    }
  }
  return missed;
}

// ---- コンボ連動の演出段階（tier）とヒット音のピッチ ----
// コンボが伸びるほど演出と音が派手になる。段階の境界と係数はここを正本にする。

/** tier が上がり始めるコンボ数（tier 0〜4） */
export const COMBO_TIER_STARTS = [0, 10, 25, 50, 100] as const;
export const MAX_COMBO_TIER = COMBO_TIER_STARTS.length - 1;

/** コンボ数から演出段階（0〜4）を返す */
export function comboTier(combo: number): number {
  let tier = 0;
  for (let i = 0; i < COMBO_TIER_STARTS.length; i++) {
    if (combo >= COMBO_TIER_STARTS[i]) tier = i;
  }
  return tier;
}

/**
 * 演出段階はコンボだけで決まる（FEVER は 2026-11-20 にオーナー判断で廃止。
 * サビ区間の倍率・枠の光は実感が薄く、代わりにコンボ段階で画面演出を強める）。
 * 譜面データの fever（サビ区間）は生成器側の記録として残るが、演奏には使わない
 */

/** コンボ演出（キャラ登場）が起きるコンボの間隔 */
export const COMBO_SHOW_INTERVAL = 30;

/**
 * コンボ数がコンボ演出のタイミングか（30 ごと＋100 の倍数）。
 * 100 は 30 の倍数ではないので、倍数側も登場タイミングに含める
 * （100、200 では isComboShowBig の一段大きい登場になる）。
 */
export function isComboShow(combo: number): boolean {
  return combo > 0 && (combo % COMBO_SHOW_INTERVAL === 0 || combo % 100 === 0);
}

/** 100 の倍数（一段大きい登場）か */
export function isComboShowBig(combo: number): boolean {
  return combo > 0 && combo % 100 === 0;
}

/** 背景の push-in の種別（standard: 標準 / fast: 速く寄る / cinematic: ゆっくり寄る） */
export type ComboZoom = 'standard' | 'fast' | 'cinematic';

/** 1回のコンボ演出の内容（パターン ID とズームと big かどうか） */
export interface ComboAppearance {
  /** パターン ID（src/presentation.ts の COMBO_PATTERNS の id） */
  pattern: string;
  zoom: ComboZoom;
  big: boolean;
}

/**
 * コンボ演出のパターン割り当ての設定。作品側の素材スロット
 * （src/presentation.ts）が組み立てて渡す、ただのデータ。
 */
export interface ComboShowConfig {
  /** 通常登場のパターンのローテーション順（パターン ID の列） */
  rotation: readonly string[];
  /** big（100の倍数）で優先するパターン ID の列（big の回数で交互に出す） */
  bigPatterns: readonly string[];
  /** パターンごとのズーム種別 */
  zoomByPattern: Readonly<Record<string, ComboZoom>>;
}

/**
 * 登場パターンを決める。count は今回を含まない過去の登場回数（0始まり）で、
 * 通常登場は config.rotation をローテーションする。big（100の倍数）では
 * config.bigPatterns を big の回数（100→1回目）で交互に優先する。
 * パターンが1つも設定されていない（素材スロットが空の）場合は null を返し、
 * 呼び出し側は演出自体を出さない（演出なしで成立する形）。
 */
export function comboAppearance(combo: number, count: number, config: ComboShowConfig): ComboAppearance | null {
  if (config.rotation.length === 0) return null;
  const big = isComboShowBig(combo) && config.bigPatterns.length > 0;
  let pattern: string;
  if (big) {
    const bigIndex = Math.max(0, Math.floor(combo / 100) - 1);
    pattern = config.bigPatterns[bigIndex % config.bigPatterns.length];
  } else {
    pattern = config.rotation[Math.max(0, count) % config.rotation.length];
  }
  return { pattern, zoom: config.zoomByPattern[pattern] ?? 'standard', big };
}

/** tier ごとの演出パラメータ。値が大きいほど派手 */
export interface TierFx {
  /** ヒット時の粒子数の倍率 */
  particleMul: number;
  /** 粒子の大きさ (px) */
  particleSize: number;
  /** 輪の最大半径の倍率 */
  ringMul: number;
  /** 輪の線の太さの倍率 */
  ringWidthMul: number;
  /** ノーツの弾け（ポップ）の最大拡大率の倍率 */
  popMul: number;
  /** 判定文字の拡大率 */
  judgeMul: number;
  /** 判定文字の色を金色寄りに寄せる割合（0〜1） */
  judgeTint: number;
  /** レーンのフラッシュの明るさの倍率 */
  flashMul: number;
  /** コンボ数字の拡大率 */
  comboScale: number;
  /** コンボ数字の色 */
  comboColor: string;
}

const TIER_FX: readonly TierFx[] = [
  { particleMul: 1.0, particleSize: 4, ringMul: 1.0, ringWidthMul: 1.0, popMul: 1.0, judgeMul: 1.0, judgeTint: 0, flashMul: 1.0, comboScale: 1.0, comboColor: 'rgba(255,255,255,.9)' },
  { particleMul: 1.35, particleSize: 4, ringMul: 1.12, ringWidthMul: 1.2, popMul: 1.12, judgeMul: 1.06, judgeTint: 0.15, flashMul: 1.2, comboScale: 1.05, comboColor: '#a5f3fc' },
  { particleMul: 1.7, particleSize: 5, ringMul: 1.28, ringWidthMul: 1.4, popMul: 1.25, judgeMul: 1.13, judgeTint: 0.3, flashMul: 1.45, comboScale: 1.14, comboColor: '#4ecdc4' },
  { particleMul: 2.1, particleSize: 5, ringMul: 1.45, ringWidthMul: 1.65, popMul: 1.4, judgeMul: 1.22, judgeTint: 0.5, flashMul: 1.7, comboScale: 1.27, comboColor: '#ffd166' },
  { particleMul: 2.6, particleSize: 6, ringMul: 1.65, ringWidthMul: 2.0, popMul: 1.55, judgeMul: 1.32, judgeTint: 0.7, flashMul: 2.0, comboScale: 1.45, comboColor: '#ff8ad8' },
];

/** tier の演出パラメータを返す（範囲外は丸める） */
export function tierFx(tier: number): TierFx {
  const t = Math.min(MAX_COMBO_TIER, Math.max(0, Math.floor(tier)));
  return TIER_FX[t];
}

/** #rrggbb の色を target へ k（0〜1）の割合で寄せる */
export function tintColor(hex: string, target: string, k: number): string {
  const parse = (s: string): [number, number, number] => [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
  const a = parse(hex);
  const b = parse(target);
  const t = Math.min(1, Math.max(0, k));
  const mixed = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** ヒット音のピッチ上昇（半音）。tier ごとに +1、上限は最高 tier 分 */
export function hitPitchSemitones(tier: number): number {
  return Math.min(MAX_COMBO_TIER, Math.max(0, Math.floor(tier)));
}

/** ヒット音のピッチ倍率 */
export function hitPitchMultiplier(tier: number): number {
  return Math.pow(2, hitPitchSemitones(tier) / 12);
}

/** 歌詞1行（src/data/lyrics.json の形）。時刻は曲頭からの ms */
export interface LyricLine {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * 時刻に対応する歌詞行のインデックスを返す。どの行の範囲にもない
 * （イントロ・間奏・曲の終わりのあと）なら -1。行は startMs 昇順の前提。
 */
export function lyricIndexAt(lines: readonly LyricLine[], atMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= atMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  return atMs < lines[found].endMs ? found : -1;
}

/** 譜面データの検証。問題があれば文言の配列を返す（生成スクリプトと同じ規則） */
export function validateCharts(song: SongData): string[] {
  const errors: string[] = [];
  const order: Difficulty[] = ['easy', 'normal', 'hard'];
  let prevCount = -1;
  for (const diff of order) {
    const notes = song.charts[diff];
    if (notes.length === 0) errors.push(`${diff}: ノーツがありません`);
    const seen = new Set<string>();
    let prevTime = -1;
    for (const [t, lane] of notes) {
      if (t < prevTime) errors.push(`${diff}: 時刻が昇順ではありません (${t})`);
      prevTime = t;
      if (lane < 0 || lane >= LANE_COUNT) errors.push(`${diff}: レーンが範囲外です (${lane})`);
      const key = `${t}:${lane}`;
      if (seen.has(key)) errors.push(`${diff}: 同刻・同レーンの重複があります (${key})`);
      seen.add(key);
    }
    // 長押しの検証: 尾の余裕、同じレーンのノーツが帯の中に入らないこと、長押し同士の重なり
    const holds = notes.filter((n) => (n[2] ?? 0) > 0);
    for (const n of notes) {
      if (n[3] === 'flick') {
        // フリックノーツは長押しを持たない（JSON では [t, lane, 0, "flick"] と書く）
        if ((n[2] ?? 0) > 0) errors.push(`${diff}: フリックノーツに長押しが付いています (${n[0]}ms)`);
      } else if (n[2] !== undefined && n[2] <= 0) {
        errors.push(`${diff}: 長押しの長さが不正です (${n[0]}ms)`);
      }
    }
    for (const [t, lane, hold] of holds) {
      const tail = t + (hold ?? 0);
      if (tail > song.durationMs - 500) errors.push(`${diff}: 長押しの尾が曲の終わりに近すぎます (${t}ms)`);
      for (const [t2, lane2] of notes) {
        if (lane2 === lane && t2 > t && t2 <= tail) {
          errors.push(`${diff}: 長押しの帯の中に同じレーンのノーツがあります (${t2}ms)`);
        }
      }
      for (const [t2] of holds) {
        if (t2 > t && t2 < tail) errors.push(`${diff}: 長押し同士が重なっています (${t}ms と ${t2}ms)`);
      }
    }
    if (notes.length > 0) {
      if (notes[0][0] < 2000) errors.push(`${diff}: 最初のノーツがイントロの途中です (${notes[0][0]}ms)`);
      const last = notes[notes.length - 1][0];
      if (last > song.durationMs - 1000) errors.push(`${diff}: 最後のノーツが曲の終わりに近すぎます (${last}ms)`);
    }
    if (notes.length < prevCount) errors.push(`${diff}: ノーツ数が前の難易度より少ないです`);
    prevCount = notes.length;
  }
  for (const [from, to] of song.fever) {
    if (!(from >= 0 && from < to && to <= song.durationMs / 1000)) errors.push(`FEVER区間が不正です [${from}, ${to}]`);
  }
  return errors;
}
