import { describe, expect, it } from 'vitest';
import { DEBUG_KEY, DEBUG_TAPS, exposeTestApi, isDebug, isTestMode } from '../src/debug';

describe('デバッグモード', () => {
  it('保存キーは記録（`<アプリID>-...`）と別の形にする（バックアップに入らないように）', () => {
    expect(DEBUG_KEY).toBe(`${__APP_ID__}.debug`);
    expect(DEBUG_KEY.startsWith(`${__APP_ID__}-`)).toBe(false);
  });
  it('localStorage が使えなくても、オフのまま動く', () => {
    expect(isDebug()).toBe(false);
    expect(DEBUG_TAPS).toBe(5);
  });
});

describe('テスト用の入口', () => {
  it('`?debug=1` でない環境では無効で、関数を出そうとしても何も起きない', () => {
    // 単体テストの環境には location がないので、テストモードにはならない
    expect(isTestMode).toBe(false);
    expect(() => exposeTestApi({ getState: () => ({}) })).not.toThrow();
  });
});
