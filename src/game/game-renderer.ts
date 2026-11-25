// 描画（単位Fで game.ts から分離）。
// 2枚の Canvas（背景・レーン側と、歌詞 DOM より手前に重ねるノーツ専用側）、
// レーン形状、ジャケット背景の事前描画キャッシュ（単位E）、ビジュアライザー、
// ステージ／ノーツ／HUD の描画だけを持つ。判定・時計は持たない。
// 描画順と見え方は分離前と同一。
import {
  HIT_Y_RATIO,
  LANE_COLORS,
  LIFE_MAX,
  VISUALIZER_FREQ_BARS,
  groupFreqBins,
  lifeZone,
  tierFx,
  type ComboZoom,
} from './logic';
import { musicAnalyser } from './audio';
import {
  COMBO_BG_DURATION_BIG_SEC,
  COMBO_BG_DURATION_SEC,
  JUDGE_LIFE,
  comboBgImage,
  type GameEffects,
  type LaneGeometry,
} from './game-effects';
import { PAUSE_BTN } from './game-input';
import type { NoteWindow } from './game-window';
import type { PlayNote } from './logic';

/**
 * ゲームキャンバスの devicePixelRatio 上限（単位E、オーナー決定 2026-11-25）。
 * DPR 無制限だと DPR3 端末で 9 倍のピクセルを毎フレーム描くため、上限を 1 にする。
 * 見え方の最終判断はオーナーの実機確認。2 に戻す場合はこの定数だけを変更する。
 */
export const MAX_DPR = 1;
/**
 * レーン領域の片側余白（画面／ステージ幅に対する比率。390px 幅で片側約20px）。
 * 画面端の操作（iOS の左端スワイプ、Android のジェスチャナビゲーション等）の
 * 誤爆を元から減らすため、レーンを画面端から離す（オーナー決定 2026-11-24）。
 * 余白は無反応地帯（タッチしても入力にならない）。全端末共通のレイアウト
 */
export const LANE_MARGIN_RATIO = 20 / 390;

/** スコアのフォント（描画と、メーターの横幅を決める実測で共有する） */
const SCORE_FONT = 'bold 18px sans-serif';
/** スコアの baseline（上部1行の中心 = PAUSE_BTN.cy に文字が揃う位置） */
const SCORE_BASELINE_Y = 35;

/** ライフの帯ごとの色（十分=緑 / 注意=黄 / 危険=赤） */
const LIFE_COLORS: Record<'safe' | 'caution' | 'danger', string> = { safe: '#3ddc84', caution: '#ffd23f', danger: '#ff5252' };
/**
 * ライフメーターの置き場所（座標はステージ内）。v1.4.9 の上部 UI 見直しで、
 * 中断ボタン・スコアと同じ1行（中心 y = PAUSE_BTN.cy）に集約し、背景パネルは撤去した。
 * バーは中断ボタンの右から、右端のスコアの左に収まる幅で引く。
 */
const LIFE_METER = { meterX: 62, meterY: 25, meterH: 8, scoreGap: 10, edgeGap: 14 };

/** コンボ段階ごとのベール（暗幕）の濃さ。段階が上がるほど薄くなり、ジャケットが冴える */
const TIER_VEIL_ALPHA = [0.62, 0.57, 0.52, 0.46, 0.4] as const;
/** ベールの fillStyle 文字列（毎フレームの文字列生成を避けるため事前計算。単位E） */
const TIER_VEIL_FILL: readonly string[] = TIER_VEIL_ALPHA.map((a) => `rgba(6,8,16,${a.toFixed(2)})`);

/** コンボ段階ごとの画面の縁の光（tier 0 はなし）。色は TIER_FX の comboColor と揃える */
const TIER_EDGE: ({ rgb: string; alpha: number; width: number } | null)[] = [
  null,
  { rgb: '165,243,252', alpha: 0.3, width: 3 },
  { rgb: '78,205,196', alpha: 0.42, width: 4 },
  { rgb: '255,209,102', alpha: 0.55, width: 5 },
  { rgb: '255,138,216', alpha: 0.7, width: 6 },
];

/**
 * コンボ演出の背景の不透明度のピーク（通常・big とも 1.0）。
 * 絵はあくまで背景として描かれ、レーン・ノーツ・判定はその後にフル不透明度で
 * 描くので、背景が絵に完全に置き換わってもプレイの視認性は構造的に保たれる。
 */
const COMBO_BG_PEAK_ALPHA = 1;
/**
 * コンボ演出の背景の上に敷く暗幕の濃さ（ピーク時）。明るい絵では白いレーン線
 * （不透明度 .12）が埋もれるため、表示中だけ最小限の暗幕を入れる。
 */
const COMBO_BG_VEIL_ALPHA = 0.18;
/**
 * コンボ演出の背景の包絡（秒）: フェードイン → ピークのままキープ → フェードアウト。
 * 入り方は包絡に smoothstep をかけて「ふわっと」させる。
 */
const COMBO_BG_FADE_IN_SEC = 0.9;
const COMBO_BG_FADE_OUT_SEC = 0.8;
/** 0→1 を両端でなだらかにする（ふわっとしたフェードの包絡用） */
const smoothstep = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
/**
 * 背景の中での push-in（奥から近づくズーム）。種別ごとに寄る速さと幅を変える。
 * power は ease-out の強さ（大きいほど最初に速く寄る）。
 */
const COMBO_BG_ZOOM: Record<ComboZoom, { from: number; to: number; power: number }> = {
  standard: { from: 0.92, to: 1.06, power: 2 },
  fast: { from: 0.9, to: 1.08, power: 3 },
  cinematic: { from: 0.96, to: 1.03, power: 1 },
};

// ---- オーディオビジュアライザー（プレイ画面の下部スペース） ----
// スタイルは周波数バー固定（オーナー決定 2026-11-23）。領域・色味は分離前と同一。
/** 周波数バー: 下端→上端のグラデーション（彩度・明度を落としたティール） */
const VIZ_BAR_BOTTOM = '#26525b';
const VIZ_BAR_TOP = '#4f7a82';
/** 周波数バー本体の不透明度（0..1） */
const VIZ_BAR_ALPHA = 165 / 255;
/** 周波数バーの上端キャップの不透明度（0..1） */
const VIZ_BAR_CAP_ALPHA = 180 / 255;

/** フリック表示は大きなブロック矢印（↑）だけ（オーナー決定 2026-11-23、確定仕様） */
/** 矢印の高さ (px) */
const FLICK_ARROW_HEIGHT = 60;
/** 矢印の縁取り色（ほぼ黒に近い紺） */
const FLICK_ARROW_OUTLINE_COLOR = '#0a1030';
/** 矢印の縁取りの太さ (px)。脈動の位相によらず画面上でこの太さに保つ */
const FLICK_ARROW_OUTLINE_WIDTH = 5;
/** 矢印の脈動: 周期（秒）と最大拡縮率（1.0〜この値の間を sin で往復する） */
const FLICK_ARROW_PULSE_PERIOD_SEC = 0.85;
const FLICK_ARROW_PULSE_MAX = 1.15;

export class GameRenderer implements LaneGeometry {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** ノーツ専用キャンバス（歌詞 DOM より手前に重ねるため分離） */
  private notesCanvas: HTMLCanvasElement;
  private gn: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private bg: HTMLImageElement | null = null;
  /** ジャケット切り抜き量（charts.ts の frameInset） */
  private frameInset = 0;
  /** ジャケット背景の事前描画キャッシュ（単位E）。曲開始・リサイズ・画像読込完了で作り直す */
  private bgCache: HTMLCanvasElement | null = null;
  private bgCacheW = 0;
  private bgCacheH = 0;
  private bgCacheSrc: HTMLImageElement | null = null;
  /** ビジュアライザーのグラデーションキャッシュ（単位E） */
  private vizGrad: CanvasGradient | null = null;
  private vizGradY0 = NaN;
  private vizGradY1 = NaN;
  /** スコア文字列と実測幅のキャッシュ（単位E。スコアが変わったときだけ作り直す） */
  private scoreTextCache = '';
  private scoreValueCache = -1;
  private scoreWidthCache = 0;
  // ビジュアライザーの解析データの使い回しバッファと、取得の間引きカウンタ
  // （2フレームに1回だけ取る）
  private vizFreq: Uint8Array<ArrayBuffer> | null = null;
  private vizFrame = 0;

  constructor(canvas: HTMLCanvasElement, notesCanvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas が使えません');
    this.g = g;
    this.notesCanvas = notesCanvas;
    const gn = notesCanvas.getContext('2d');
    if (!gn) throw new Error('Canvas が使えません');
    this.gn = gn;
  }

  /** 判定ラインの y 座標（px）。タッチ位置「上」固定（H×0.74） */
  hitY(): number {
    return this.height * HIT_Y_RATIO;
  }

  /** レーン領域の左端 x（px）。両脇の余白は無反応地帯 */
  laneAreaX(): number {
    return this.width * LANE_MARGIN_RATIO;
  }

  /** 1レーンの幅（px） */
  laneW(): number {
    return (this.width - this.laneAreaX() * 2) / 4;
  }

  /** レーンの左端 x（px） */
  laneX(lane: number): number {
    return this.laneAreaX() + lane * this.laneW();
  }

  /** x 座標からレーン番号を引く。余白（無反応地帯）では -1 */
  laneAt(px: number): number {
    const x0 = this.laneAreaX();
    if (px < x0 || px >= this.width - x0) return -1;
    return Math.floor((px - x0) / this.laneW());
  }

  /** ジャケット背景の差し替え（null で外す。start の冒頭の残像消し用） */
  setJacket(img: HTMLImageElement | null, frameInset = 0): void {
    this.bg = img;
    this.frameInset = frameInset;
    this.bgCache = null;
    this.bgCacheSrc = null;
  }

  get jacketReady(): boolean {
    return !!this.bg?.complete && !!this.bg.naturalWidth;
  }

  /** 両キャンバスを地の色に戻す（start の冒頭で、前の演奏の残像を消すため） */
  clearCanvases(): void {
    const { g, gn } = this;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0e1018';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
    gn.save();
    gn.setTransform(1, 0, 0, 1, 0, 0);
    gn.clearRect(0, 0, this.notesCanvas.width, this.notesCanvas.height);
    gn.restore();
  }

  fit(): void {
    const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w !== this.width || h !== this.height || this.canvas.width !== Math.round(w * d)) {
      this.width = w;
      this.height = h;
      this.canvas.width = Math.round(w * d);
      this.canvas.height = Math.round(h * d);
      this.g.setTransform(d, 0, 0, d, 0, 0);
      this.notesCanvas.width = Math.round(w * d);
      this.notesCanvas.height = Math.round(h * d);
      this.gn.setTransform(d, 0, 0, d, 0, 0);
      // サイズが変わったら背景キャッシュとグラデーションを作り直す
      this.bgCache = null;
      this.vizGrad = null;
    }
  }

  /** ジャケット背景をオフスクリーンへ事前描画する（単位E）。切り抜き＋下端フェードまで含む */
  private buildBgCache(W: number, H: number): HTMLCanvasElement | null {
    const img = this.bg;
    if (!img || !img.complete || !img.naturalWidth) return null;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const inset = Math.min(this.frameInset, iw / 4, ih / 4);
    const side = Math.min(W, H);
    const dx = (W - side) / 2;
    const cache = document.createElement('canvas');
    // キャッシュは実ピクセル（MAX_DPR 適用後）で作り、内部は CSS 単位で描く
    const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    cache.width = Math.max(1, Math.round(W * d));
    cache.height = Math.max(1, Math.round(H * d));
    const cg = cache.getContext('2d');
    if (!cg) return null;
    cg.setTransform(d, 0, 0, d, 0, 0);
    cg.drawImage(img, inset, inset, iw - inset * 2, ih - inset * 2, dx, 0, side, side);
    // 下端を下地へ溶かす
    const fadeH = side * 0.18;
    const grad = cg.createLinearGradient(0, side - fadeH, 0, side);
    grad.addColorStop(0, 'rgba(14,16,24,0)');
    grad.addColorStop(1, 'rgba(14,16,24,1)');
    cg.fillStyle = grad;
    cg.fillRect(dx, side - fadeH, side, fadeH);
    this.bgCache = cache;
    this.bgCacheW = W;
    this.bgCacheH = H;
    this.bgCacheSrc = img;
    return cache;
  }

  private drawJacketBackground(W: number, H: number): void {
    const img = this.bg;
    if (!img) return;
    let cache = this.bgCache;
    if (!cache || this.bgCacheW !== W || this.bgCacheH !== H || this.bgCacheSrc !== img) {
      cache = this.buildBgCache(W, H);
    }
    if (cache) this.g.drawImage(cache, 0, 0, W, H);
  }

  /** スコア文字列（7桁ゼロ埋め）のキャッシュ */
  private scoreText(score: number): string {
    if (this.scoreValueCache !== score) {
      this.scoreValueCache = score;
      this.scoreTextCache = String(score).padStart(7, '0');
      this.scoreWidthCache = 0;
    }
    return this.scoreTextCache;
  }

  /**
   * ライフメーター（演奏画面の上部に常時表示）。細いバー1本だけ：
   * fill の長さ = 現在のライフ、色 = ライフの帯。危険域では点滅させる。
   */
  private drawLifeMeter(g: CanvasRenderingContext2D, W: number, score: number, life: number): void {
    const M = LIFE_METER;
    // バーの右端は、右端のスコアに重ならない位置まで。
    g.font = SCORE_FONT;
    const scoreTxt = this.scoreText(score);
    if (!this.scoreWidthCache) this.scoreWidthCache = g.measureText(scoreTxt).width;
    const scoreW = this.scoreWidthCache;
    const barRight = W - M.edgeGap - scoreW - M.scoreGap;
    const mx = M.meterX;
    const mw = Math.max(0, barRight - mx);
    const zone = lifeZone(life);
    // バー: 暗いトラックの上に、現在のライフまでの fill を帯の色で引く
    g.beginPath();
    g.roundRect(mx, M.meterY, mw, M.meterH, M.meterH / 2);
    g.fillStyle = '#2a2f3a';
    g.fill();
    if (life > 0) {
      g.save();
      g.beginPath();
      g.roundRect(mx, M.meterY, mw, M.meterH, M.meterH / 2);
      g.clip();
      // 危険域は点滅させて「やばい」が読めるようにする（約0.35秒周期で明滅）
      if (zone === 'danger') g.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 110);
      g.fillStyle = LIFE_COLORS[zone];
      g.fillRect(mx, M.meterY, (mw * life) / LIFE_MAX, M.meterH);
      g.restore();
    }
  }

  /**
   * オーディオビジュアライザー: 判定枠の下の空き領域に、再生中の曲の周波数を
   * バーで描く（周波数バー固定）。取得は2フレームに1回（約30Hz）に間引く。
   */
  private drawVisualizer(g: CanvasRenderingContext2D, W: number, H: number): void {
    const analyser = musicAnalyser();
    if (!analyser) return;
    const x0 = (W * 58) / 390;
    const x1 = (W * 332) / 390;
    const y1 = H - (H * 6) / 844;
    const y0 = y1 - (H * 136) / 844;
    const bandH = y1 - y0;
    if (bandH < 40 || x1 - x0 < 80) return;

    if (!this.vizFreq || this.vizFreq.length !== analyser.frequencyBinCount) {
      this.vizFreq = new Uint8Array(analyser.frequencyBinCount);
    }
    const freq = this.vizFreq;
    if (!freq) return;
    this.vizFrame++;
    if (this.vizFrame % 2 === 1) {
      analyser.getByteFrequencyData(freq);
    }
    const sampleRate = analyser.context.sampleRate;

    // 周波数バー: 下端から伸びる。下→上のグラデーション＋上端のキャップ
    const vals = groupFreqBins(freq, VISUALIZER_FREQ_BARS, sampleRate);
    const slot = (x1 - x0) / vals.length;
    const bw = slot * 0.62;
    if (!this.vizGrad || this.vizGradY0 !== y0 || this.vizGradY1 !== y1) {
      const grad = g.createLinearGradient(0, y1, 0, y0);
      grad.addColorStop(0, VIZ_BAR_BOTTOM);
      grad.addColorStop(1, VIZ_BAR_TOP);
      this.vizGrad = grad;
      this.vizGradY0 = y0;
      this.vizGradY1 = y1;
    }
    const grad = this.vizGrad;
    for (let i = 0; i < vals.length; i++) {
      const h = Math.max(2, vals[i] * bandH * 0.92);
      const x = x0 + i * slot + (slot - bw) / 2;
      g.globalAlpha = VIZ_BAR_ALPHA;
      g.fillStyle = grad;
      g.fillRect(x, y1 - h, bw, h);
      g.globalAlpha = VIZ_BAR_CAP_ALPHA;
      g.fillStyle = VIZ_BAR_TOP;
      g.beginPath();
      g.roundRect(x, y1 - h, bw, 4, 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /**
   * ステージ描画: 地の色 → ジャケット背景 → ベール → コンボ演出の背景 →
   * ビジュアライザー → 縁の光 → レーンフラッシュ／区切り線 → 判定ライン →
   * 判定枠。ノーツと演出はこの後に drawNotes / drawEffects で重ねる。
   */
  drawStage(effects: GameEffects, tier: number, frameAt: number, dt: number, holdingLanes: ReadonlySet<number>): void {
    const g = this.g;
    const W = this.width;
    const H = this.height;
    g.fillStyle = '#0e1018';
    g.fillRect(0, 0, W, H);
    if (this.jacketReady) {
      this.drawJacketBackground(W, H);
    }
    // ベール（暗幕）はコンボ段階が上がるほど薄くし、ジャケットが冴えてくる
    g.fillStyle = TIER_VEIL_FILL[tier];
    g.fillRect(0, 0, W, H);
    // コンボ演出の登場中は、絵を背景として敷く。レーン・ノーツはこの後に描く。
    if (effects.comboBg) {
      const img = comboBgImage(effects.comboBg.pattern);
      const dur = effects.comboBg.big ? COMBO_BG_DURATION_BIG_SEC : COMBO_BG_DURATION_SEC;
      const elapsed = frameAt - effects.comboBg.shownAt;
      const t = elapsed / dur;
      if (t >= 1) {
        effects.comboBg = null;
      } else if (img && img.complete && img.naturalWidth) {
        // 包絡は smoothstep で両端をなだらかにし、ふわっと出入りする
        const env = Math.max(
          0,
          Math.min(smoothstep(elapsed / COMBO_BG_FADE_IN_SEC), smoothstep((dur - elapsed) / COMBO_BG_FADE_OUT_SEC), 1),
        );
        const zp = COMBO_BG_ZOOM[effects.comboBg.zoom];
        const eased = 1 - Math.pow(1 - t, zp.power);
        const zoom = effects.reducedMotion ? 1 : zp.from + (zp.to - zp.from) * eased;
        const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
        const w = img.naturalWidth * s;
        const hh = img.naturalHeight * s;
        g.globalAlpha = COMBO_BG_PEAK_ALPHA * env;
        g.drawImage(img, (W - w) / 2, (H - hh) / 2, w, hh);
        g.globalAlpha = 1;
        // 明るい絵の上でレーン線が埋もれないよう、表示中だけ薄い暗幕を敷く（包絡に連動）
        g.fillStyle = `rgba(5,6,12,${(COMBO_BG_VEIL_ALPHA * env).toFixed(3)})`;
        g.fillRect(0, 0, W, H);
      }
    }
    // ビジュアライザー（判定枠の下の空き領域）
    this.drawVisualizer(g, W, H);
    // 画面の縁の光: 段位が上がるほど強く・太くなる。上がった瞬間は tierFlash で光る
    const edge = TIER_EDGE[tier];
    if (edge) {
      const boost = effects.tierFlash * 0.3;
      g.strokeStyle = `rgba(${edge.rgb},${(edge.alpha * 0.35 + boost * 0.4).toFixed(3)})`;
      g.lineWidth = edge.width * 2.4;
      g.strokeRect(edge.width * 1.2, edge.width * 1.2, W - edge.width * 2.4, H - edge.width * 2.4);
      g.strokeStyle = `rgba(${edge.rgb},${Math.min(1, edge.alpha + boost).toFixed(3)})`;
      g.lineWidth = edge.width;
      g.strokeRect(edge.width / 2 + 1, edge.width / 2 + 1, W - edge.width - 2, H - edge.width - 2);
    }
    const lw = this.laneW();
    const hy = H * HIT_Y_RATIO;
    // このフレームの演出段階（コンボのみで決まる）。フラッシュとコンボ表示に使う
    const frameFx = tierFx(tier);
    for (let i = 0; i < 4; i++) {
      if (effects.flash[i] > 0) {
        const alpha = Math.min(200, Math.round(effects.flash[i] * 70 * frameFx.flashMul));
        g.fillStyle = LANE_COLORS[i] + alpha.toString(16).padStart(2, '0');
        g.fillRect(this.laneX(i), 0, lw, H);
        effects.flash[i] = Math.max(0, effects.flash[i] - dt * 3.6);
      }
      if (i) {
        g.fillStyle = 'rgba(255,255,255,.12)';
        g.fillRect(this.laneX(i) - 0.5, 0, 1, H);
      }
    }
    g.fillStyle = 'rgba(255,255,255,.85)';
    // 判定ラインはレーン領域の幅だけに引く（余白には伸ばさない）
    g.fillRect(this.laneAreaX(), hy - 2, lw * 4, 4);
    for (let i = 0; i < 4; i++) {
      g.strokeStyle = LANE_COLORS[i];
      g.lineWidth = 3;
      g.strokeRect(this.laneX(i) + 8, hy - 14, lw - 16, 28);
      if (holdingLanes.has(i)) {
        // 長押し中は判定枠を明るく太くして「押せている」ことを示す
        g.globalAlpha = 0.65 + 0.35 * Math.sin(frameAt * 9);
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.strokeRect(this.laneX(i) + 5, hy - 17, lw - 10, 34);
        g.globalAlpha = 1;
      }
    }
  }

  /**
   * ノーツ描画（ノーツ専用キャンバス）。対象はウィンドウ内のノーツだけ
   * （単位F）。ホールドの帯は、頭がウィンドウ外でも尾が範囲内なら
   * noteWindow の過去側余裕（最大ホールド長込み）で含まれている。
   */
  drawNotes(notes: readonly PlayNote[], win: NoteWindow, nowMs: number, fall: number, frameAt: number): void {
    const gn = this.gn;
    const W = this.width;
    const H = this.height;
    const lw = this.laneW();
    const hy = H * HIT_Y_RATIO;
    // ノーツ専用キャンバスは透明なので、毎フレーム消してから描く
    gn.clearRect(0, 0, W, H);
    // 長押しの帯（タップノーツより先に描く）。頭がラインに届いたら帯の下端はラインに吸着する
    for (let idx = win.start; idx < win.end; idx++) {
      const n = notes[idx];
      if (n.holdMs <= 0 || n.state === 2) continue;
      if (n.holdPhase === 'done' || n.holdPhase === 'failed') continue;
      const headY = hy - ((n.timeMs - nowMs) / 1000 / fall) * hy;
      const tailMs = n.timeMs + n.holdMs;
      const tailY = hy - ((tailMs - nowMs) / 1000 / fall) * hy;
      // 描く範囲は「帯そのもの」が見える間で決める。尾が画面の下端を過ぎるまでは描き続ける
      // （v1.7.0 までの見切れ不具合の対策。ウィンドウ側でも尾基準で含めている）
      if (tailY > H + 40 || headY < -40) continue;
      const c = LANE_COLORS[n.lane];
      const cx = this.laneX(n.lane) + lw / 2;
      const bw = lw - 36;
      const bottom = n.state === 1 ? hy : headY;
      const bodyTop = tailY + 7;
      if (bottom > bodyTop) {
        if (n.holdPhase === 'holding') {
          gn.globalAlpha = 0.3;
          gn.fillStyle = c;
          gn.beginPath();
          gn.roundRect(cx - bw / 2 - 6, bodyTop, bw + 12, bottom - bodyTop, 12);
          gn.fill();
        }
        gn.globalAlpha =
          n.holdPhase === 'holding' ? 0.95 : n.holdPhase === 'grace' ? 0.5 + 0.25 * Math.sin(frameAt * 28) : 0.55;
        gn.fillStyle = c;
        gn.beginPath();
        gn.roundRect(cx - bw / 2, bodyTop, bw, bottom - bodyTop, 9);
        gn.fill();
        if (n.holdPhase === 'holding') {
          gn.globalAlpha = 0.55;
          gn.fillStyle = '#fff';
          gn.fillRect(cx - 2, bodyTop + 4, 4, Math.max(0, bottom - bodyTop - 8));
          gn.globalAlpha = 1;
        } else {
          gn.globalAlpha = 1;
        }
      }
      // 尾のキャップ
      gn.fillStyle = c;
      gn.beginPath();
      gn.roundRect(this.laneX(n.lane) + 10, tailY - 7, lw - 20, 14, 7);
      gn.fill();
      // 頭のキャップ（未ヒットのときだけ。ヒット後はライン側に吸着する）
      if (n.state === 0) {
        gn.beginPath();
        gn.roundRect(this.laneX(n.lane) + 8, headY - 14, lw - 16, 28, 8);
        gn.fill();
      }
    }
    for (let idx = win.start; idx < win.end; idx++) {
      const n = notes[idx];
      if (n.state !== 0 || n.holdMs > 0) continue;
      const y = hy - ((n.timeMs - nowMs) / 1000 / fall) * hy;
      // フリック矢印は高さ 60px を脈動させるため、通常ノーツより広い余白で間引く
      if (n.flick ? y < -80 || y > H + 80 : y < -30 || y > H + 30) continue;
      if (n.flick) {
        // フリックの印は大きなブロック矢印（↑）だけ（オーナー決定 2026-11-23、確定仕様）
        const cx = this.laneX(n.lane) + lw / 2;
        const pulse =
          1 +
          (FLICK_ARROW_PULSE_MAX - 1) *
            (0.5 + 0.5 * Math.sin((frameAt / FLICK_ARROW_PULSE_PERIOD_SEC) * Math.PI * 2));
        const ah = FLICK_ARROW_HEIGHT;
        const aw = lw - 10;
        gn.save();
        gn.translate(cx, y);
        gn.scale(pulse, pulse);
        gn.beginPath();
        gn.moveTo(0, -ah / 2);
        gn.lineTo(aw / 2, ah * 0.05);
        gn.lineTo(aw * 0.22, ah * 0.05);
        gn.lineTo(aw * 0.22, ah / 2);
        gn.lineTo(-aw * 0.22, ah / 2);
        gn.lineTo(-aw * 0.22, ah * 0.05);
        gn.lineTo(-aw / 2, ah * 0.05);
        gn.closePath();
        gn.fillStyle = LANE_COLORS[n.lane];
        gn.fill();
        gn.strokeStyle = FLICK_ARROW_OUTLINE_COLOR;
        // 縁取りの太さが脈動で拡縮されないよう、拡大率で割って画面上 5px 一定にする
        gn.lineWidth = FLICK_ARROW_OUTLINE_WIDTH / pulse;
        gn.lineJoin = 'round';
        gn.stroke();
        gn.restore();
        continue;
      }
      const nx = this.laneX(n.lane) + 8;
      const nw = lw - 16;
      const nh = 28;
      gn.fillStyle = LANE_COLORS[n.lane];
      gn.beginPath();
      gn.roundRect(nx, y - nh / 2, nw, nh, 8);
      gn.fill();
    }
  }

  /** 演出レイヤー（ノーツ専用キャンバス側）の描画委譲先コンテキスト */
  get notesContext(): CanvasRenderingContext2D {
    return this.gn;
  }

  /**
   * HUD 描画: READY 表示、凍結案内、コンボ、判定文字、中断ボタン、
   * スコア、進行バー、ライフメーター。
   */
  drawHud(
    effects: GameEffects,
    state: {
      nowSec: number;
      isPaused: boolean;
      pausePhase: 'confirm' | 'countdown';
      audioFrozen: boolean;
      combo: number;
      tier: number;
      score: number;
      life: number;
      durationSec: number;
      frameAt: number;
    },
  ): void {
    const g = this.g;
    const W = this.width;
    const H = this.height;
    const frameAt = state.frameAt;
    const tier = state.tier;
    const frameFx = tierFx(tier);
    g.textAlign = 'center';
    if (state.nowSec < 0) {
      g.fillStyle = '#fff';
      g.font = 'bold 48px sans-serif';
      g.fillText('READY', W / 2, H * 0.4);
    }
    if (state.isPaused && state.pausePhase === 'countdown') {
      // 再開前の READY（確認カードが閉じた後、演奏が戻るまでの1秒）
      g.fillStyle = '#fff';
      g.font = 'bold 48px sans-serif';
      g.fillText('READY', W / 2, H * 0.4);
    }
    if (state.audioFrozen) {
      // 音声が止まって時計が凍っている間の案内。タップで復帰できることを伝える
      g.fillStyle = '#fff';
      g.font = 'bold 19px sans-serif';
      g.shadowColor = 'rgb(0 0 0 / 0.9)';
      g.shadowBlur = 6;
      g.fillText('音声が止まっています', W / 2, H * 0.52);
      g.font = '16px sans-serif';
      g.fillText('画面をタップすると再開します', W / 2, H * 0.52 + 26);
      g.shadowBlur = 0;
    }
    if (state.combo > 1) {
      // コンボ表示も tier で色・大きさが変わる（高 tier では光る）
      const comboPx = Math.round(54 * frameFx.comboScale);
      if (tier >= 3) {
        g.shadowColor = frameFx.comboColor;
        g.shadowBlur = 16;
      }
      g.fillStyle = frameFx.comboColor;
      g.font = `bold ${comboPx}px sans-serif`;
      g.fillText(String(state.combo), W / 2, H * 0.3);
      g.shadowBlur = 0;
      g.font = '17px sans-serif';
      g.fillText('COMBO', W / 2, H * 0.3 + 26 + (comboPx - 54));
    }
    // 判定文字: 出た瞬間に大きく、縮みながらフェードする（経過時間ベース）
    const judgeAge = frameAt - effects.judgeShownAt;
    if (effects.judgeText && judgeAge < JUDGE_LIFE) {
      const popK = Math.min(1, judgeAge / 0.12);
      const scale = (1.35 - 0.35 * popK) * tierFx(effects.judgeTier).judgeMul;
      const alpha = judgeAge < 0.35 ? 1 : 1 - (judgeAge - 0.35) / (JUDGE_LIFE - 0.35);
      g.globalAlpha = Math.max(0, alpha);
      if (effects.judgeTier >= 3) {
        g.shadowColor = effects.judgeColor;
        g.shadowBlur = 18;
      }
      g.fillStyle = effects.judgeColor;
      g.font = `bold ${Math.round(34 * scale)}px sans-serif`;
      g.fillText(effects.judgeText, W / 2, H * 0.46);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    g.textAlign = 'left';
    // 中断ボタン: 丸ボタンに ❚❚ アイコンだけ（v1.4.9 の上部 UI 見直し）
    g.fillStyle = 'rgba(6,8,16,.45)';
    g.beginPath();
    g.arc(PAUSE_BTN.cx, PAUSE_BTN.cy, PAUSE_BTN.r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.fillRect(PAUSE_BTN.cx - 7, PAUSE_BTN.cy - 8, 5, 16);
    g.fillRect(PAUSE_BTN.cx + 2, PAUSE_BTN.cy - 8, 5, 16);
    g.font = SCORE_FONT;
    g.textAlign = 'right';
    g.fillText(this.scoreText(state.score), W - 14, SCORE_BASELINE_Y);
    // 曲の進行バー（最上端 3px）
    g.fillStyle = 'rgba(255,255,255,.2)';
    g.fillRect(0, 0, W, 3);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W * Math.max(0, Math.min(1, state.nowSec / state.durationSec)), 3);
    this.drawLifeMeter(g, W, state.score, state.life);
  }
}
