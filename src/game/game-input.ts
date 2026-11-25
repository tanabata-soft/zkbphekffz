// 入力（単位Fで game.ts から分離）。
// ポインタ（マルチタッチ＋フリックジェスチャ）・キーボード・visibility /
// pagehide / blur / focus の DOM イベント登録と、押下状態の保持だけを持つ。
// 判定やポーズの実処理はフック（GameInputHooks）越しに Game 本体へ委ねる。
// 挙動は分離前と同一。
import { FLICK_MIN_UP_PX, FLICK_TIME_LIMIT_MS } from './logic';
import { resumeAudio } from './audio';
import type { LaneGeometry } from './game-effects';

/** 中断ボタンの当たり判定（描画と共有。中心と半径） */
export const PAUSE_BTN = { cx: 30, cy: 29, r: 20 };

export interface GameInputHooks {
  isPlaying(): boolean;
  isPaused(): boolean;
  isAutoplay(): boolean;
  /** 中断ボタン・Esc・アプリ切替からのポーズ */
  pause(): void;
  pressLane(lane: number, rippleX?: number, rippleY?: number, viaKeyboard?: boolean): void;
  flickLane(lane: number, rippleX?: number, rippleY?: number): void;
  releaseLane(lane: number): void;
  /** 押下リセット時に保持中の長押しを「離した」扱いにする */
  releaseAllHolds(): void;
}

export class GameInput {
  /** 押さえ中のポインタ（pointerId → レーン）。マルチタッチで長押ししながら他レーンを叩ける */
  pointerLanes = new Map<number, number>();
  /** フリック検出用の、ポインタごとの押し始めの記録（位置・壁時計・発火済みか） */
  pointerGestures = new Map<number, { startY: number; startWall: number; flicked: boolean }>();
  /** 押さえ中のキー（レーン） */
  keyLanes = new Set<number>();

  private canvas: HTMLCanvasElement;
  private hooks: GameInputHooks;
  private geom: LaneGeometry & { laneAt(px: number): number };

  constructor(
    canvas: HTMLCanvasElement,
    geom: LaneGeometry & { laneAt(px: number): number },
    hooks: GameInputHooks,
  ) {
    this.canvas = canvas;
    this.geom = geom;
    this.hooks = hooks;
  }

  attach(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
  }

  detach(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
  }

  /** レーンが今も押されているか（ポインタ・キーのどちらか） */
  lanePressed(lane: number): boolean {
    if (this.keyLanes.has(lane)) return true;
    for (const l of this.pointerLanes.values()) if (l === lane) return true;
    return false;
  }

  clearPressed(): void {
    this.pointerLanes.clear();
    this.pointerGestures.clear();
    this.keyLanes.clear();
  }

  /**
   * 押下状態（ポインタ・キー）をすべてリセットする。バックグラウンド遷移や
   * フォーカス喪失で pointerup / keyup を取りこぼしたときに、押されたままの
   * 状態が残って入力が固まったように見えるのを防ぐ。
   * 保持中の長押しはフック越しに「離した」扱いにして猶予（grace）へ移すので、
   * リセット自体でいきなり失敗にはならない。
   */
  resetInput(): void {
    this.clearPressed();
    this.hooks.releaseAllHolds();
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (!this.hooks.isPlaying() || this.hooks.isPaused()) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // 中断ボタンは丸ボタン: 中心からの距離が半径以内なら当たったことにする
    const pdx = px - PAUSE_BTN.cx;
    const pdy = py - PAUSE_BTN.cy;
    if (pdx * pdx + pdy * pdy <= PAUSE_BTN.r * PAUSE_BTN.r) {
      this.hooks.pause();
      return;
    }
    // オートプレイ中はタップ入力を受け付けない（左上の中断だけ従来どおり効く）
    if (this.hooks.isAutoplay()) return;
    const lane = this.geom.laneAt(px);
    // 両脇の余白は無反応地帯: 押したことにも、ジェスチャの始点にもしない
    if (lane < 0) return;
    this.pointerLanes.set(e.pointerId, lane);
    this.pointerGestures.set(e.pointerId, { startY: py, startWall: performance.now(), flicked: false });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // キャプチャできなくてもプレイは続行する
    }
    this.hooks.pressLane(lane, px, py);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hooks.isPlaying()) return;
    const prev = this.pointerLanes.get(e.pointerId);
    if (prev === undefined) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // フリック検出: 押し始めから短時間に、上へ大きく動いたらフリックとして発火する
    // （ポインタごとに1回まで）。縦の動きは基本は同じレーン内で起きる
    const gesture = this.pointerGestures.get(e.pointerId);
    if (
      gesture &&
      prev >= 0 &&
      !gesture.flicked &&
      !this.hooks.isPaused() &&
      gesture.startY - py >= FLICK_MIN_UP_PX &&
      performance.now() - gesture.startWall <= FLICK_TIME_LIMIT_MS
    ) {
      gesture.flicked = true;
      this.hooks.flickLane(prev, px, py);
      return;
    }
    const lane = this.geom.laneAt(px);
    if (lane === prev) return;
    // 指がレーンをまたいだら、旧レーンは離した扱い、新レーンは押した扱いにする。
    // 余白（-1）へ出たら離した扱いだけにして、余白から戻ったら押し直しとして扱う
    if (prev >= 0) this.hooks.releaseLane(prev);
    this.pointerLanes.set(e.pointerId, lane);
    if (lane >= 0) this.hooks.pressLane(lane, px, py);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const lane = this.pointerLanes.get(e.pointerId);
    this.pointerGestures.delete(e.pointerId);
    if (lane === undefined) return;
    this.pointerLanes.delete(e.pointerId);
    if (this.hooks.isPlaying() && lane >= 0) this.hooks.releaseLane(lane);
  };

  private onLostPointerCapture = (e: PointerEvent): void => {
    // ポインタ捕捉が強制的に外れたとき（バックグラウンド遷移など）は、
    // pointerup が来ないことがある。捕捉を失った時点で「離した」扱いにする
    const lane = this.pointerLanes.get(e.pointerId);
    this.pointerGestures.delete(e.pointerId);
    if (lane === undefined) return;
    this.pointerLanes.delete(e.pointerId);
    if (this.hooks.isPlaying() && lane >= 0) this.hooks.releaseLane(lane);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.hooks.isPlaying() && !this.hooks.isPaused()) {
      this.hooks.pause();
      return;
    }
    if (!this.hooks.isPlaying() || this.hooks.isPaused() || e.repeat || this.hooks.isAutoplay()) return;
    const lane = 'dfjk'.indexOf(e.key.toLowerCase());
    if (lane < 0) return;
    this.keyLanes.add(lane);
    this.hooks.pressLane(lane, undefined, undefined, true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const lane = 'dfjk'.indexOf(e.key.toLowerCase());
    if (lane < 0) return;
    this.keyLanes.delete(lane);
    if (this.hooks.isPlaying()) this.hooks.releaseLane(lane);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      // プレイ中に画面が隠れたら、演奏を凍結して中断確認を出しておく（オーナー指示
      // 2026-11-21、案1）。pause() の中で押下状態もリセットする
      this.hooks.pause();
    } else {
      // 前面に戻ったら、止まっている AudioContext を起こす
      void resumeAudio();
    }
  };

  private onPageHide = (): void => {
    // 画面ロックなど、visibilitychange が届かない経路でも演奏を凍結する
    this.hooks.pause();
  };

  private onBlur = (): void => {
    // フォーカスを失ったら押下状態だけリセットする（演奏の中断は visibility / pagehide に任せる）
    this.resetInput();
  };

  private onFocus = (): void => {
    // 復帰時に AudioContext の resume を確実に行う
    void resumeAudio();
  };
}
