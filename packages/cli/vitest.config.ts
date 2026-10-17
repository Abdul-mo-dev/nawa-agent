import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    // MCP startup imports the complete Docs tool catalog on cold Windows runs.
    hookTimeout: 60000,
    maxWorkers: 4,
  },
})
