import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Resolve workspace packages from this checkout's sources: in a git worktree
// node_modules is a symlink into the main checkout, so bare specifiers would
// silently bundle the other checkout's (possibly stale) code.
const localAlias = {
  '@genoffice/docx-engine/lazy-media': resolve(
    __dirname,
    '../../packages/docx-engine/src/lazy-media.ts',
  ),
  '@genoffice/docx-engine/zip-splice': resolve(
    __dirname,
    '../../packages/docx-engine/src/zip-splice.ts',
  ),
  '@genoffice/docx-engine': resolve(
    __dirname,
    '../../packages/docx-engine/src/index.ts',
  ),
}

// Main/preload must resolve every @genoffice/* runtime import to this
// checkout's sources (see above).
//
// IMPORTANT:
// Vite alias matching also matches package subpaths. Therefore every
// @genoffice/electron-utils/* subpath used by the application must appear
// before the bare @genoffice/electron-utils alias. Otherwise an import such as
//
//   @genoffice/electron-utils/generated-images
//
// can incorrectly resolve to:
//
//   electron-utils/src/index.ts/generated-images
//
// instead of the actual generated-images.ts source file.
const mainAlias = {
  // ── electron-utils subpath exports ──────────────────────────────────────
  '@genoffice/electron-utils/drop-open': resolve(
    __dirname,
    '../../packages/electron-utils/src/drop-open.ts',
  ),
  '@genoffice/electron-utils/generated-images': resolve(
    __dirname,
    '../../packages/electron-utils/src/generated-images.ts',
  ),
  '@genoffice/electron-utils/headless-export': resolve(
    __dirname,
    '../../packages/electron-utils/src/headless-export.ts',
  ),
  '@genoffice/electron-utils/remote-image': resolve(
    __dirname,
    '../../packages/electron-utils/src/remote-image.ts',
  ),
  '@genoffice/electron-utils/renderer-protocol': resolve(
    __dirname,
    '../../packages/electron-utils/src/renderer-protocol.ts',
  ),
  '@genoffice/electron-utils/renderer-scheme': resolve(
    __dirname,
    '../../packages/electron-utils/src/renderer-scheme.ts',
  ),
  '@genoffice/electron-utils/safe-remote-url': resolve(
    __dirname,
    '../../packages/electron-utils/src/safe-remote-url.ts',
  ),

  // ── ai-provider subpath exports ─────────────────────────────────────────
  '@genoffice/ai-provider/codex-app-server': resolve(
    __dirname,
    '../../packages/ai-provider/src/codex-app-server.ts',
  ),
  '@genoffice/ai-provider/browser': resolve(
    __dirname,
    '../../packages/ai-provider/src/browser.ts',
  ),

  ...localAlias,

  // Bare package aliases MUST remain after their subpath aliases.
  '@genoffice/electron-utils': resolve(
    __dirname,
    '../../packages/electron-utils/src/index.ts',
  ),
  '@genoffice/ai-provider': resolve(
    __dirname,
    '../../packages/ai-provider/src/index.ts',
  ),
  '@genoffice/ai-search': resolve(
    __dirname,
    '../../packages/ai-search/src/index.ts',
  ),
  '@genoffice/file-parse': resolve(
    __dirname,
    '../../packages/file-parse/src/index.ts',
  ),
  '@genoffice/font-metrics': resolve(
    __dirname,
    '../../packages/font-metrics/src/index.ts',
  ),
  '@genoffice/i18n': resolve(
    __dirname,
    '../../packages/i18n/src/index.ts',
  ),
  '@genoffice/project-store': resolve(
    __dirname,
    '../../packages/project-store/src/index.ts',
  ),
}

export default defineConfig({
  // Main and preload use only electron + node builtins; bundle everything so
  // the packaged app doesn't rely on node_modules at runtime.
  // @genoffice/* deps ship as raw TS source with extensionless imports, so they
  // must be bundled — externalizing them yields ERR_MODULE_NOT_FOUND under Node
  // (same setup as apps/slides).
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@genoffice/docx-engine',
          '@genoffice/electron-utils',
          '@genoffice/font-metrics',
          '@genoffice/i18n',
          '@genoffice/project-store',
          '@genoffice/file-parse',
          '@genoffice/ai-provider',
          '@genoffice/ai-search',
        ],
      }),
    ],
    resolve: { alias: mainAlias },
  },

  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@genoffice/electron-utils'],
      }),
    ],
    resolve: { alias: mainAlias },
  },

  renderer: {
    plugins: [react()],
    resolve: { alias: localAlias },
    server: {
      // Overridable so multiple Nawa dev instances can coexist (default 5173).
      port: Number(process.env.DOCS_DEV_PORT) || 5173,
      strictPort: Boolean(process.env.DOCS_DEV_PORT),
    },
  },
})