/* global window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
await mkdir(join(workspace, '.task'), { recursive: true })
const profile = await mkdtemp(join(workspace, '.task', 'xltm-ui-profile-'))
const outputs = await mkdtemp(join(directory, 'ui-edited-'))
await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const source = join(outputs, manifest.file)
const savedTemplate = join(outputs, 'saved-template.xltm')
const savedWorkbook = join(outputs, 'saved-workbook.xlsm')
await copyFile(join(directory, manifest.file), source)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const env = {
  ...process.env,
  GENOFFICE_USER_DATA: profile,
  GENOFFICE_NO_SPARE_VIEW: '1',
  GENOFFICE_LANG: 'en',
}
delete env.ELECTRON_RUN_AS_NODE
const require = createRequire(import.meta.url)
const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(workspace, 'apps/shell')],
  env,
  timeout: 60_000,
})
const report = { testedAt: new Date().toISOString(), passed: false, source: manifest.file }
const awaitFile = async (path) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const bytes = await readFile(path).catch(() => null)
    if (bytes) return bytes
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${path}`)
}
try {
  const home = await app.firstWindow()
  await home.waitForFunction(() => !!window.aiOffice?.openPath, undefined, { timeout: 30_000 })
  await app.evaluate(({ dialog }) => {
    globalThis.__xltmSave = { path: null, dialogs: [] }
    dialog.showSaveDialog = async (...args) => {
      const state = globalThis.__xltmSave
      state.dialogs.push(args.at(-1))
      return { canceled: !state.path, filePath: state.path || undefined }
    }
  })
  const previousPages = new Set(app.windows())
  await home.evaluate((path) => window.aiOffice.openPath(path), source)
  const deadline = Date.now() + 60_000
  let editor
  while (Date.now() < deadline && !editor) {
    for (const page of app.windows()) {
      if (previousPages.has(page)) continue
      if (page.url().includes('://sheets/')) {
        editor = page
        break
      }
    }
    if (!editor) await app.waitForEvent('window', { timeout: 500 }).catch(() => {})
  }
  assert(editor, 'Sheets did not open the XLTM template')
  const saveAs = editor.getByRole('button', { name: /^Save As/ })
  await saveAs.waitFor({ state: 'visible', timeout: 60_000 })
  await app.evaluate((_electron, path) => {
    globalThis.__xltmSave.path = path
  }, savedTemplate)
  await saveAs.click()
  const templateBytes = await awaitFile(savedTemplate)
  const template = await JSZip.loadAsync(templateBytes)
  assert(
    (await template.file('[Content_Types].xml').async('string')).includes(
      'application/vnd.ms-excel.template.macroEnabled.main+xml',
    ),
  )
  assert.equal(
    sha256(await template.file('xl/vbaProject.bin').async('nodebuffer')),
    manifest.vbaSha256,
  )
  await app.evaluate((_electron, path) => {
    globalThis.__xltmSave.path = path
  }, savedWorkbook)
  await saveAs.click()
  const workbookBytes = await awaitFile(savedWorkbook)
  const workbook = await JSZip.loadAsync(workbookBytes)
  assert(
    (await workbook.file('[Content_Types].xml').async('string')).includes(
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    ),
  )
  assert.equal(
    sha256(await workbook.file('xl/vbaProject.bin').async('nodebuffer')),
    manifest.vbaSha256,
  )
  assert.equal(sha256(await readFile(source)), manifest.sha256)
  const dialogs = await app.evaluate(() => globalThis.__xltmSave.dialogs)
  assert.equal(dialogs.length, 2)
  for (const options of dialogs) {
    const extensions = options.filters.flatMap((filter) => filter.extensions)
    assert(extensions.includes('xltm') && extensions.includes('xlsm'))
  }
  report.passed = true
  report.templateSha256 = sha256(templateBytes)
  report.workbookSha256 = sha256(workbookBytes)
  report.vbaSha256 = manifest.vbaSha256
  report.sourceUnchanged = true
  console.log('xltm: interactive Save As to XLTM and XLSM preserved VBA and source')
} finally {
  await app.close()
  report.testedAt = new Date().toISOString()
  await writeFile(join(directory, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n')
}
