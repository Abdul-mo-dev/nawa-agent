/* global window */
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const taskDirectory = join(workspace, '.task')
await mkdir(taskDirectory, { recursive: true })
const profile = await mkdtemp(join(taskDirectory, 'legacy-chat-profile-'))
const outputDirectory = await mkdtemp(join(directory, 'chat-edited-'))
await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const require = createRequire(import.meta.url)
const env = {
  ...process.env,
  GENOFFICE_USER_DATA: profile,
  GENOFFICE_NO_SPARE_VIEW: '1',
  GENOFFICE_LANG: 'en',
}
delete env.ELECTRON_RUN_AS_NODE
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const cases = []
const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(workspace, 'apps/shell')],
  env,
  timeout: 60_000,
})
try {
  const home = await app.firstWindow()
  await home.waitForFunction(
    () => !!window.nawaDirectory && !!window.aiOffice?.dropFolderRoots,
    undefined,
    { timeout: 30_000 },
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, outputDirectory)
  const mounted = await home.evaluate(() => window.aiOffice.pickWorkspaceFolder())
  assert(mounted, 'The native folder picker must register the test workspace')
  for (const sample of manifest.files) {
    const record = { extension: sample.extension, file: sample.file, passed: false }
    cases.push(record)
    const originalPath = join(directory, sample.file)
    const source = join(outputDirectory, `source-${sample.extension}.${sample.extension}`)
    await copyFile(originalPath, source)
    const originalHash = sha256(await readFile(source))
    const run = await home.evaluate(
      (path) => window.nawaDirectory.begin({ opened: null, files: [path], directories: [] }),
      source,
    )
    const inspection = await home.evaluate(
      ({ run, source }) => window.nawaDirectory.inspect(run, source),
      { run, source },
    )
    assert.equal(inspection.path, source)
    assert.equal(inspection.mode, 'read')
    assert(inspection.context.includes('converted modern copy'))
    assert(
      !inspection.tools.some((tool) =>
        ['insert_content', 'replace_blocks', 'apply_ops'].includes(tool.name),
      ),
    )
    const reading = await home.evaluate(
      ({ run, inspection }) =>
        window.nawaDirectory.query(run, inspection.id, {
          id: 'read',
          name: inspection.kind === 'docs' ? 'get_document_context' : 'read_slide',
          input: inspection.kind === 'docs' ? {} : { slideIndex: 0 },
        }),
      { run, inspection },
    )
    assert(!reading.isError, reading.output)
    assert(!reading.mutated)
    await home.evaluate(({ run, id }) => window.nawaDirectory.closeInspection(run, id), {
      run,
      id: inspection.id,
    })
    console.log(`${sample.extension}: native read-only chat tools passed`)
    const marker = `Folder chat edit verified for ${sample.extension}.`
    const proposal = await home.evaluate(
      ({ run, source, marker }) =>
        window.nawaDirectory.propose(run, {
          operation: 'update',
          path: source,
          instruction: `Add this sentence: ${marker}`,
        }),
      { run, source, marker },
    )
    assert.equal(proposal.operation, 'create')
    assert.equal(proposal.sourcePath, source)
    assert(proposal.path.endsWith(inspection.kind === 'docs' ? '.docx' : '.pptx'))
    const description = await home.evaluate(
      async ({ id, marker }) =>
        window.nawaDirectory.prepare(id, {
          task: `Add this sentence: ${marker}`,
          settings: await window.aiOffice.getAiSettings(),
        }),
      { id: proposal.id, marker },
    )
    assert.equal(description.mode, 'edit')
    let call
    if (description.kind === 'docs') {
      assert(description.tools.some((tool) => tool.name === 'insert_content'))
      call = {
        id: 'edit',
        name: 'insert_content',
        input: { afterBlockIndex: 0, html: `<p>${marker}</p>` },
      }
    } else {
      const read = await home.evaluate(
        (id) =>
          window.nawaDirectory.execute(id, {
            id: 'context',
            name: 'read_slide',
            input: { slideIndex: 0 },
          }),
        proposal.id,
      )
      assert(!read.isError, read.output)
      const block = read.output
        .split('\n---\n')
        .find((part) => part.includes('Nawa Legacy Office Test'))
      assert(block, read.output)
      const id = /^(\S+)\s*\|/m.exec(block)?.[1]
      assert(id, block)
      call = {
        id: 'edit',
        name: 'apply_ops',
        input: {
          ops: [
            {
              op: 'setText',
              target: { slide: 0, el: id },
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
    assert.equal(preview.sourcePath, source)
    assert(preview.beforeText.includes('Nawa Legacy Office Test'))
    assert(!preview.beforeText.includes(marker))
    assert(preview.afterText.includes(marker), preview.afterText)
    assert(preview.review.complete, JSON.stringify(preview.review.warnings))
    assert(preview.review.changed > 0)
    assert.equal(sha256(await readFile(source)), originalHash)
    const receipt = await home.evaluate((id) => window.nawaDirectory.commit(id), proposal.id)
    assert.equal(receipt.operation, 'create')
    assert.equal(receipt.sourcePath, source)
    assert.equal(receipt.path, proposal.path)
    const saved = await JSZip.loadAsync(await readFile(receipt.path))
    const part = description.kind === 'docs' ? 'word/document.xml' : 'ppt/slides/slide1.xml'
    assert((await saved.file(part).async('string')).includes(marker))
    const mediaPrefix = description.kind === 'docs' ? 'word/media/' : 'ppt/media/'
    assert(
      Object.keys(saved.files).some(
        (name) => name.startsWith(mediaPrefix) && !saved.files[name].dir,
      ),
    )
    if (description.kind === 'slides') {
      assert.equal(
        Object.keys(saved.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
        3,
      )
      assert(saved.file('ppt/charts/chart1.xml'))
      const chart = await saved.file('ppt/charts/chart1.xml').async('string')
      for (const label of ['Q1', 'Q2', 'Q3']) assert(chart.includes(label))
    }
    record.passed = true
    record.editedFile = receipt.path
      .replaceAll('\\', '/')
      .slice(directory.replaceAll('\\', '/').length + 1)
    record.originalUnchanged =
      sha256(await readFile(source)) === originalHash &&
      sha256(await readFile(originalPath)) === sample.sha256
    assert(record.originalUnchanged)
    record.reviewChanges = preview.review.changed
    record.inspectionTools = inspection.tools.map((tool) => tool.name)
    record.editTool = call.name
    console.log(
      `${sample.extension}: native chat edit, review, modern save and source preservation passed`,
    )
    await home.evaluate((id) => window.nawaDirectory.cancel(id), run)
  }
} finally {
  await app.close()
  const report = {
    testedAt: new Date().toISOString(),
    scope:
      'Built Electron folder-agent IPC, real LibreOffice imports, real native chat read/edit tools, before/after review and modern-copy commits. Provider streaming is covered separately by a deterministic chat-loop regression test.',
    cases,
    passed:
      cases.length === 5 && cases.every((record) => record.passed && record.originalUnchanged),
  }
  await writeFile(join(directory, 'chat-report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(
    join(directory, 'chat-results.md'),
    `# Legacy Office folder chat results\n\nRun: ${report.testedAt}\n\nOverall: **${report.passed ? 'PASS' : 'FAIL'}**\n\n${report.scope}\n\n| Input | Result | Native edit tool | Original unchanged | Saved modern copy |\n| --- | --- | --- | --- | --- |\n${cases.map((record) => `| .${record.extension} | ${record.passed ? 'PASS' : 'FAIL'} | ${record.editTool ?? ''} | ${record.originalUnchanged ? 'Yes' : 'No'} | [Output](${record.editedFile ?? '.'}) |`).join('\n')}\n`,
  )
}
