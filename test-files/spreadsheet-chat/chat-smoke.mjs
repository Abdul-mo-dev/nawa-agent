/* global window */
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { format } from 'prettier'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
await mkdir(join(workspace, '.task'), { recursive: true })
const profile = await mkdtemp(join(workspace, '.task', 'spreadsheet-chat-profile-'))
const outputs = await mkdtemp(join(directory, 'edited-'))
await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
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
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const cases = []
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
  for (const sample of manifest.files) {
    const record = { extension: sample.extension, passed: false }
    cases.push(record)
    const source = join(outputs, sample.file)
    await copyFile(join(directory, sample.file), source)
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
    const readRange = ['csv', 'tsv'].includes(sample.extension) ? 'A1:C3' : 'A1'
    const reading = await home.evaluate(
      ({ run, id, range }) =>
        window.nawaDirectory.query(run, id, {
          id: 'read',
          name: 'read_range',
          input: { range },
        }),
      { run, id: inspection.id, range: readRange },
    )
    assert(!reading.isError, reading.output)
    assert(!reading.mutated)
    if (['csv', 'tsv'].includes(sample.extension)) {
      assert(reading.output.includes('00123'), reading.output)
      assert(reading.output.includes('alpha,beta,gamma,delta'), reading.output)
      assert(reading.output.includes('日本語'), reading.output)
    }
    await home.evaluate(({ run, id }) => window.nawaDirectory.closeInspection(run, id), {
      run,
      id: inspection.id,
    })
    console.log(`${sample.extension}: native read-only spreadsheet chat tools passed`)
    let existingSibling
    if (sample.extension === 'csv') {
      existingSibling = source.replace(/\.[^.]+$/, '.xlsx')
      await copyFile(join(directory, 'source/binary.xlsx'), existingSibling)
      record.existingSiblingHash = sha256(await readFile(existingSibling))
    }
    const marker = `Folder spreadsheet chat edit verified for ${sample.extension}.`
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
    assert.equal(proposal.sourcePath, source)
    assert(proposal.path.endsWith('.xlsx'))
    if (existingSibling) assert.notEqual(proposal.path, existingSibling)
    const description = await home.evaluate(
      async ({ id, marker }) =>
        window.nawaDirectory.prepare(id, {
          task: `Set A1 to: ${marker}`,
          settings: await window.aiOffice.getAiSettings(),
        }),
      { id: proposal.id, marker },
    )
    assert.equal(description.kind, 'sheets')
    const sheetId = /Active sheet:[^\n]*\(id=([^,)]+)/.exec(description.context)?.[1]
    assert(sheetId, description.context)
    const execution = await home.evaluate(
      ({ id, sheetId, marker }) =>
        window.nawaDirectory.execute(id, {
          id: 'edit',
          name: 'propose_operations',
          input: {
            operations: [{ op: 'set_cell', sheetId, address: 'A1', value: marker }],
            summary: 'Verify folder spreadsheet chat editing',
          },
        }),
      { id: proposal.id, sheetId, marker },
    )
    assert(!execution.isError, execution.output)
    assert(execution.mutated, execution.output)
    const preview = await home.evaluate((id) => window.nawaDirectory.preview(id), proposal.id)
    assert.equal(preview.sourcePath, source)
    assert(!preview.beforeText.includes(marker))
    assert(preview.afterText.includes(marker), preview.afterText)
    assert(preview.review.complete, JSON.stringify(preview.review.warnings))
    assert(preview.review.changed > 0)
    if (sample.extension === 'ods')
      assert(
        preview.review.warnings.some((text) => text.includes('cached values: 1')),
        JSON.stringify(preview.review.warnings),
      )
    assert.equal(sha256(await readFile(source)), sample.sha256)
    const receipt = await home.evaluate((id) => window.nawaDirectory.commit(id), proposal.id)
    assert.equal(receipt.operation, 'create')
    assert.equal(receipt.sourcePath, source)
    assert.equal(receipt.path, proposal.path)
    const saved = await JSZip.loadAsync(await readFile(receipt.path))
    const xml = await saved.file('xl/worksheets/sheet1.xml').async('string')
    assert(xml.includes(marker), xml)
    if (['csv', 'tsv', 'xls'].includes(sample.extension)) {
      assert(xml.includes('00123'), xml)
      assert(xml.includes('日本語'), xml)
      assert(xml.includes('=1+1'), xml)
    }
    if (sample.extension === 'xls') {
      assert(xml.includes('SUM($B$2:$B$4)'), xml)
      assert(xml.includes('<c r="B5"><v>22.5</v></c>'), xml)
      assert(!xml.includes('USN'), xml)
    }
    if (existingSibling)
      assert.equal(sha256(await readFile(existingSibling)), record.existingSiblingHash)
    // A new explicit selection reopens the saved bytes through the native read bridge.
    const reopenRun = await home.evaluate(
      (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
      receipt.path,
    )
    const reopened = await home.evaluate(
      ({ run, path }) => window.nawaDirectory.inspect(run, path),
      { run: reopenRun, path: receipt.path },
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
    record.passed = true
    record.sourceUnchanged =
      sha256(await readFile(source)) === sample.sha256 &&
      sha256(await readFile(join(directory, sample.file))) === sample.sha256
    assert(record.sourceUnchanged)
    record.editedFile = receipt.path
      .replaceAll('\\', '/')
      .slice(directory.replaceAll('\\', '/').length + 1)
    record.reviewChanges = preview.review.changed
    record.importWarnings = preview.review.warnings
    record.reopened = true
    console.log(
      `${sample.extension}: native chat edit, review, XLSX save/reopen and source preservation passed`,
    )
  }
} finally {
  await app.close()
  const report = {
    testedAt: new Date().toISOString(),
    scope:
      'Built Electron folder-agent IPC, actual Sheets converters, native read/edit tools, before/after review, XLSX-copy commit and native reopen. No external model requests.',
    cases,
    passed:
      cases.length === 5 &&
      cases.every((record) => record.passed && record.sourceUnchanged && record.reopened),
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const markdown = `# Spreadsheet folder-chat results\n\nRun: ${report.testedAt}\n\nOverall: **${report.passed ? 'PASS' : 'FAIL'}**\n\n${report.scope}\n\n| Source | Result | Original unchanged | Saved output | Reopened |\n| --- | --- | --- | --- | --- |\n${cases.map((record) => `| .${record.extension} | ${record.passed ? 'PASS' : 'FAIL'} | ${record.sourceUnchanged ? 'Yes' : 'No'} | [XLSX](${record.editedFile ?? '.'}) | ${record.reopened ? 'Yes' : 'No'} |`).join('\n')}\n`
  await writeFile(join(directory, 'results.md'), await format(markdown, { parser: 'markdown' }))
}
