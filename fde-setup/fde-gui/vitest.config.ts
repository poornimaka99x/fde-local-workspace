import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// One config, two environments: server tests run in node, component tests opt
// into jsdom with a `@vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
})
