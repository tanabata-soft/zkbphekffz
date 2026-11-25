// 演出の素材スロット: コンボ演出（一定コンボごとのキャラ登場）と
// フルコンボ演出（演奏の締め）の、作品ごとに差し替える素材と設定はここに集める。
// ゲーム本体（game.ts / game-main.ts / sound.ts）は、ここの設定だけを見て動く。
//
// 差し替え方（手順の正本はリズムゲームエンジンの docs/START-HERE.md）:
// - コンボ演出のパターンを足す/変える: COMBO_PATTERNS に { id, imageUrl, lines, zoom } を足す。
//   画像は src/game/assets に置いて import する（public/ に直置きしない）。
//   big: true のパターンは、100コンボごとの「一段大きい登場」で優先される。
// - 素材が無い作品では COMBO_PATTERNS を空にする。その場合、コンボ演出は
//   一切出ない（紙吹雪も含む）が、ゲームは演出なしでそのまま成立する。
// - フルコンボ演出の絵とボイス: FULLCOMBO_IMAGE_URL / FULLCOMBO_VOICE_URL に
//   差し替える。未設定（undefined）なら、その素材なしで演出が成立する
//   （絵なし＝文字だけの締め、ボイスなし＝無音の締め）。
//
// NK-S003『京葉線の午後』では、キャラクター等の演出素材が無いため初版（v1.1.0）は
// 全スロットを空にする（オーナー承認済みの推奨案）。フルコンボ時は文字だけの
// 締め演出になる。
import type { ComboShowConfig, ComboZoom } from './logic';

/** コンボ演出の1パターン（絵・セリフ・ズームの組） */
export interface ComboPatternDef {
  /** パターン ID（英小文字。data 属性やテストにも出るので、作品内で一意にする） */
  id: string;
  /** 背景に敷く絵の URL。未設定なら絵なし（セリフと紙吹雪だけ）で登場する */
  imageUrl?: string;
  /** セリフ（登場のたびに順に回す。映画の台詞などの直引用はしない） */
  lines: string[];
  /** 背景の push-in の種別 */
  zoom: ComboZoom;
  /** 100の倍数（big）で優先するパターンか */
  big?: boolean;
}

/** コンボ演出のパターン。NK-S003 では素材が無いため空（演出なしで成立する）。 */
export const COMBO_PATTERNS: ComboPatternDef[] = [];

const comboDefById = new Map(COMBO_PATTERNS.map((d) => [d.id, d]));

/** パターン ID から定義を引く */
export const comboPatternDef = (id: string): ComboPatternDef | undefined => comboDefById.get(id);

/** logic.ts の comboAppearance に渡す割り当て設定（COMBO_PATTERNS から組み立てる） */
export const COMBO_SHOW_CONFIG: ComboShowConfig = {
  rotation: COMBO_PATTERNS.map((d) => d.id),
  bigPatterns: COMBO_PATTERNS.filter((d) => d.big).map((d) => d.id),
  zoomByPattern: Object.fromEntries(COMBO_PATTERNS.map((d) => [d.id, d.zoom])),
};

/**
 * フルコンボ演出の絵（全面表示）。未設定なら絵なし（暗い下地＋文字）で出す。
 * NK-S003 では未設定。
 */
export const FULLCOMBO_IMAGE_URL: string | undefined = undefined;

/**
 * フルコンボ演出のボイス（「FULL COMBO!」の叫びなど、約1〜2秒の音声ファイル）。
 * 未設定ならボイスなし。設定した場合は効果音のオン/オフに従わず鳴らす
 * （ボイスは効果音ではなく演奏の締めの演出そのもの、という位置づけ。sound.ts 参照）。
 * NK-S003 では未設定。
 */
export const FULLCOMBO_VOICE_URL: string | undefined = undefined;
