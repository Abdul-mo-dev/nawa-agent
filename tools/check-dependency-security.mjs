import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { evaluateAudit } from './dependency-security-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const policy = JSON.parse(readFileSync('packaging/security-advisories.json', 'utf8'))
for (const rule of policy.mitigations) {
  for (const evidence of rule.evidence) {
    if (!existsSync(evidence)) throw new Error(`Missing mitigation evidence: ${evidence}`)
  }
}
// npm_execpath is supplied by npm run and avoids Windows .cmd quoting.
if (!process.env.npm_execpath) throw new Error('Run through npm run check:security.')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
})
if (result.error || ![0, 1].includes(result.status))
  throw new Error(`npm audit failed: ${result.error ?? result.stderr}`)
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const version = (name) => {
  const matches = Object.entries(lock.packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`))
    .map(([, item]) => item.version)
  return new Set(matches).size === 1 ? matches[0] : undefined
}
const reviewed = evaluateAudit(JSON.parse(result.stdout), policy, version)
console.log(`Dependency audit passed: ${reviewed.length} explicitly mitigated advisories.`)
for (const item of reviewed) console.log(item)
