import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'apps/shell/out/embedding/runtime.mjs')
await mkdir(dirname(output), { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: ['tools/embedding-runtime/entry.mjs'],
  outfile: output,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  minify: true,
  metafile: true,
  external: ['onnxruntime-node', 'onnxruntime-web', 'onnxruntime-common'],
  plugins: [
    {
      name: 'text-model-image-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^sharp$/ }, () => ({
          path: resolve(root, 'tools/embedding-runtime/text-only-images.mjs'),
        }))
      },
    },
  ],
})
for (const input of Object.keys(result.metafile.inputs)) {
  if (/(?:^|[/\\])node_modules[/\\](?:sharp|@img)(?:[/\\]|$)/u.test(input))
    throw new Error(`Forbidden image dependency in the text runtime: ${input}`)
}
for (const entry of Object.values(result.metafile.outputs)) {
  for (const imported of entry.imports) {
    if (imported.path === 'sharp' || imported.path.startsWith('@img/'))
      throw new Error(`Forbidden runtime import: ${imported.path}`)
  }
}
await writeFile(
  resolve(dirname(output), 'metafile.json'),
  JSON.stringify(result.metafile, null, 2) + '\n',
)
console.log('Built native text embedding runtime without Sharp or libvips.')
