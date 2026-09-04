import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web app is built to dist/web and served by the local Fastify server,
// which owns every response header. Vite's own dev server is a convenience for
// UI work only; it proxies /api to the real server so the token flow is identical.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7317' },
  },
})
