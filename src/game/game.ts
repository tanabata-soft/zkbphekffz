// ゲーム画面の統括（単位Fで責務分割）。
// 分割後の構成:
// - game-session.ts（GameSession）: AudioContext 時計・凍結検知・ポーズ状態
// - game-input.ts（GameInput）: ポインタ／キー／visibility 等の入力と押下状態
// - game-effects.ts（GameEffects）: 粒子・判定文字・コンボ背景などの演出状態
// - game-renderer.ts（GameRenderer）: Canvas 描画・レーン形状・背景キャッシュ
// - game-window.ts: 描画・掃除を再生位置ウィンドウに限定する範囲計算
// このファイル（Game）は演奏セッションの開始／終了、判定処理、毎フレームの
// 調停（時計→歌詞→オートプレイ→ミス掃除→長押し進行→描画）だけを持つ。
// 判定・スコア計算は src/logic.ts の純関数を使う。振る舞いは分割前と同一。
// 演出（粒子・輪・波紋・判定文字）はすべて経過時間ベースで進める（120Hz でも 60Hz と同じ見え方にする）。
import {
  DIFFICULTIES,
  HOLD_COMPLETE_BONUS,
  HOLD_TICK_SCORE,
  JUDGE_WINDOWS,
  LANE_COLORS,
  SPEED_DEFAULT,
  advanceHold,
  beginHold,
  clampSpeed,
  comboAppearance,
  comboTier,
  effectiveFallSeconds,
  emptyCounts,
  findFlickHit,
  findHit,
  findKeyboardHit,
  findNearestNote,
  isComboShow,
  LIFE_MAX,
  applyLifeDelta,
  isLifeGameOver,
  lyricIndexAt,
  makePlayNotes,
  rankFor,
  accuracy,
  releaseHold,
  repressHold,
  scoreFor,
  sweepMisses,
  type Difficulty,
  type ComboAppearance,
  type HeadJudge,
  type JudgementCounts,
  type PlayNote,
  type Rank,
} from './logic';
import type { SongEntry } from './charts';
import { COMBO_PATTERNS, COMBO_SHOW_CONFIG } from './presentation';
import { audioContext, loadBuffer, nowSeconds, playBuffer, recreateAudioContext, resumeAudio, stopCurrent, unlockAudio } from './audio';
import { playCompleteSound, playEmptySound, playFailSound, playFlickSound, playHitSound, playMissSound, startHoldSound, stopAllHoldSounds, stopHoldSound } from './sound';
import { vibrateHit } from './haptics';
import { setData } from '../debug';
import { GameSession } from './game-session';
import { GameInput } from './game-input';
import { GameEffects, RIPPLE_LIFE, comboBgImage } from './game-effects';
import { GameRenderer } from './game-renderer';
import { isSortedByTime, judgeWindow, maxHoldMsOf, noteWindow } from './game-window';

export { MAX_DPR } from './game-renderer';

export interface GameResult {
  songTitle: string;
  difficulty: Difficulty;
  score: number;
  counts: JudgementCounts;
  maxCombo: number;
  accuracy: number;
  rank: Rank;
  /** オートプレイで演奏したか（true の回はベストスコアに残さない） */
  autoplay: boolean;
  /** ライフが尽きてゲームオーバーになったか（true の回はベストスコアに残さない） */
  failed: boolean;
}

export interface GameCallbacks {
  onFinish(result: GameResult): void;
  /** 中断（確認カードで「メニューに戻る」を選んだ）でメニューに戻るとき */
  onAbort(): void;
  /** 中断の確認カードの開閉（開く=true。閉じるは「つづける」を押したとき） */
  onPause(open: boolean): void;
  /** コンボが30の倍数に達した（コンボ演出の登場）。appearance にパターン・ズーム・big が入る */
  onComboShow(combo: number, appearance: ComboAppearance): void;
  /** 歌詞の現在行が変わった（-1 は歌詞のない区間） */
  onLyric(index: number): void;
}

// 判定ラインの高さは H×0.74 で固定（タッチ位置「上」。logic.ts の HIT_Y_RATIO）。
// GameRenderer.hitY() を参照
const READY_SECONDS = 2;
/** 中断確認で「つづける」を押してから演奏が戻るまでの READY の時間（壁時計 ms） */
const RESUME_COUNTDOWN_MS = 1000;

export class Game {
  private renderer: GameRenderer;
  private session = new GameSession();
  private effects = new GameEffects();
  private input: GameInput;
  private cb: GameCallbacks;
  private raf = 0;
  private playing = false;
  private destroyed = false;

  private entry: SongEntry | null = null;
  private difficulty: Difficulty = 'easy';
  /** start で受け取った判定オフセット（中断確認の「はじめからやりなおす」で同じ条件で開始し直すため保持する） */
  private offsetMs = 0;
  /** オートプレイ中か（設定のデバッグモード配下。start で受け取る） */
  private autoplay = false;
  private notes: PlayNote[] = [];
  private counts: JudgementCounts = emptyCounts();
  /** ライフ（0〜LIFE_MAX）。判定の発生順に増減するので counts からは再計算しない */
  private life = LIFE_MAX;
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private durationSec = 0;
  private lyricIndex = -2; // 現在の歌詞行（-2 は未送信。-1 は歌詞のない区間）
  private lastFrameAt = 0; // 前フレームの AudioContext 時刻（秒）。dt の計算用
  /** 音符の落下速度の倍率（プレイヤー設定。start で受け取る） */
  private speed = SPEED_DEFAULT;
  private holdsCompleted = 0;
  private holdsFailed = 0;
  /** 進行中の長押し（holding / grace）の集合。走査を全譜面ではなくこの集合に限定する（単位F） */
  private activeHolds = new Set<PlayNote>();
  /** 譜面が時刻昇順か（ウィンドウ化の前提。崩れていたら全走査へフォールバックする） */
  private notesSorted = true;
  /** 譜面中の最大ホールド長 (ms)。ウィンドウの過去側余裕に使う */
  private maxHoldMs = 0;
  /** ミス掃除のカーソル（時刻昇順のときだけ進む。単位F） */
  private sweepIdx = 0;
  /** オートプレイの処理カーソル（時刻昇順のときだけ進む。単位F） */
  private autoIdx = 0;

  constructor(canvas: HTMLCanvasElement, notesCanvas: HTMLCanvasElement, cb: GameCallbacks) {
    this.renderer = new GameRenderer(canvas, notesCanvas);
    this.cb = cb;
    this.input = new GameInput(canvas, this.renderer, {
      isPlaying: () => this.playing,
      isPaused: () => this.session.paused,
      isAutoplay: () => this.autoplay,
      pause: () => this.pause(),
      pressLane: (lane, x, y, viaKeyboard) => this.pressLane(lane, x, y, viaKeyboard),
      flickLane: (lane, x, y) => this.flickLane(lane, x, y),
      releaseLane: (lane) => this.releaseLane(lane),
      releaseAllHolds: () => this.releaseAllHolds(),
    });
    this.input.attach();
    // コンボ演出の絵は、初回の登場で読み込み待ちにならないよう先読みしておく
    for (const def of COMBO_PATTERNS) if (def.imageUrl) comboBgImage(def.id);
  }

  destroy(): void {
    this.destroyed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    stopCurrent();
    stopAllHoldSounds();
    this.input.detach();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 今の演奏がオートプレイか */
  get isAutoplay(): boolean {
    return this.autoplay;
  }

  /** テスト用の入口向け: 現在のライフ（0〜LIFE_MAX） */
  get lifeValue(): number {
    return this.life;
  }

  /** テスト用の入口向け: 曲の現在位置（ms。READY 中は負、演奏中でなければ -1） */
  songPositionMs(): number {
    if (!this.playing) return -1;
    if (this.session.paused) return this.session.pausePosSec * 1000;
    return (nowSeconds() - this.session.startAt) * 1000;
  }

  /** 曲を読み込んで演奏を始める。読み込み済みなら即座に始まる。autoplay は設定のデバッグモード配下のオートプレイ。speed は音符の落下速度の倍率（プレイヤー設定） */
  async start(
    entry: SongEntry,
    difficulty: Difficulty,
    offsetMs: number,
    autoplay = false,
    speed = SPEED_DEFAULT,
  ): Promise<void> {
    // スタート操作のジェスチャの中で呼ばれる前提で、まず音声を unlock する
    unlockAudio();
    const session = ++this.session.startSession;
    // 前の演奏の最終フレーム（前の曲のジャケット背景）が、音の読み込み中に
    // そのまま見えてしまうのを防ぐ。ゲーム画面への切替と同じ同期処理の中で
    // 両キャンバスを地の色へ戻し、背景の参照も外しておく（オーナー指摘
    // 2026-11-21: リズムゲーム開始直後に前の曲の背景が一瞬残る）
    this.renderer.setJacket(null);
    this.renderer.clearCanvases();
    // 歌詞表示（DOM）も前の曲のものが残るため、読み込み前に「歌詞なし」を通知して
    // 消しておく（オーナー指摘 2026-11-21: 背景は消えたが歌詞が残っていた）
    this.cb.onLyric(-1);
    const buf = await loadBuffer(entry.audioUrl);
    if (this.destroyed || session !== this.session.startSession) return;
    this.session.songBuf = buf;
    this.session.paused = false;
    this.entry = entry;
    this.difficulty = difficulty;
    this.offsetMs = offsetMs;
    this.autoplay = autoplay;
    this.speed = clampSpeed(speed);
    setData('autoplay', autoplay ? 'on' : 'off');
    this.notes = makePlayNotes(entry.data.charts[difficulty], offsetMs);
    this.notesSorted = isSortedByTime(this.notes);
    this.maxHoldMs = maxHoldMsOf(this.notes);
    this.sweepIdx = 0;
    this.autoIdx = 0;
    this.activeHolds.clear();
    this.counts = emptyCounts();
    this.life = LIFE_MAX;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.effects.reset();
    this.input.clearPressed();
    stopAllHoldSounds();
    this.holdsCompleted = 0;
    this.holdsFailed = 0;
    setData('holdsCompleted', 0);
    setData('holdsFailed', 0);
    setData('combo', 0);
    setData('comboTier', 0);
    this.lyricIndex = -2;
    setData('comboShow', 0);
    setData('lyricIndex', -1);
    this.durationSec = buf.duration;
    const bg = new Image();
    bg.src = entry.jacketUrl;
    this.renderer.setJacket(bg, entry.frameInset);
    // 再生開始の直前にもう一度 resume する（suspended のままだと currentTime が進まず、
    // その場合は復帰した時点でスケジュールどおり鳴り始める）
    await resumeAudio();
    if (this.destroyed) return;
    if (session !== this.session.startSession || document.visibilityState === 'hidden') {
      // 読み込みの合間にバックグラウンドへ回って中断されていた（または今も裏にいる）。
      // このまま演奏を始めると、止まった時計のまま READY で凍ったように見えるので、
      // 演奏は作らずメニューへ戻す（v1.9.1 の不具合対応）
      setData('game', 'menu');
      this.cb.onAbort();
      return;
    }
    // バックグラウンド復帰などで AudioContext が壊れたまま（resume しても running に
    // 戻らない）ことがある。その状態で始めると時計が凍って READY のまま固まるため、
    // 開始の時点で作り直しておく（2026-11-20 実機報告への対応）
    if (audioContext().state !== 'running') {
      recreateAudioContext();
      unlockAudio();
    }
    this.session.beginClock(nowSeconds() + READY_SECONDS);
    this.lastFrameAt = nowSeconds();
    playBuffer(buf, this.session.startAt);
    this.playing = true;
    setData('game', 'playing');
    setData('score', 0);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * READY 中に音声時計が凍ったときの、開始の初期化し直し。AudioContext を
   * 作り直し、READY の残り時間を新しい時計へ引き継いで曲の開始を予約し直す。
   * 曲はまだ始まっていないので、続きからの再開ではなく開始のやり直しになる。
   */
  private async reinitStart(): Promise<void> {
    const s = this.session;
    if (s.reiniting || !this.playing || !this.entry) return;
    s.reiniting = true;
    s.readyReinitUsed = true;
    const session = s.startSession;
    try {
      const remaining = Math.max(0, s.startAt - nowSeconds());
      recreateAudioContext();
      unlockAudio();
      const buf = await loadBuffer(this.entry.audioUrl);
      if (this.destroyed || !this.playing || session !== s.startSession) return;
      const now = nowSeconds();
      s.reinitClock(now + remaining);
      playBuffer(buf, s.startAt, 0);
      this.lastFrameAt = s.clockSeenAt;
    } catch {
      // 直らなければ次の凍結検知でポーズする
    } finally {
      s.reiniting = false;
    }
  }

  /** 演奏を止めてメニューに戻る（結果は残さない） */
  abort(): void {
    // 進行中の start() があれば取り消す（await の合間に中断されても、
    // 後から演奏が始まってしまわないように。演奏中でなければ世代を進めるだけ）
    this.session.startSession++;
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    stopCurrent();
    stopAllHoldSounds();
    this.session.resetOnAbort();
    setData('game', 'menu');
    this.cb.onAbort();
  }

  /**
   * 演奏を凍結して中断の確認カードを出す（オーナー指示 2026-11-21、案1）。
   * 音はその場で止め、曲位置を覚えておく。再開は resume() → READY をはさんで
   * finishResume() が止めた位置から鳴らし直す。
   * 中断ボタン・Esc・アプリ切替と、音声時計の凍結検知（pauseFromFreeze）から
   * ここへ来る。端スワイプ等の「戻る」は履歴ガード側（game-main.ts）が
   * 無効化だけを行い、ここへは来ない。
   */
  pause(): void {
    if (!this.playing || this.session.paused) return;
    this.session.capturePause(nowSeconds());
    this.input.resetInput();
    stopCurrent();
    stopAllHoldSounds();
    setData('game', 'paused');
    this.cb.onPause(true);
  }

  /**
   * 音声時計の凍結を検知したときのポーズ（オーナー決定 2026-11-24）。
   * 即座に打ち切らず、通常の中断確認と同じカードを出す。時計が復帰しない
   * ままの打ち切りは、ループ側の最後の手段（FREEZE_PAUSE_ABORT_MS）が担う。
   */
  private pauseFromFreeze(): void {
    this.session.markFreezePause();
    this.pause();
  }

  /**
   * 確認カードの「はじめからやりなおす」（オーナー指示 2026-11-22）。確認は挟まず、
   * カードを閉じて同じ曲・難易度・設定のまま start し直す。
   */
  restart(): void {
    if (!this.playing || !this.session.paused || this.session.pausePhase !== 'confirm' || !this.entry) return;
    const entry = this.entry;
    this.cb.onPause(false);
    void this.start(entry, this.difficulty, this.offsetMs, this.autoplay, this.speed);
  }

  /** 確認カードの「つづける」。カードを閉じ、READY（1秒）をはさんで再開する */
  resume(): void {
    if (!this.playing || !this.session.paused || this.session.pausePhase !== 'confirm') return;
    this.session.pausePhase = 'countdown';
    this.session.resumeDueWall = performance.now() + RESUME_COUNTDOWN_MS;
    this.cb.onPause(false);
  }

  /** READY が明けたら、凍結した位置から曲を鳴らし直して時計を引き継ぐ */
  private finishResume(): void {
    const buf = this.session.songBuf;
    if (!buf || !this.entry) {
      this.abort();
      return;
    }
    const now = nowSeconds();
    const pos = this.session.pausePosSec;
    playBuffer(buf, Math.max(now, now - pos), Math.max(0, pos));
    this.session.resumeClock(now - pos);
    this.lastFrameAt = this.session.clockSeenAt;
    this.session.paused = false;
    setData('game', 'playing');
  }

  /** 中断確認で凍結中か */
  get isPaused(): boolean {
    return this.session.paused;
  }

  /** デバッグ用: いまの成績で結果画面へ進む */
  finishNow(): void {
    if (this.playing && !this.session.paused) this.finish();
  }

  /** 押下リセット時に、保持中の長押しを「離した」扱いにして猶予へ移す */
  private releaseAllHolds(): void {
    if (!this.playing) return;
    const nowMs = (nowSeconds() - this.session.startAt) * 1000;
    for (const n of this.activeHolds) {
      if (n.holdPhase === 'holding') {
        releaseHold(n, nowMs);
        stopHoldSound(n);
      }
    }
  }

  /** 判定探し用のノーツ列（昇順なら判定窓のスライス、そうでなければ全譜面） */
  private judgeNotes(nowMs: number): PlayNote[] {
    if (!this.notesSorted) return this.notes;
    const win = judgeWindow(this.notes, nowMs);
    return this.notes.slice(win.start, win.end);
  }

  private pressLane(lane: number, rippleX?: number, rippleY?: number, viaKeyboard = false): void {
    // 保険: 再生中に AudioContext が止まっていたら（iOS の interrupted など）、タップのついでに戻す。
    if (audioContext().state !== 'running' || this.session.audioFrozen) unlockAudio();
    this.effects.laneTapFx(this.renderer, lane, rippleX, rippleY);
    const nowMs = (nowSeconds() - this.session.startAt) * 1000;
    // 猶予（grace）中の長押しがあれば、新しいノーツより先に押し直しとして扱う
    for (const n of this.activeHolds) {
      if (n.lane === lane && n.holdPhase === 'grace' && repressHold(n, nowMs)) {
        // 連打を再開する（ピッチの上がり具合は経過分の progress で引き継ぐ）
        const progress = Math.min(1, Math.max(0, (nowMs - n.timeMs) / Math.max(1, n.holdMs)));
        startHoldSound(n, comboTier(this.combo), n.timeMs + n.holdMs - nowMs, progress, this.entry?.data.bpm ?? 120);
        return;
      }
    }
    // いちばん近い未判定ノーツがフリックノーツなら、この押しはフリック操作の
    // 始まりとして扱い、タップ判定も空振り音も出さない（フリック必須）。
    // キーボードだけは例外: フリックノーツも通常のタップと同じキー押しで取る。
    const candidates = this.judgeNotes(nowMs);
    if (!viaKeyboard && findNearestNote(candidates, lane, nowMs)?.flick) return;
    const hit = viaKeyboard ? findKeyboardHit(candidates, lane, nowMs) : findHit(candidates, lane, nowMs);
    if (!hit) {
      // ノーツのないレーンを押したときも、ヒット音とは別の小さな音で「触れた」ことを返す
      playEmptySound();
      return;
    }
    this.hitNote(hit.note, hit.judge, nowMs);
  }

  /** フリック入力: フリックノーツ優先、無ければ通常のタップノーツを取る（findFlickHit） */
  private flickLane(lane: number, rippleX?: number, rippleY?: number): void {
    if (audioContext().state !== 'running' || this.session.audioFrozen) unlockAudio();
    this.effects.laneTapFx(this.renderer, lane, rippleX, rippleY);
    const nowMs = (nowSeconds() - this.session.startAt) * 1000;
    const hit = findFlickHit(this.judgeNotes(nowMs), lane, nowMs);
    if (!hit) {
      playEmptySound();
      return;
    }
    this.hitNote(hit.note, hit.judge, nowMs);
  }

  /** ノーツ1つをヒットとして処理する（タップ入力とオートプレイで共用） */
  private hitNote(note: PlayNote, judge: HeadJudge, nowMs: number): void {
    note.state = 1;
    const lane = note.lane;
    this.score += scoreFor(judge);
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    // コンボ tier で演出とヒット音が派手になる
    const tier = comboTier(this.combo);
    this.effects.showJudge(judge, tier, nowSeconds());
    const level: 0 | 1 | 2 = judge === 'perfect' ? 0 : judge === 'great' ? 1 : 2;
    this.effects.burst(this.renderer, lane, level, tier);
    if (note.flick) {
      // フリックノーツは専用の音と演出にする
      playFlickSound(judge, tier);
      this.effects.flickBurst(this.renderer, lane, level, tier);
    } else {
      playHitSound(judge, tier);
    }
    vibrateHit(judge);
    this.syncCombo();
    if (isComboShow(this.combo)) this.triggerComboShow(this.combo);
    if (note.holdMs > 0) {
      // 長押し: 集計（PERFECT等への加算）は押し切ったときに頭の判定で行う。コンボは頭で増やす
      beginHold(note, judge, 60000 / (this.entry?.data.bpm ?? 120));
      this.activeHolds.add(note);
      // ヒット音の連打を頭のヒットと同時に鳴らし始める（間隔は曲の BPM の16分音符）
      const progress = Math.min(1, Math.max(0, (nowMs - note.timeMs) / Math.max(1, note.holdMs)));
      startHoldSound(note, tier, note.timeMs + note.holdMs - nowMs, progress, this.entry?.data.bpm ?? 120);
    } else {
      this.counts[judge]++;
      this.life = applyLifeDelta(this.life, judge);
    }
    setData('score', this.score);
    // ライフが尽きたらゲームオーバー
    this.checkGameOver();
  }

  /**
   * オートプレイ: 時刻の来たノーツを PERFECT で自動処理する。
   * 長押しは頭を押したまま（離す処理が入らない）ので、advanceHold が尾で完走させる。
   * 昇順の譜面では処理カーソル（autoIdx）で前方向にだけ進む（単位F）。
   */
  private autoPlay(nowMs: number): void {
    const lw = this.renderer.laneW();
    const hitOne = (n: PlayNote): void => {
      this.effects.flash[n.lane] = 1;
      this.effects.ripples.push({
        x: this.renderer.laneX(n.lane) + lw / 2,
        y: this.renderer.hitY(),
        age: 0,
        life: RIPPLE_LIFE,
        c: LANE_COLORS[n.lane],
      });
      if (this.effects.ripples.length > 24) this.effects.ripples.shift();
      this.hitNote(n, 'perfect', nowMs);
    };
    if (this.notesSorted) {
      while (this.autoIdx < this.notes.length && this.notes[this.autoIdx].timeMs <= nowMs) {
        const n = this.notes[this.autoIdx];
        this.autoIdx++;
        if (n.state !== 0) continue;
        hitOne(n);
      }
      return;
    }
    for (const n of this.notes) {
      if (n.timeMs - nowMs > 0) break;
      if (n.state !== 0) continue;
      hitOne(n);
    }
  }

  /** レーンを離した。まだ他の入力で押されていなければ、長押しを猶予に入れる */
  private releaseLane(lane: number): void {
    if (this.input.lanePressed(lane)) return;
    const nowMs = (nowSeconds() - this.session.startAt) * 1000;
    for (const n of this.activeHolds) {
      if (n.lane === lane && n.holdPhase === 'holding') {
        releaseHold(n, nowMs);
        // 離したら連打は即座に止める（押し直せば再開する）
        stopHoldSound(n);
      }
    }
  }

  /**
   * コンボ演出の登場（30コンボごと）。パターンとズームは logic の comboAppearance が決める。
   * 絵は Canvas の背景として敷き（描画は renderer 側）、紙吹雪も Canvas 側で出す。
   * セリフの表示だけ main.ts 側（onComboShow）に任せる。
   */
  private triggerComboShow(combo: number): void {
    const appearance = comboAppearance(combo, this.effects.comboShowCount, COMBO_SHOW_CONFIG);
    if (!appearance) return;
    this.effects.comboShowCount++;
    setData('comboShow', combo);
    setData('comboPattern', appearance.pattern);
    setData('comboZoom', appearance.zoom);
    this.effects.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.effects.comboBg = { pattern: appearance.pattern, zoom: appearance.zoom, big: appearance.big, shownAt: nowSeconds() };
    // 初回の登場で読み込み待ちにならないよう、絵はここでも先読みしておく
    comboBgImage(appearance.pattern);
    this.effects.confetti(this.renderer, appearance.big);
    this.cb.onComboShow(combo, appearance);
  }

  /** コンボと tier をテスト用の入口（data 属性）へ出す */
  private syncCombo(): void {
    setData('combo', this.combo);
    setData('comboTier', comboTier(this.combo));
  }

  /** テスト/撮影用: コンボ数を直接セットする（30の倍数ならコンボ演出も登場する） */
  debugSetCombo(n: number): void {
    this.combo = Math.max(0, Math.floor(n));
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.syncCombo();
    if (isComboShow(this.combo)) this.triggerComboShow(this.combo);
  }

  private finish(failed = false): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    stopCurrent();
    stopAllHoldSounds();
    const acc = accuracy(this.counts);
    setData('game', 'result');
    this.cb.onFinish({
      songTitle: this.entry?.data.title ?? '',
      difficulty: this.difficulty,
      score: this.score,
      counts: { ...this.counts },
      maxCombo: this.maxCombo,
      accuracy: acc,
      rank: rankFor(acc),
      autoplay: this.autoplay,
      failed,
    });
  }

  /**
   * ゲームオーバーの発動チェック（ライフ制）。ライフが 0 になったらその場で
   * 演奏を終了する。発動して終了させたときだけ true を返す。
   * オートプレイでは発動しない。中断中は対象にしない。
   */
  private checkGameOver(): boolean {
    if (this.autoplay || this.session.paused || !this.playing) return false;
    if (!isLifeGameOver(this.life)) return false;
    this.finish(true);
    return true;
  }

  /** ミス掃除。昇順の譜面ではカーソル位置から前方向だけを見る（単位F） */
  private sweep(nowMs: number): number {
    if (!this.notesSorted) return sweepMisses(this.notes, nowMs);
    let missed = 0;
    while (this.sweepIdx < this.notes.length && nowMs - this.notes[this.sweepIdx].timeMs > JUDGE_WINDOWS.good) {
      const n = this.notes[this.sweepIdx];
      this.sweepIdx++;
      if (n.state === 0) {
        n.state = 2;
        missed++;
      }
    }
    return missed;
  }

  private loop = (): void => {
    if (!this.playing) return;
    const renderer = this.renderer;
    const session = this.session;
    const effects = this.effects;
    renderer.fit();
    const frameAt = nowSeconds();
    // 中断確認の「つづける」後の READY が明けたら、このフレームから再開する
    if (session.paused && session.pausePhase === 'countdown' && performance.now() >= session.resumeDueWall) {
      this.finishResume();
    }
    const isPaused = session.paused;
    // 前面にいるのに AudioContext が止まっている（iOS の割り込み＝着信等）と、
    // ゲームの時計が凍って READY や譜面が止まったままになる。1秒に1回だけ
    // resume を試みて復帰させる（間引きは壁時計で数える）
    if (audioContext().state !== 'running') {
      const wall = performance.now();
      if (wall - session.lastResumeTryWall > 1000) {
        session.lastResumeTryWall = wall;
        void resumeAudio();
      }
    }
    // 時計の凍結検知: 音声時計が壁時計で 1.5 秒以上進んでいなければ「止まっている」とみなす
    const frozen = session.detectFreeze(frameAt);
    if (session.paused) {
      // ポーズ中は凍結検知の対象外（オーナー決定 2026-11-24）。ただし凍結が原因の
      // ポーズに限り、時計が復帰しないまま猶予を超えたら最後の手段として
      // 音声の仕組みを作り直してメニューへ戻す。手動ポーズは対象外
      if (session.freezeAbortDue(frozen)) {
        this.input.resetInput();
        recreateAudioContext();
        this.abort();
        return;
      }
    } else if (frozen) {
      const posSec = frameAt - session.startAt;
      if (posSec > 0.1 || session.readyReinitUsed) {
        // 演奏が始まった後の凍結は、即座に打ち切らずまずポーズする（オーナー決定
        // 2026-11-24）。ここで return してはならない（rAF 再予約が飛ぶため）
        this.pauseFromFreeze();
      } else {
        // READY 中の凍結は、開始そのものを初期化し直す（曲はまだ始まっていない）
        void this.reinitStart();
      }
    }
    // 経過時間（秒）。タブ復帰などで大きく飛んだときは 50ms に丸める。
    // 凍結中は時刻を止めた位置に固定し、演出の経過時間も進めない
    const dt = isPaused ? 0 : Math.min(0.05, Math.max(0, frameAt - this.lastFrameAt));
    this.lastFrameAt = frameAt;
    const nowSec = isPaused ? session.pausePosSec : frameAt - session.startAt;
    const nowMs = nowSec * 1000;
    // このフレームのコンボ段階。上がった瞬間は tierFlash を立てる
    const tier = effects.updateTier(this.combo, dt);
    // 実効の落下時間は、難易度の基準値にプレイヤー設定の速度倍率を重ねたもの
    const fall = effectiveFallSeconds(DIFFICULTIES[this.difficulty].fallSeconds, this.speed);

    // 歌詞の現在行が変わったら通知する（表示は main.ts 側の DOM）
    const li = lyricIndexAt(this.entry?.lyrics ?? [], nowMs);
    if (!isPaused && li !== this.lyricIndex) {
      this.lyricIndex = li;
      setData('lyricIndex', li);
      this.cb.onLyric(li);
    }

    // オートプレイ中は、ミス掃除より先に時刻の来たノーツを PERFECT で処理する
    if (this.autoplay && !isPaused) this.autoPlay(nowMs);

    const missed = isPaused ? 0 : this.sweep(nowMs);
    if (missed > 0) {
      this.counts.miss += missed;
      this.life = applyLifeDelta(this.life, 'miss', missed);
      this.combo = 0; // コンボが切れたら tier も 0 に戻り、演出は素に戻る
      effects.showJudge('miss', 0, nowSeconds());
      this.syncCombo();
      // ミス音はこの掃除で1回だけ（複数ノーツ同時ミスでも重ねない）
      playMissSound();
      // ライフが尽きたら、そのフレームでゲームオーバーにして打ち切る
      if (this.checkGameOver()) return;
    }

    // 長押しの進行: tick スコア、押し切ったら頭の判定で集計＋ボーナス＋完走音、
    // 失敗はミス＋失敗音。対象は進行中の長押しの集合だけ（単位F）
    for (const n of this.activeHolds) {
      if (isPaused) break;
      if (n.holdPhase !== 'holding' && n.holdPhase !== 'grace') continue;
      const ev = advanceHold(n, nowMs);
      if (ev.ticks > 0) {
        this.score += ev.ticks * HOLD_TICK_SCORE;
        setData('score', this.score);
      }
      if (ev.completed && n.headJudge) {
        this.activeHolds.delete(n);
        this.counts[n.headJudge]++;
        this.life = applyLifeDelta(this.life, n.headJudge);
        this.score += HOLD_COMPLETE_BONUS[n.headJudge];
        this.holdsCompleted++;
        setData('holdsCompleted', this.holdsCompleted);
        setData('score', this.score);
        // 連打は尾の時刻ちょうどで止め、完走音へつなぐ
        stopHoldSound(n);
        playCompleteSound(n.headJudge, comboTier(this.combo));
        effects.burst(
          this.renderer,
          n.lane,
          n.headJudge === 'perfect' ? 0 : n.headJudge === 'great' ? 1 : 2,
          comboTier(this.combo),
        );
      }
      if (ev.failed) {
        this.activeHolds.delete(n);
        this.counts.miss++;
        this.life = applyLifeDelta(this.life, 'miss');
        this.combo = 0;
        effects.showJudge('miss', 0, nowSeconds());
        this.syncCombo();
        this.holdsFailed++;
        setData('holdsFailed', this.holdsFailed);
        stopHoldSound(n);
        // MISS の合図としてミス音も鳴らす（失敗音と役割が違うので両方鳴る）
        playMissSound();
        playFailSound();
      }
    }
    // 長押しの成否でライフが動いた直後にも、ゲームオーバーのチェックをする
    if (this.checkGameOver()) return;

    // 描画・掃除の対象ウィンドウ（単位F）。昇順でない譜面では全範囲
    const win = this.notesSorted
      ? noteWindow(this.notes, nowMs, fall * 1000, this.maxHoldMs)
      : { start: 0, end: this.notes.length };
    const holdingLanes = new Set<number>();
    for (const n of this.activeHolds) if (n.holdPhase === 'holding') holdingLanes.add(n.lane);

    renderer.drawStage(effects, tier, frameAt, dt, holdingLanes);
    renderer.drawNotes(this.notes, win, nowMs, fall, frameAt);
    effects.drawEffects(renderer.notesContext, renderer, dt);
    renderer.drawHud(effects, {
      nowSec,
      isPaused,
      pausePhase: session.pausePhase,
      audioFrozen: session.audioFrozen,
      combo: this.combo,
      tier,
      score: this.score,
      life: this.life,
      durationSec: this.durationSec,
      frameAt,
    });

    if ((nowMs > this.durationSec * 1000 + 500 && this.notes.every((n) => n.state !== 0)) || nowMs > this.durationSec * 1000 + 2000) {
      this.finish();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}
