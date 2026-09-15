import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Logseq loads `dist/index.html` from a file:// origin, so every asset URL must be relative (`base: './'`).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'esnext',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
