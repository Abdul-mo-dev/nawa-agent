import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // Like apps/shell: bundle workspace TS source rather than externalizing it.
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    build: { rollupOptions: { input: { empty: resolve(__dirname, 'src/main/empty.ts') } } },
  },
  // Real browser renderer bundles are built separately by build-editors.mjs.
})
