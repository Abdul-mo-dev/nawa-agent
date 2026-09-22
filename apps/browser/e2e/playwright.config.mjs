import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.', testMatch: 'workspace.spec.mjs', workers: 1,
  timeout: 60000, use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 900 } },
  reporter: 'list',
})
