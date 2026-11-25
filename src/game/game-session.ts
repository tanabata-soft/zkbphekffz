// セッション・時計（単位Fで game.ts から分離）。
// AudioContext 時計の保持、凍結検知、ポーズ（中断確認／再開 READY）の
// 状態だけを持つ。挙動は分離前と同一:
// - 凍結判定は state ではなく「音声時計が壁時計で 1.5 秒以上進んでいないか」
// - 凍結ポーズ中、時計が復帰しないまま 10 秒経ったら最後の手段の打ち切り
// - 手動ポーズは打ち切りの対象外
import { nowSeconds } from './audio';
import { setData } from '../debug';

/**
 * 凍結が原因のポーズで、時計が復帰しないまま打ち切り（作り直してメニューへ）を
 * 最後の手段として実行するまでの猶予（壁時計 ms。オーナー決定 2026-11-24）
 */
export const FREEZE_PAUSE_ABORT_MS = 10_000;
/** 音声時計がこの時間（壁時計 ms）進まなければ凍結とみなす */
export const FREEZE_DETECT_MS = 1500;

export class GameSession {
  /**
   * 中断確認で凍結中か（オーナー指示 2026-11-21、案1）。凍結中は音を止めて位置を
   * 覚えておき、再開時にその位置から鳴らし直す。phase は確認カード表示中が
   * 'confirm'、「つづける」後の READY 中が 'countdown'
   */
  paused = false;
  pausePhase: 'confirm' | 'countdown' = 'confirm';
  /** 凍結した時点の曲位置（秒。READY 中は負） */
  pausePosSec = 0;
  /** 'countdown' が終わる壁時計時刻（ms） */
  resumeDueWall = 0;
  /** 再開の鳴らし直しに使う、読み込み済みの曲バッファ */
  songBuf: AudioBuffer | null = null;
  /**
   * start() の世代番号。中断（abort）や再スタートのたびに進める。
   * start() は await をまたぐため、合間にバックグラウンドへ回って中断されても、
   * 古い start() が後から演奏を始めてしまわないようにする（v1.9.1）。
   */
  startSession = 0;
  /** 前面にいるのに AudioContext が止まっていたときの、resume 再試行の間引き（壁時計 ms） */
  lastResumeTryWall = 0;

  startAt = 0; // AudioContext 時刻（秒）
  /** 音声時計の凍結検知用: 最後に時計が進んだときの値と、その壁時計時刻 */
  clockSeenAt = 0;
  clockAdvanceWall = 0;
  audioFrozen = false;
  /**
   * いまのポーズが凍結検知によるものか（オーナー決定 2026-11-24）。手動ポーズ
   * （中断ボタン・Esc・アプリ切替）と区別し、最後の手段の打ち切りは凍結ポーズ
   * にだけ適用する
   */
  freezePause = false;
  /** 凍結ポーズ中、時計が止まり続けている期間の開始壁時計時刻（ms。時計が進み出したら 0 に戻す） */
  freezeStuckSince = 0;
  /** READY 中の凍結で開始を初期化し直したか（1回の開始につき1回まで）と、その実行中フラグ */
  readyReinitUsed = false;
  reiniting = false;

  /** 演奏開始時の時計の初期化 */
  beginClock(startAt: number): void {
    this.startAt = startAt;
    const now = nowSeconds();
    this.clockSeenAt = now;
    this.clockAdvanceWall = performance.now();
    this.audioFrozen = false;
    this.freezePause = false;
    this.freezeStuckSince = 0;
    this.readyReinitUsed = false;
    setData('audioFrozen', 'off');
  }

  /** 再開（finishResume）時の時計の引き継ぎ */
  resumeClock(startAt: number): void {
    this.startAt = startAt;
    const now = nowSeconds();
    this.clockSeenAt = now;
    this.clockAdvanceWall = performance.now();
    this.audioFrozen = false;
    this.freezePause = false;
    this.freezeStuckSince = 0;
    setData('audioFrozen', 'off');
  }

  /** READY の初期化し直し（reinitStart）後の時計の引き継ぎ */
  reinitClock(startAt: number): void {
    this.startAt = startAt;
    const now = nowSeconds();
    this.clockSeenAt = now;
    this.clockAdvanceWall = performance.now();
  }

  /**
   * 毎フレームの凍結検知。時計が進んでいれば記録を更新し、凍結状態が
   * 変わったら data 属性へ出す。戻り値は「いま凍結しているか」。
   */
  detectFreeze(frameAt: number): boolean {
    if (frameAt > this.clockSeenAt + 0.001) {
      this.clockSeenAt = frameAt;
      this.clockAdvanceWall = performance.now();
    }
    const frozen = performance.now() - this.clockAdvanceWall > FREEZE_DETECT_MS;
    if (frozen !== this.audioFrozen) {
      this.audioFrozen = frozen;
      setData('audioFrozen', frozen ? 'on' : 'off');
    }
    return frozen;
  }

  /**
   * 凍結ポーズ中の打ち切り判定。時計が復帰しないまま猶予を超えたら true。
   * 時計が進み出したら猶予は解消する（ポーズ自体は続く）。
   */
  freezeAbortDue(frozen: boolean): boolean {
    if (!this.freezePause || this.pausePhase !== 'confirm') return false;
    if (!frozen) {
      this.freezeStuckSince = 0;
      return false;
    }
    if (this.freezeStuckSince === 0) this.freezeStuckSince = performance.now();
    return performance.now() - this.freezeStuckSince > FREEZE_PAUSE_ABORT_MS;
  }

  /** ポーズに入る際の時計側の記録（曲位置の保持） */
  capturePause(nowSec: number): void {
    this.pausePosSec = nowSec - this.startAt;
    this.paused = true;
    this.pausePhase = 'confirm';
  }

  /** 凍結検知からのポーズであることを記録する */
  markFreezePause(): void {
    this.freezePause = true;
    this.freezeStuckSince = performance.now();
  }

  /** 中断（abort）時の時計状態のリセット */
  resetOnAbort(): void {
    this.paused = false;
    this.audioFrozen = false;
    this.freezePause = false;
    this.freezeStuckSince = 0;
    setData('audioFrozen', 'off');
  }
}
