#!/usr/bin/env node
/** Run focused RAG tests using the project's TypeScript and parser dependencies. No shell quoting. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'package.json'))
let ts
try { ts = require('typescript') } catch { console.error('Install the project dependencies first (npm ci from the repository root).'); process.exit(1) }
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'nawa-rag-test-'))
const visited = new Set()
async function emit(relative) {
  relative = relative.replaceAll('\\', '/')
  if (visited.has(relative)) return
  visited.add(relative)
  const source = await fs.readFile(path.join(root, relative), 'utf8')
  const transpiled = ts.transpileModule(source, { fileName: relative, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } })
  const dependencies = []
  const update = spec => {
    if (spec === '@genoffice/file-parse') {
      const dep = 'packages/file-parse/src/rag.ts'; dependencies.push(dep)
      let value = path.posix.relative(path.posix.dirname(relative), dep).replace(/\.ts$/, '.mjs')
      return value.startsWith('.') ? value : `./${value}`
    }
    if (spec.startsWith('.') && !/\.(?:mjs|js|json|css)$/.test(spec)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec + '.ts'))
      dependencies.push(dep); return spec + '.mjs'
    }
    return spec
  }
  const js = transpiled.outputText.replace(/(from\s*|import\s*\(\s*|import\s*)(['"])([^'"]+)\2/g, (all, before, quote, spec) => `${before}${quote}${update(spec)}${quote}`)
  const target = path.join(output, relative.replace(/\.tsx?$/, '.mjs'))
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, js)
  for (const dep of dependencies) await emit(dep)
}
let code = 1
try {
  // A junction avoids Windows symlink privilege requirements.
  await fs.symlink(path.join(root, 'node_modules'), path.join(output, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const entry of ['config', 'embedding', 'chunks', 'store', 'engine']) await emit(`apps/shell/src/main/rag/${entry}.ts`)
  await emit('packages/file-parse/src/rag.ts')
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', path.join(root, 'tools/rag/cases.mjs')], { stdio: 'inherit', env: { ...process.env, NAWA_RAG_TEST_BUILD: output, NAWA_RAG_TEST_PROJECT: root } })
    child.once('error', reject); child.once('exit', value => resolve(value ?? 1))
  })
} catch (error) { console.error(error.stack || String(error)) }
finally { await fs.rm(output, { recursive: true, force: true }) }
process.exitCode = code
