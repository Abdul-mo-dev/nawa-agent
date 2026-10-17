/* global window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import JSZip from 'jszip'
import { format } from 'prettier'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
await mkdir(join(workspace, '.task'), { recursive: true })
const profile = await mkdtemp(join(workspace, '.task', 'xltm-chat-profile-'))
const outputs = await mkdtemp(join(directory, 'edited-'))
await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const source = join(outputs, manifest.file)
const target = join(outputs, manifest.file.replace(/\.xltm$/i, '.xlsm'))
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
const report = {
  testedAt: new Date().toISOString(),
  scope:
    'Built Electron folder-agent IPC, private XLTM inspection and validation, native Sheets edit, before/after review, sibling XLSM save and native reopen. The template and VBA bytes are verified unchanged. No external model requests.',
  passed: false,
  source: manifest.file,
}
try {
  const home = await app.firstWindow()
  await home.waitForFunction(
    () => !!window.nawaDirectory && !!window.aiOffice?.pickWorkspaceFolder,
    undefined,
    { timeout: 30_000 },
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, outputs)
  assert(await home.evaluate(() => window.aiOffice.pickWorkspaceFolder()))
  const run = await home.evaluate(
    (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
    source,
  )
  const inspection = await home.evaluate(
    ({ run, source }) => window.nawaDirectory.inspect(run, source),
    { run, source },
  )
  assert.equal(inspection.kind, 'sheets')
  assert.equal(inspection.mode, 'read')
  assert.equal(inspection.path, source)
  assert(!inspection.tools.some((tool) => tool.name === 'propose_operations'))
  const reading = await home.evaluate(
    ({ run, id }) =>
      window.nawaDirectory.query(run, id, {
        id: 'read',
        name: 'read_range',
        input: { range: 'A1:C3' },
      }),
    { run, id: inspection.id },
  )
  assert(!reading.isError, reading.output)
  assert(reading.output.includes('00123'), reading.output)
  assert(reading.output.includes('日本語'), reading.output)
  await home.evaluate(({ run, id }) => window.nawaDirectory.closeInspection(run, id), {
    run,
    id: inspection.id,
  })
  const quality = await home.evaluate(
    ({ run, source }) => window.nawaDirectory.validateFile(run, source),
    { run, source },
  )
  assert(quality.checked, JSON.stringify(quality))
  const marker = 'Folder chat XLTM edit verified.'
  const proposal = await home.evaluate(
    ({ run, source, marker }) =>
      window.nawaDirectory.propose(run, {
        operation: 'update',
        path: source,
        instruction: `Set A1 to: ${marker}`,
      }),
    { run, source, marker },
  )
  assert.equal(proposal.operation, 'create')
  assert.equal(proposal.path, target)
  assert.equal(proposal.sourcePath, source)
  assert.equal(proposal.beforeHash, null)
  const description = await home.evaluate(
    async ({ id, marker }) =>
      window.nawaDirectory.prepare(id, {
        task: `Set A1 to: ${marker}`,
        settings: await window.aiOffice.getAiSettings(),
      }),
    { id: proposal.id, marker },
  )
  assert.equal(description.kind, 'sheets')
  assert.equal(description.mode, 'edit')
  const sheetId = /Active sheet:[^\n]*\(id=([^,)]+)/.exec(description.context)?.[1]
  assert(sheetId, description.context)
  // Sheets mutations require a read of the affected cells in this editable stage.
  const beforeEdit = await home.evaluate(
    ({ id, sheetId }) =>
      window.nawaDirectory.execute(id, {
        id: 'read-before-edit',
        name: 'read_range',
        input: { range: 'A1:C3', sheetId },
      }),
    { id: proposal.id, sheetId },
  )
  assert(!beforeEdit.isError, beforeEdit.output)
  assert(!beforeEdit.mutated)
  const execution = await home.evaluate(
    ({ id, sheetId, marker }) =>
      window.nawaDirectory.execute(id, {
        id: 'edit',
        name: 'propose_operations',
        input: {
          operations: [{ op: 'set_cell', sheetId, address: 'A1', value: marker }],
          summary: 'Verify macro-enabled template chat edit',
        },
      }),
    { id: proposal.id, sheetId, marker },
  )
  assert(!execution.isError, execution.output)
  assert(execution.mutated, execution.output)
  const preview = await home.evaluate((id) => window.nawaDirectory.preview(id), proposal.id)
  assert.equal(preview.operation, 'create')
  assert.equal(preview.path, target)
  assert.equal(preview.sourcePath, source)
  assert(!preview.beforeText.includes(marker))
  assert(preview.afterText.includes(marker), preview.afterText)
  assert(preview.review.complete, JSON.stringify(preview.review.warnings))
  assert(preview.review.changed > 0)
  assert.equal(sha256(await readFile(source)), manifest.sha256)
  const receipt = await home.evaluate((id) => window.nawaDirectory.commit(id), proposal.id)
  assert.equal(receipt.operation, 'create')
  assert.equal(receipt.path, target)
  assert.equal(receipt.sourcePath, source)
  assert.equal(receipt.backupPath, undefined)
  assert.equal(sha256(await readFile(source)), manifest.sha256)
  const originalTemplate = await JSZip.loadAsync(await readFile(source))
  assert(
    (await originalTemplate.file('[Content_Types].xml').async('string')).includes(
      'application/vnd.ms-excel.template.macroEnabled.main+xml',
    ),
  )
  const savedBytes = await readFile(target)
  assert.notEqual(sha256(savedBytes), manifest.sha256)
  const saved = await JSZip.loadAsync(savedBytes)
  const types = await saved.file('[Content_Types].xml').async('string')
  const relationships = await saved.file('xl/_rels/workbook.xml.rels').async('string')
  const worksheet = await saved.file('xl/worksheets/sheet1.xml').async('string')
  assert(types.includes('application/vnd.ms-excel.sheet.macroEnabled.main+xml'))
  assert(types.includes('application/vnd.ms-office.vbaProject'))
  assert(relationships.includes('relationships/vbaProject'))
  assert.equal(
    sha256(await saved.file('xl/vbaProject.bin').async('nodebuffer')),
    manifest.vbaSha256,
  )
  assert(worksheet.includes(marker), worksheet)
  assert(worksheet.includes('00123'), worksheet)
  assert(worksheet.includes('SUM($B$2:$B$4)'), worksheet)
  const reopenRun = await home.evaluate(
    (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
    target,
  )
  const reopened = await home.evaluate(
    ({ run, source }) => window.nawaDirectory.inspect(run, source),
    { run: reopenRun, source: target },
  )
  const reread = await home.evaluate(
    ({ run, id }) =>
      window.nawaDirectory.query(run, id, {
        id: 'reopen',
        name: 'read_range',
        input: { range: 'A1' },
      }),
    { run: reopenRun, id: reopened.id },
  )
  assert(!reread.isError, reread.output)
  assert(reread.output.includes(marker), reread.output)
  await home.evaluate((run) => window.nawaDirectory.cancel(run), reopenRun)
  assert.equal(sha256(await readFile(join(directory, manifest.file))), manifest.sha256)
  report.passed = true
  report.editedFile = target.replaceAll('\\', '/').slice(directory.replaceAll('\\', '/').length + 1)
  report.sourceSha256 = manifest.sha256
  report.vbaSha256 = manifest.vbaSha256
  report.reviewChanges = preview.review.changed
  report.reopened = true
  console.log(
    'xltm: private inspection, validation, chat edit, review, XLSM sibling save and reopen passed',
  )
} finally {
  await app.close()
  report.testedAt = new Date().toISOString()
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const markdown = `# XLTM folder-chat results\n\nRun: ${report.testedAt}\n\nOverall: **${report.passed ? 'PASS' : 'FAIL'}**\n\n${report.scope}\n\n| Source | Output | Result | VBA preserved | Source unchanged | Reopened |\n| --- | --- | --- | --- | --- | --- |\n| .xltm | .xlsm | ${report.passed ? 'PASS' : 'FAIL'} | ${report.vbaSha256 ? 'Yes' : 'No'} | ${report.sourceSha256 ? 'Yes' : 'No'} | ${report.reopened ? 'Yes' : 'No'} |\n`
  await writeFile(join(directory, 'results.md'), await format(markdown, { parser: 'markdown' }))
}
