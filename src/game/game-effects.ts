// 演出状態（単位Fで game.ts から分離）。
// 粒子・輪・残像・波紋・フリックシェブロン・レーンフラッシュ・判定文字・
// コンボ演出の背景といった、経過時間ベースで進む見た目の状態だけを持つ。
// 進行はすべて dt（秒）ベースで、分離前と見え方は同一。
import { LANE_COLORS, comboTier, tierFx, tintColor, type ComboAppearance, type Judge } from './logic';
import { comboPatternDef } from './presentation';

/** 描画に必要なレーン形状（game-renderer.ts の GameRenderer が満たす） */
export interface LaneGeometry {
  readonly width: number;
  readonly height: number;
  laneW(): number;
  laneX(lane: number): number;
  hitY(): number;
}

/** 粒子（ヒットで弾ける） */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  c: string;
  size: number;
}
/** 広がる輪（ヒットの衝撃） */
export interface Ring {
  x: number;
  y: number;
  age: number;
  life: number;
  maxR: number;
  c: string;
  /** 線の太さの倍率（コンボ tier 連動） */
  widthMul: number;
}
/** ノーツが一瞬膨らんで消える残像 */
export interface Pop {
  lane: number;
  age: number;
  life: number;
  c: string;
  /** 最大の拡大率（コンボ tier 連動） */
  maxScale: number;
}
/** タップした場所に出る波紋 */
export interface Ripple {
  x: number;
  y: number;
  age: number;
  life: number;
  c: string;
}
/** フリック成功時に上へ飛んで消えるシェブロン（∧） */
export interface FlickChev {
  x: number;
  /** 出現位置 (y)。上昇は age から計算する */
  y: number;
  age: number;
  life: number;
}

export const RING_LIFE = 0.32;
export const POP_LIFE = 0.18;
export const RIPPLE_LIFE = 0.38;
export const JUDGE_LIFE = 0.55;

const JUDGE_LABEL: Record<Judge, string> = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
const JUDGE_COLOR: Record<Judge, string> = { perfect: '#ffd166', great: '#4ecdc4', good: '#9aa8ff', miss: '#ff6b6b' };

/** フリック成功時に飛ぶシェブロンの寿命（秒）と上昇距離 (px) */
export const FLICK_CHEV_LIFE = 0.35;
export const FLICK_CHEV_RISE_PX = 60;
/** フリック成功時に飛ぶシェブロンの色（水色。演出は従来どおり） */
export const FLICK_CHEVRON_COLOR = '#3fd9ff';
/** コンボ演出の登場時の紙吹雪の色 */
const CONFETTI_COLORS = ['#ff6b6b', '#ffd166', '#4ecdc4', '#6c8cff', '#ff8ad8', '#ffffff'];
/** コンボ演出の絵の読み込み済み Image（パターンごとに 1 回だけ作る。素材スロットに絵があるパターンだけ） */
const comboBgImages = new Map<string, HTMLImageElement>();
export function comboBgImage(pattern: string): HTMLImageElement | undefined {
  const url = comboPatternDef(pattern)?.imageUrl;
  if (!url) return undefined;
  let img = comboBgImages.get(pattern);
  if (!img) {
    img = new Image();
    img.src = url;
    comboBgImages.set(pattern, img);
  }
  return img;
}
/**
 * コンボ演出の背景の滞在時間（秒）。main.ts の COMBO_SHOW_MS / COMBO_SHOW_BIG_MS と合わせる。
 * 通常は 0.9（イン）＋ 約2秒キープ ＋ 0.8（アウト）= 約3.7秒。
 * big はキープを長くして約4.4秒。
 */
export const COMBO_BG_DURATION_SEC = 3.7;
export const COMBO_BG_DURATION_BIG_SEC = 4.4;
/** 粒子の総数の上限（iPhone で 60fps を保つため。死んだ粒子はプールで再利用する） */
const MAX_PARTICLES = 300;

export class GameEffects {
  flash = [0, 0, 0, 0];
  /** コンボ段階（tier）の画面演出用: 前フレームの tier と、上がった瞬間のフラッシュ量 */
  lastTier = 0;
  tierFlash = 0;
  particles: Particle[] = [];
  private particlePool: Particle[] = [];
  rings: Ring[] = [];
  pops: Pop[] = [];
  ripples: Ripple[] = [];
  flickChevs: FlickChev[] = [];
  judgeText = '';
  judgeColor = '#fff';
  judgeTier = 0; // 判定文字を出した時点のコンボ tier（大きさ・色に使う）
  judgeShownAt = -Infinity; // AudioContext 時刻（秒）
  /** コンボ演出の登場回数（パターンのローテーションに使う。演奏ごとに数え直す） */
  comboShowCount = 0;
  /** 表示中のコンボ演出の背景（絵・ズーム・big と、出した時刻＝AudioContext 時刻） */
  comboBg: { pattern: string; zoom: ComboAppearance['zoom']; big: boolean; shownAt: number } | null = null;
  /** 端末の「視差効果を減らす」設定（背景のズームを止めるかの判定に使う） */
  reducedMotion = false;

  /** 演奏開始時のリセット */
  reset(): void {
    this.particles = [];
    this.rings = [];
    this.pops = [];
    this.ripples = [];
    this.flickChevs = [];
    this.flash = [0, 0, 0, 0];
    this.comboShowCount = 0;
    this.comboBg = null;
    this.lastTier = 0;
    this.tierFlash = 0;
    this.judgeText = '';
    this.judgeTier = 0;
    this.judgeShownAt = -Infinity;
  }

  /** このフレームの tier と、上がった瞬間のフラッシュを進める */
  updateTier(combo: number, dt: number): number {
    const tier = comboTier(combo);
    if (tier > this.lastTier) this.tierFlash = 1;
    this.lastTier = tier;
    this.tierFlash = Math.max(0, this.tierFlash - dt * 1.6);
    return tier;
  }

  showJudge(judge: Judge, tier = 0, shownAt: number): void {
    this.judgeText = JUDGE_LABEL[judge];
    this.judgeTier = tier;
    // tier が高いほど判定文字の色を金色寄りに寄せる（MISS はそのまま）
    this.judgeColor =
      judge === 'miss' ? JUDGE_COLOR.miss : tintColor(JUDGE_COLOR[judge], '#ffedb0', tierFx(tier).judgeTint);
    this.judgeShownAt = shownAt;
  }

  /** レーンを叩いたときの共通の見た目（フラッシュ＋波紋）。タップとフリックで共用する */
  laneTapFx(geom: LaneGeometry, lane: number, rippleX?: number, rippleY?: number): void {
    this.flash[lane] = 1;
    // 押した場所に波紋を出す（キーボードのときはレーンの判定ライン中央）
    const lw = geom.laneW();
    this.ripples.push({
      x: rippleX ?? geom.laneX(lane) + lw / 2,
      y: rippleY ?? geom.hitY(),
      age: 0,
      life: RIPPLE_LIFE,
      c: LANE_COLORS[lane],
    });
    if (this.ripples.length > 24) this.ripples.shift();
  }

  /** 粒子を1つ出す。上限に達していたら出さない。死んだ粒子はプールから再利用する */
  spawnParticle(x: number, y: number, vx: number, vy: number, life: number, c: string, size: number): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const p = this.particlePool.pop() ?? { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, c: '', size: 4 };
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.age = 0;
    p.life = life;
    p.c = c;
    p.size = size;
    this.particles.push(p);
  }

  /** ヒット演出: ノーツの膨らむ残像＋広がる輪＋粒子。コンボ tier が高いほど派手 */
  burst(geom: LaneGeometry, lane: number, level: 0 | 1 | 2, tier: number): void {
    const fx = tierFx(tier);
    const lw = geom.laneW();
    const cx = geom.laneX(lane) + lw / 2;
    const cy = geom.hitY();
    const c = LANE_COLORS[lane];
    this.pops.push({ lane, age: 0, life: POP_LIFE, c, maxScale: 1.5 * fx.popMul });
    this.rings.push({
      x: cx,
      y: cy,
      age: 0,
      life: RING_LIFE,
      maxR: 46 * fx.ringMul,
      c,
      widthMul: fx.ringWidthMul,
    });
    if (this.rings.length > 24) this.rings.shift();
    const n = Math.round((level === 0 ? 22 : level === 1 ? 14 : 8) * fx.particleMul);
    for (let i = 0; i < n; i++) {
      const an = Math.random() * Math.PI * 2;
      const sp = (140 + Math.random() * (level === 0 ? 380 : 260)) * (0.9 + 0.1 * tier);
      this.spawnParticle(cx, cy, Math.cos(an) * sp, Math.sin(an) * sp - 70, 0.35 + Math.random() * 0.2, c, fx.particleSize);
    }
  }

  /**
   * フリック成功時だけの追加演出（burst の残像・輪・粒子に重ねる）:
   * 上方向へ噴き上がる粒子と、上へ飛んで消えるシェブロン（∧）。
   */
  flickBurst(geom: LaneGeometry, lane: number, level: 0 | 1 | 2, tier: number): void {
    const fx = tierFx(tier);
    const lw = geom.laneW();
    const cx = geom.laneX(lane) + lw / 2;
    const cy = geom.hitY();
    const c = LANE_COLORS[lane];
    const n = Math.round((level === 0 ? 14 : level === 1 ? 10 : 7) * fx.particleMul);
    for (let i = 0; i < n; i++) {
      const vx = (Math.random() - 0.5) * 130;
      const vy = -(260 + Math.random() * 260) * (0.9 + 0.1 * tier);
      const color = i % 3 === 0 ? '#ffffff' : c;
      this.spawnParticle(cx, cy, vx, vy, 0.4 + Math.random() * 0.2, color, fx.particleSize);
    }
    this.flickChevs.push({ x: cx, y: cy, age: 0, life: FLICK_CHEV_LIFE });
    if (this.flickChevs.length > 12) this.flickChevs.shift();
  }

  /** コンボ演出の登場時の紙吹雪（Canvas 側で画面中央から出す） */
  confetti(geom: LaneGeometry, big: boolean): void {
    const n = big ? 70 : 26;
    for (let i = 0; i < n; i++) {
      const an = Math.random() * Math.PI * 2; // 中央から全方向へ
      const sp = 140 + Math.random() * (big ? 380 : 260);
      this.spawnParticle(
        geom.width / 2,
        geom.height * 0.42,
        Math.cos(an) * sp,
        Math.sin(an) * sp,
        0.7 + Math.random() * 0.5,
        CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        5,
      );
    }
  }

  /** ヒット演出の更新と描画（ノーツ専用キャンバス gn 側。時間ベース） */
  drawEffects(gn: CanvasRenderingContext2D, geom: LaneGeometry, dt: number): void {
    const lw = geom.laneW();
    const hy = geom.hitY();
    for (const p of this.pops) {
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) continue;
      const scale = 1 + (p.maxScale - 1) * k;
      const w = (lw - 16) * scale;
      const h = 28 * scale;
      gn.globalAlpha = 0.75 * (1 - k);
      gn.fillStyle = p.c;
      gn.beginPath();
      gn.roundRect(geom.laneX(p.lane) + lw / 2 - w / 2, hy - h / 2, w, h, 8);
      gn.fill();
    }
    this.pops = this.pops.filter((p) => p.age < p.life);
    gn.globalAlpha = 1;

    for (const r of this.rings) {
      r.age += dt;
      const k = r.age / r.life;
      if (k >= 1) continue;
      const ease = 1 - (1 - k) * (1 - k);
      gn.globalAlpha = 0.9 * (1 - k);
      gn.strokeStyle = r.c;
      gn.lineWidth = (1 + 3.5 * (1 - k)) * r.widthMul;
      gn.beginPath();
      gn.arc(r.x, r.y, 10 + (r.maxR - 10) * ease, 0, 7);
      gn.stroke();
    }
    this.rings = this.rings.filter((r) => r.age < r.life);
    gn.globalAlpha = 1;

    // 粒子は上限つき。死んだものはプールへ戻して再利用する（毎フレームの確保を避ける）
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        if (this.particlePool.length < MAX_PARTICLES) this.particlePool.push(p);
        continue;
      }
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      gn.globalAlpha = 1 - p.age / p.life;
      gn.fillStyle = p.c;
      gn.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    gn.globalAlpha = 1;

    for (const r of this.ripples) {
      r.age += dt;
      const k = r.age / r.life;
      if (k >= 1) continue;
      gn.globalAlpha = 0.7 * (1 - k);
      gn.strokeStyle = r.c;
      gn.lineWidth = 2;
      gn.beginPath();
      gn.arc(r.x, r.y, 6 + 34 * k, 0, 7);
      gn.stroke();
    }
    this.ripples = this.ripples.filter((r) => r.age < r.life);
    gn.globalAlpha = 1;

    // フリック成功時に飛ぶシェブロン: その場から上へ進みながら少し広がり、消える
    for (const f of this.flickChevs) {
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) continue;
      const rise = FLICK_CHEV_RISE_PX * (1 - (1 - k) * (1 - k));
      const s = 11 + 3 * k;
      gn.globalAlpha = 0.95 * (1 - k);
      // 成功シェブロンの色は水色のまま維持（見た目改善の案A、2026-11-23。演出自体は従来どおり）
      gn.strokeStyle = FLICK_CHEVRON_COLOR;
      gn.lineWidth = 4;
      gn.lineJoin = 'round';
      gn.beginPath();
      gn.moveTo(f.x - s, f.y - rise + s * 0.55);
      gn.lineTo(f.x, f.y - rise - s * 0.55);
      gn.lineTo(f.x + s, f.y - rise + s * 0.55);
      gn.stroke();
    }
    this.flickChevs = this.flickChevs.filter((f) => f.age < f.life);
    gn.globalAlpha = 1;
  }
}
