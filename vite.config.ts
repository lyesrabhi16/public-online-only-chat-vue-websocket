import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  test: {
    // server tests run in Node; a component test asks for a browser-like DOM with `// @vitest-environment jsdom`
    environment: 'node',
    include: ['server/**/*.test.js', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'src/**/*.{ts,vue}'],
      exclude: ['**/*.test.*', 'src/main.ts', 'src/vite-env.d.ts'],
      reporter: ['text', 'lcov'],
    },
  },
})
