import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const FIREBASE_EMULATOR_ORIGINS = 'http://127.0.0.1:9099 http://127.0.0.1:8080'

// The production CSP only allows HTTPS; the dev server alone may reach the
// local Auth/Firestore emulators when VITE_USE_FIREBASE_EMULATORS=true.
const firebaseEmulatorCsp = (enabled) => ({
  name: 'firebase-emulator-csp',
  apply: 'serve',
  transformIndexHtml: (html) => (enabled
    ? html
      .replace("connect-src 'self'", `connect-src 'self' ${FIREBASE_EMULATOR_ORIGINS}`)
      .replace('frame-src https:', `frame-src https: ${FIREBASE_EMULATOR_ORIGINS}`)
    : html),
})

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    firebaseEmulatorCsp(loadEnv(mode, process.cwd(), 'VITE_').VITE_USE_FIREBASE_EMULATORS === 'true'),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '美國國債帳本',
        short_name: '國債帳本',
        description: '美債投資組合管理工具',
        lang: 'zh-HK',
        theme_color: '#080C14',
        background_color: '#080C14',
        display: 'standalone',
        start_url: '/treasury-dashboard/',
        scope: '/treasury-dashboard/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        runtimeCaching: [
          {
            urlPattern: /yield-curve\.json$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fred-data',
              networkTimeoutSeconds: 10,
              expiration: { maxAgeSeconds: 86400 },
            },
          },
        ],
      },
    }),
  ],
  base: '/treasury-dashboard/',
  // End-to-end runs toggle network emulation, which would make the HMR client reload the page.
  server: { hmr: process.env.E2E_NO_HMR !== '1' },
  build: {
    // The Firestore SDK with IndexedDB persistence is one ~540 kB vendor chunk.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'firebase-firestore',
              test: /node_modules[\\/](?:@firebase[\\/]firestore|firebase[\\/]firestore)/,
            },
            {
              name: 'firebase-auth',
              test: /node_modules[\\/](?:@firebase[\\/]auth|firebase[\\/]auth)/,
            },
            {
              name: 'firebase-app-check',
              test: /node_modules[\\/](?:@firebase[\\/]app-check|firebase[\\/]app-check)/,
            },
          ],
        },
      },
    },
  },
}))
