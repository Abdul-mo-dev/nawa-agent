import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test-files/legacy-office/verify.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
