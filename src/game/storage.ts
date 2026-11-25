// localStorage は使えない環境（プライベートブラウズなど）でもアプリが動くよう、必ず try/catch で囲む。
// 保存キー名を変えると利用者の記録が消える。変えるときは移行処理を書くこと。

/** 保存データの形（schemaVersion）。保存の形を変えるときは上げ、下の migrate() に移行処理を書く。 */
export const SCHEMA_VERSION = 1;

// 保存データのキーの接頭辞。GitHub Pages では、すべてのアプリが同じサイトに載り、localStorage を共有するので、
// アプリごとに別の名前にする（package.json の name）。
// CD 側の保存キー（`<アプリID>-...`）と混ざらないよう、ゲーム専用の接頭辞にする。
const PREFIX = `${__APP_ID__}-game`;

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFIX}-${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}-${key}`, JSON.stringify(value));
  } catch {
    // 保存できなくても続行する
  }
}

// ブラウザに「保存データを消さないで」と頼む（消されにくくなる）
export function requestPersist(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}

// ---- 保存データの版番号と移行 ----

/** 保存データの形が変わったときの移行処理。from → from+1 の変換を、ここに足していく。 */
function migrate(from: number): void {
  // 例: if (from < 2) { /* 版 1 → 2 の変換 */ }
  void from;
}

/** 起動時に一度呼ぶ。保存されている形の版が古ければ、移行してから版番号を書き直す。 */
export function migrateStorage(): void {
  const stored = load<number>('schema', 0);
  if (stored < SCHEMA_VERSION) {
    migrate(stored);
    save('schema', SCHEMA_VERSION);
  }
}
