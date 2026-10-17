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
const profile = await mkdtemp(join(workspace, '.task', 'macro-office-chat-profile-'))
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
    const kind = sample.target === 'docx' ? 'docs' : sample.target === 'xlsx' ? 'sheets' : 'slides'
    const readTool =
      kind === 'docs'
        ? 'get_document_context'
        : kind === 'sheets'
          ? 'get_workbook_context'
          : 'read_slide'
    const readInput = kind === 'slides' ? { slideIndex: 0 } : {}
    const run = await home.evaluate(
      (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
      source,
    )
    const inspection = await home.evaluate(
      ({ run, source }) => window.nawaDirectory.inspect(run, source),
      { run, source },
    )
    assert.equal(inspection.kind, kind)
    assert.equal(inspection.mode, 'read')
    assert.equal(inspection.path, source)
    assert(
      !inspection.tools.some((tool) =>
        ['insert_content', 'propose_operations', 'apply_ops'].includes(tool.name),
      ),
    )
    const reading = await home.evaluate(
      ({ run, id, name, input }) =>
        window.nawaDirectory.query(run, id, { id: 'read', name, input }),
      { run, id: inspection.id, name: readTool, input: readInput },
    )
    assert(!reading.isError, reading.output)
    assert(!reading.mutated)
    await home.evaluate(({ run, id }) => window.nawaDirectory.closeInspection(run, id), {
      run,
      id: inspection.id,
    })
    const quality = await home.evaluate(
      ({ run, source }) => window.nawaDirectory.validateFile(run, source),
      { run, source },
    )
    assert(quality.checked, JSON.stringify(quality))
    console.log(`${sample.extension}: native read-only folder chat passed`)
    const marker = `Folder chat edit verified for ${sample.extension}.`
    const proposal = await home.evaluate(
      ({ run, source, marker }) =>
        window.nawaDirectory.propose(run, {
          operation: 'update',
          path: source,
          instruction: `Add this text: ${marker}`,
        }),
      { run, source, marker },
    )
    assert.equal(proposal.operation, 'update')
    assert.equal(proposal.sourcePath, undefined)
    assert.equal(proposal.path, source)
    const description = await home.evaluate(
      async ({ id, marker }) =>
        window.nawaDirectory.prepare(id, {
          task: `Add this text: ${marker}`,
          settings: await window.aiOffice.getAiSettings(),
        }),
      { id: proposal.id, marker },
    )
    assert.equal(description.kind, kind)
    assert.equal(description.mode, 'edit')
    let call
    if (kind === 'docs') {
      call = {
        id: 'edit',
        name: 'insert_content',
        input: { afterBlockIndex: 0, html: `<p>${marker}</p>` },
      }
    } else if (kind === 'sheets') {
      const sheetId = /Active sheet:[^\n]*\(id=([^,)]+)/.exec(description.context)?.[1]
      assert(sheetId, description.context)
      call = {
        id: 'edit',
        name: 'propose_operations',
        input: {
          operations: [{ op: 'set_cell', sheetId, address: 'A1', value: marker }],
          summary: 'Verify template folder chat edit',
        },
      }
    } else {
      const slide = await home.evaluate(
        (id) =>
          window.nawaDirectory.execute(id, {
            id: 'context',
            name: 'read_slide',
            input: { slideIndex: 0 },
          }),
        proposal.id,
      )
      assert(!slide.isError, slide.output)
      const block = slide.output
        .split('\n---\n')
        .find((part) => part.includes('Nawa Legacy Office Test'))
      assert(block, slide.output)
      const elementId = /^(\S+)\s*\|/m.exec(block)?.[1]
      assert(elementId, block)
      call = {
        id: 'edit',
        name: 'apply_ops',
        input: {
          ops: [
            {
              op: 'setText',
              target: { slide: 0, el: elementId },
              paragraphs: [{ runs: [{ text: `Nawa Legacy Office Test — ${marker}` }] }],
            },
          ],
        },
      }
    }
    const execution = await home.evaluate(
      ({ id, call }) => window.nawaDirectory.execute(id, call),
      { id: proposal.id, call },
    )
    assert(!execution.isError, execution.output)
    assert(execution.mutated, execution.output)
    const preview = await home.evaluate((id) => window.nawaDirectory.preview(id), proposal.id)
    assert.equal(preview.sourcePath, undefined)
    assert(!preview.beforeText.includes(marker))
    assert(preview.afterText.includes(marker), preview.afterText)
    assert(preview.review.complete, JSON.stringify(preview.review.warnings))
    assert(preview.review.changed > 0)
    assert.equal(sha256(await readFile(source)), sample.sha256)
    const receipt = await home.evaluate((id) => window.nawaDirectory.commit(id), proposal.id)
    assert.equal(receipt.operation, 'update')
    assert.equal(receipt.sourcePath, undefined)
    assert(receipt.backupPath)
    assert.equal(sha256(await readFile(receipt.backupPath)), sample.sha256)
    assert.equal(receipt.path, proposal.path)
    const saved = await JSZip.loadAsync(await readFile(receipt.path))
    const types = await saved.file('[Content_Types].xml').async('string')
    assert(types.includes(sample.mainType), types)
    assert.equal(sha256(await saved.file(sample.vbaPart).async('nodebuffer')), sample.vbaSha256)
    const part =
      kind === 'docs'
        ? 'word/document.xml'
        : kind === 'sheets'
          ? 'xl/worksheets/sheet1.xml'
          : 'ppt/slides/slide1.xml'
    const xml = await saved.file(part).async('string')
    assert(xml.includes(marker), part)
    if (kind === 'docs' || kind === 'slides') {
      const media = kind === 'docs' ? 'word/media/' : 'ppt/media/'
      assert(Object.keys(saved.files).some((name) => name.startsWith(media)))
    }
    if (kind === 'sheets') {
      assert(xml.includes('00123'), xml)
      assert(xml.includes('SUM($B$2:$B$4)'), xml)
    }
    if (kind === 'slides') {
      assert.equal(
        Object.keys(saved.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
        3,
      )
      assert(saved.file('ppt/charts/chart1.xml'))
    }
    const reopenRun = await home.evaluate(
      (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
      receipt.path,
    )
    const reopened = await home.evaluate(
      ({ run, path }) => window.nawaDirectory.inspect(run, path),
      { run: reopenRun, path: receipt.path },
    )
    const reread = await home.evaluate(
      ({ run, id, name, input }) =>
        window.nawaDirectory.query(run, id, { id: 'reopen', name, input }),
      { run: reopenRun, id: reopened.id, name: readTool, input: readInput },
    )
    assert(!reread.isError, reread.output)
    if (kind !== 'sheets') assert(reread.output.includes(marker), reread.output)
    await home.evaluate((run) => window.nawaDirectory.cancel(run), reopenRun)
    record.passed = true
    record.sourceUnchanged =
      sha256(await readFile(receipt.backupPath)) === sample.sha256 &&
      sha256(await readFile(join(directory, sample.file))) === sample.sha256
    assert(record.sourceUnchanged)
    record.editedFile = receipt.path
      .replaceAll('\\', '/')
      .slice(directory.replaceAll('\\', '/').length + 1)
    record.editTool = call.name
    record.reviewChanges = preview.review.changed
    record.reopened = true
    console.log(`${sample.extension}: native edit, review, macro-format save and reopen passed`)
  }
} finally {
  await app.close()
  const report = {
    testedAt: new Date().toISOString(),
    scope:
      'Built Electron folder-agent IPC, OOXML package normalization, native read/edit tools, before/after review, macro-format in-place commit with backup and untouched VBA bytes and native reopen. No external model requests.',
    cases,
    passed:
      cases.length === 5 &&
      cases.every((record) => record.passed && record.sourceUnchanged && record.reopened),
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const markdown = `# Macro Office folder-chat results\n\nRun: ${report.testedAt}\n\nOverall: **${report.passed ? 'PASS' : 'FAIL'}**\n\n${report.scope}\n\n| Source | Result | Native edit tool | Original unchanged | Saved output | Reopened |\n| --- | --- | --- | --- | --- | --- |\n${cases.map((record) => `| .${record.extension} | ${record.passed ? 'PASS' : 'FAIL'} | ${record.editTool ?? ''} | ${record.sourceUnchanged ? 'Yes' : 'No'} | [Output](${record.editedFile ?? '.'}) | ${record.reopened ? 'Yes' : 'No'} |`).join('\n')}\n`
  await writeFile(join(directory, 'results.md'), await format(markdown, { parser: 'markdown' }))
}
