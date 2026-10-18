import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @genoffice/i18n and @genoffice/electron-utils ship as TS source — must be bundled
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@genoffice/file-formats',
          '@genoffice/file-parse',
          '@genoffice/i18n',
          '@genoffice/electron-utils',
        ],
      }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@genoffice/file-formats', '@genoffice/i18n', '@genoffice/electron-utils'],
      }),
    ],
  },
  renderer: {
    build: { minify: 'esbuild' },
    plugins: [react()],
    server: {
      port: Number(process.env.HTML_DEV_PORT) || 5178,
      strictPort: Boolean(process.env.HTML_DEV_PORT),
    },
  },
})
