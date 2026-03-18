import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/admin': 'http://127.0.0.1:8000',
      '/webhook': 'http://127.0.0.1:8000',
    },
  },
  build: {
    // 本地开发：输出到 ../app/static/console（相对 frontend/ 目录）
    // Docker 构建：workdir=/app/frontend，outDir=/app/app/static/console（绝对路径由 Dockerfile 处理）
    outDir: path.resolve(__dirname, '../app/static/console'),
    emptyOutDir: true,
  },
})
