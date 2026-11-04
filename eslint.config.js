import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ロジックの層の決まり: src/logic.ts（と、ロジックが増えたときの src/logic/）は DOM・時刻・乱数に触れず、
// アプリのほかの層（main・storage など）も import しない。純関数に保ち、単体テストだけで確かめられるようにする。
// この決まりが本当に効いているかは tests/layer-rules.test.ts が確かめる。
const LOGIC_FORBIDDEN_GLOBALS = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'performance', 'requestAnimationFrame', 'Date'].map(
  (name) => ({ name, message: 'ロジック（src/logic）は DOM・時刻に触れないでください' }),
);

export default tseslint.config(
  { ignores: ['dist', 'dist-preview', 'shots', 'dev-dist', 'node_modules', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    files: ['src/logic.ts', 'src/logic/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...LOGIC_FORBIDDEN_GLOBALS],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'ロジック（src/logic）は乱数を使わないでください' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../*'], message: 'ロジック（src/logic）は、ロジックの外を import しないでください' },
            { group: ['./main', './storage', './backup', './pwa', './sound', './install', './debug'], message: 'ロジック（src/logic）は、アプリのほかの層を import しないでください' },
          ],
        },
      ],
    },
  },
  {
    // 利用者が入力した文字を innerHTML に入れると、意図しないタグが動く。textContent を使う。
    // HTML の固定の組み立てが必要なときは、その行に eslint-disable を付けて理由を書く。
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'innerHTML への代入は使わず、textContent か DOM の組み立てを使ってください' },
        { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'outerHTML への代入は使わないでください' },
      ],
    },
  },
  // public/ のスクリプトは、ビルドを通さずにそのまま配信される（普通の <script>）
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['tests/**/*.ts', 'scripts/**/*.mjs', 'vite.config.ts', 'playwright.config.ts', '*.js'], languageOptions: { globals: globals.node } },
  // page.evaluate() のコールバックはブラウザで動くので、両方の globals を許可する
  { files: ['e2e/**/*.ts'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
