import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Tauri 的 devUrl 固定指向 5173，这里必须一致且不允许漂移
const DEV_PORT = 5173

const config = defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    target: 'safari15',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
})

export default config
