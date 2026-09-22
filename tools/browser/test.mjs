import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const folder = path.join(root, 'apps/browser/test')
// Enumerate explicitly: no Bash wildcard expansion is needed on Windows.
const files = readdirSync(folder).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(folder, name))
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', shell: false })
process.exit(result.status ?? 1)
