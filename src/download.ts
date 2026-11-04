// 初回一括ダウンロード: 全音源を Service Worker の実行時キャッシュへ先に入れておく。
// こうしておくと、配信元（公開 URL）が無くなっても、インストール済みのアプリは全曲そのまま再生できる。
// 失敗したら残りは次回起動時に回す（アプリの動作は妨げない）。状態は戻り値で返す:
// 'uptodate' = すでに揃っている / 'complete' = 全部入った / 'partial' = 途中まで（次回に続ける）
export async function downloadAllAudio(
  urls: string[],
  onProgress: (done: number, total: number) => void,
): Promise<'uptodate' | 'complete' | 'partial'> {
  try {
    if (!('caches' in window)) return 'uptodate';
    const cache = await caches.open(__AUDIO_CACHE__);
    const wanted = new Set(urls.map((u) => new URL(u, location.href).href));
    // 今の版に無い古い音源は片付ける（ファイル名には内容ハッシュが付き、差し替えで変わる）
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }
    const missing: string[] = [];
    for (const u of wanted) {
      if (!(await cache.match(u))) missing.push(u);
    }
    if (!missing.length) return 'uptodate';
    let done = urls.length - missing.length;
    onProgress(done, urls.length);
    for (const u of missing) {
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cache.put(u, res);
      } catch {
        return 'partial';
      }
      done++;
      onProgress(done, urls.length);
    }
    return 'complete';
  } catch {
    return 'partial';
  }
}
