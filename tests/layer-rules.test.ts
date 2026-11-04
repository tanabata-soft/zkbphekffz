import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// ロジックの層の決まり（eslint.config.js）が本当に効いていることを、ソースの断片を lint して確かめる。
// 決まりを置き忘れたり、対象の指定を間違えたりすると、このテストが落ちる。
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('ロジックの層の決まり', () => {
  const logic = 'src/logic.ts';

  it('DOM・時刻・乱数を使うとエラーになる', async () => {
    expect(await ruleIds('export const w = document.title;\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const w = window.innerWidth;\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const s = localStorage.getItem("x");\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const t = performance.now();\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const t = Date.now();\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const t = new Date();\n', logic)).toContain('no-restricted-globals');
    expect(await ruleIds('export const r = Math.random();\n', logic)).toContain('no-restricted-properties');
  });

  it('アプリのほかの層を import するとエラーになる', async () => {
    expect(await ruleIds("import { load } from './storage';\nexport const y = load;\n", logic)).toContain('no-restricted-imports');
    expect(await ruleIds("import { setupDebug } from './debug';\nexport const y = setupDebug;\n", logic)).toContain('no-restricted-imports');
  });

  it('純粋な計算はエラーにならない', async () => {
    expect(await ruleIds('export const b = Math.max(1, 2);\n', logic)).toEqual([]);
    expect(await ruleIds('export interface S { count: number }\nexport const f = (s: S): number => s.count + 1;\n', logic)).toEqual([]);
  });

  it('ロジックの外では DOM を使ってよい', async () => {
    expect(await ruleIds('export const w = document.title;\n', 'src/main.ts')).not.toContain('no-restricted-globals');
  });
});
