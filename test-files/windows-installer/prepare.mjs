import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

assert.equal(process.platform, 'win32', 'The installer smoke test requires Windows.')
const workspace = resolve(import.meta.dirname, '../..')
await mkdir(join(workspace, '.task'), { recursive: true })
const root = await mkdtemp(join(workspace, '.task/windows-installer-'))
const require = createRequire(import.meta.url)
const base = require(join(workspace, 'apps/shell/electron-builder.cjs'))
const tag = root.split(/[\\/]/).at(-1).slice('windows-installer-'.length)
const name = `Nawa Validation ${tag}`
const guid = randomUUID()
const appId = `com.nawa.validation.${tag.toLowerCase()}`
const associations = base.fileAssociations.map((entry) => ({
  ...entry,
  name: `${appId}.${entry.ext}`,
  description: entry.description || entry.name,
}))
const include = await readFile(join(workspace, 'apps/shell/build/installer.nsh'), 'utf8')
await writeFile(join(root, 'installer.nsh'), include)
const manifest = {
  root,
  name,
  guid,
  appId,
  installDirectory: join(root, 'installed app with spaces'),
  executable: 'NawaValidation.exe',
  version: require(join(workspace, 'apps/shell/package.json')).version,
  associations,
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const overrides = {
  appId: manifest.appId,
  productName: name,
  executableName: 'NawaValidation',
  directories: { output: join(root, 'package') },
  fileAssociations: associations,
  publish: null,
  nsis: {
    ...base.nsis,
    guid,
    include: join(root, 'installer.nsh'),
    artifactName: 'Nawa-Validation-Setup-${version}.${ext}',
    shortcutName: name,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    runAfterFinish: false,
    allowElevation: false,
  },
}
await writeFile(
  join(root, 'config.cjs'),
  `const base = require(${JSON.stringify(join(workspace, 'apps/shell/electron-builder.cjs'))})\nmodule.exports = { ...base, ...${JSON.stringify(overrides, null, 2)} }\n`,
)
console.log(root)
