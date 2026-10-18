import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const budgets = JSON.parse(readFileSync(join(root, 'packaging/renderer-budgets.json'), 'utf8'))
const report = {}
const failures = []
for (const [app, budget] of Object.entries(budgets)) {
  const renderer = join(root, 'apps', app, 'out', 'renderer')
  const html = readFileSync(join(renderer, 'index.html'), 'utf8')
  const entry = html.match(/<script[^>]*src="([^"]+\.js)"/u)?.[1]
  if (!entry) throw new Error(`No built renderer entry for ${app}. Build all editors first.`)
  const entryBytes = statSync(join(renderer, entry.replace(/^\.?\//u, ''))).size
  const totalBytes = readdirSync(join(renderer, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .reduce((size, name) => size + statSync(join(renderer, 'assets', name)).size, 0)
  report[app] = { entryBytes, totalBytes }
  console.log(
    `${app}: entry ${(entryBytes / 1e6).toFixed(2)} MB; all JS ${(totalBytes / 1e6).toFixed(2)} MB`,
  )
  if (entryBytes > budget.entryBytes || totalBytes > budget.totalBytes)
    failures.push(`${app}: exceeds its reviewed renderer budget`)
}
const output = process.argv.indexOf('--report')
if (output !== -1)
  writeFileSync(resolve(process.argv[output + 1]), JSON.stringify(report, null, 2) + '\n')
if (failures.length) throw new Error(failures.join('\n'))
