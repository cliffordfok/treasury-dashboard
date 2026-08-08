import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '美國國債帳本',
        short_name: '國債帳本',
        description: '美債投資組合管理工具',
        lang: 'zh-HK',
        theme_color: '#0f172a',
        background_color: '#f1f5f9',
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
            options: { cacheName: 'fred-data', expiration: { maxAgeSeconds: 86400 } },
          },
        ],
      },
    }),
  ],
  base: '/treasury-dashboard/',
})
