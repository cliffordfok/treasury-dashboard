import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 必須要有前後斜線，對應你個 GitHub Repository 名稱
  base: '/treasury-dashboard/',
  server: {
    proxy: {
      // Dev 環境繞過 FRED CORS：client call /fred-proxy/... → Vite 代理到 api.stlouisfed.org
      '/fred-proxy': {
        target: 'https://api.stlouisfed.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/fred-proxy/, ''),
      },
    },
  },
})
