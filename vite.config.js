import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'US Treasury Dashboard',
        short_name: 'Treasury',
        description: '美債投資組合管理工具',
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
  server: {
    proxy: {
      '/fred-proxy': {
        target: 'https://api.stlouisfed.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/fred-proxy/, ''),
      },
    },
  },
})
