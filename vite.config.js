import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 必須要有前後斜線，對應你個 GitHub Repository 名稱
  base: '/treasury-dashboard/', 
})
