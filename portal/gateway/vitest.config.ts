import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests share one MongoDB server; each file uses its own database
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
