import { build, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as fs from 'node:fs/promises'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const browser = path.join(repo, 'apps/browser')
const require = createRequire(path.join(repo, 'apps/pdf/package.json'))
const kinds = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']
const dedupe = ['@tiptap/core', '@tiptap/pm', '@tiptap/react', '@tiptap/extensions', '@tiptap/extension-list', '@tiptap/extension-table', '@tiptap/extension-image', '@tiptap/suggestion', '@tiptap/markdown', '@tiptap/extension-highlight', '@tiptap/extension-code-block']
const bridge = normalizePath(path.join(browser, 'src/client/electron.ts'))

for (const kind of kinds) {
  const app = path.join(repo, 'apps', kind)
  const root = path.join(app, 'src/renderer')
  const virtual = '\0genoffice-browser-entry'
  const entry = '/@genoffice-browser-entry'
  const bootstrap = {
    name: 'genoffice-browser-bootstrap',
    enforce: 'pre',
    resolveId(id) { if (id === entry) return virtual },
    load(id) {
      if (id !== virtual) return
      // Preload globals must exist BEFORE React modules evaluate. Static imports
      // would evaluate the renderer before await ready, so use ordered imports.
      return `import { ready } from ${JSON.stringify(bridge)};\nawait ready;\nawait import(${JSON.stringify(normalizePath(path.join(app, 'src/preload/index.ts')))});\nawait import(${JSON.stringify(normalizePath(path.join(root, 'main.tsx')))});`
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // Desktop CSP mentions Electron-only custom schemes; HTTP responses set
        // the browser policy centrally. No unsafe inline app scripts are enabled.
        html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][\s\S]*?>/gi, '')
        return html.replace(/<script\s+type="module"\s+src="(?:\.\/|\/)main\.tsx"><\/script>/, `<script type="module" src="${entry}"></script>`)
      },
    },
  }
  const plugins = [bootstrap, react()]
  if (kind === 'pdf') {
    const pdfjs = path.dirname(require.resolve('pdfjs-dist/package.json'))
    plugins.push(viteStaticCopy({ targets: ['cmaps', 'standard_fonts', 'wasm'].map(name => ({ src: normalizePath(path.join(pdfjs, name)), dest: 'pdfjs' })) }))
  }
  console.log(`\nBuilding GenOffice browser editor: ${kind}`)
  await build({
    define: { 'process.env.GENOFFICE_DEBUG_HOOKS': JSON.stringify('0') },
    configFile: false, root, base: `/editors/${kind}/`, plugins,
    resolve: {
      alias: [
        { find: /^electron$/, replacement: bridge },
        { find: '@genoffice/electron-utils/drop-open', replacement: path.join(browser, 'src/client/drop-open.ts') },
      ],
      dedupe: kind === 'markdown' ? dedupe : [],
    },
    build: {
      target: 'es2022', outDir: path.join(browser, 'out/editors', kind), emptyOutDir: true,
      sourcemap: false, chunkSizeWarningLimit: 2500,
    },
  })
  const output = await fs.readFile(path.join(browser, 'out/editors', kind, 'index.html'), 'utf8')
  if (/src="(?:\.\/|\/)main\.tsx"/.test(output)) throw new Error(`${kind}: browser bootstrap was not injected`)
}
console.log('\nAll six browser editor bundles were written to apps/browser/out/editors.')
