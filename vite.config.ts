/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const { version, name: appId } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; name: string };

// アプリ名・色はここと index.html の2か所だけ。新しいアプリを作るときに書き換える。
const APP_NAME = 'チョコミントの残像 ― デジタルシングルCD';
const THEME_COLOR = '#0c1216';
const BACKGROUND_COLOR = '#0c1216';
// 音源の実行時キャッシュ名。src/download.ts（初回一括ダウンロード）も同じ名前を使う（define で埋め込む）。
const AUDIO_CACHE = 'chocomint-single-audio';

export default defineConfig({
  // GitHub Pages のサブパス配信でも動くよう、相対パスにする
  base: './',
  // 画面に表示するバージョン（package.json の version）
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // アプリの ID（package.json の name）。保存データのキー・バックアップの app 名・起動失敗の復旧の範囲に使う。
    // GitHub Pages では、すべてのアプリが同じサイトに載るので、アプリごとに別の名前にする。
    __APP_ID__: JSON.stringify(appId),
    __AUDIO_CACHE__: JSON.stringify(AUDIO_CACHE),
  },
  plugins: [
    {
      // public/boot.js（Vite を通らない）が読めるように、アプリの ID を index.html に埋め込む
      name: 'app-id-meta',
      transformIndexHtml: (html) => html.replace('__APP_ID__', appId),
    },
    VitePWA({
      // 'prompt': 新版は待機させ、画面の「更新」ボタンで切り替える（プレイ中に勝手に切り替えない）
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/icon-192.png'],
      manifest: {
        name: APP_NAME,
        short_name: 'チョコミントの残像',
        description: '千葉のカラオケを歌う2曲を収めたデジタルシングルCD『チョコミントの残像』',
        lang: 'ja',
        display: 'standalone',
        start_url: './',
        scope: './',
        orientation: 'portrait',
        theme_color: THEME_COLOR,
        background_color: BACKGROUND_COLOR,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 音源（mp4）は容量が大きいので事前キャッシュには入れない。初回起動時にアプリが
        // 一括ダウンロードして実行時キャッシュへ入れる（src/download.ts）。再生時の取りこぼしもここで拾う。
        // 画像は表示に必須なので事前キャッシュに含める（大きめのジャケット画像に合わせて上限を引き上げる）。
        globPatterns: ['**/*.{js,css,html,svg,png,webp,jpg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /\.mp4($|\?)/,
            handler: 'CacheFirst',
            options: {
              cacheName: AUDIO_CACHE,
              rangeRequests: true,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 4 },
            },
          },
        ],
      },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
