/* global window, requestAnimationFrame */
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const taskDirectory = join(workspace, '.task')
await mkdir(taskDirectory, { recursive: true })
const profile = await mkdtemp(join(taskDirectory, 'legacy-ui-profile-'))
await writeFile(
  join(profile, 'app-settings.json'),
  JSON.stringify({ onboardingSeen: true, defaultSaveDir: join(directory, 'edited') }),
)
const screenshotDirectory = join(directory, 'screenshots')
await mkdir(screenshotDirectory, { recursive: true })
await mkdir(join(directory, 'edited'), { recursive: true })
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const selectedSamples = process.argv[2]
  ? manifest.files.filter((sample) => sample.extension === process.argv[2])
  : manifest.files
assert(selectedSamples.length > 0, 'No sample matches the requested extension')
const require = createRequire(import.meta.url)
const executablePath = require('electron')
const env = {
  ...process.env,
  GENOFFICE_USER_DATA: profile,
  GENOFFICE_NO_SPARE_VIEW: '1',
  GENOFFICE_LANG: 'en',
}
delete env.ELECTRON_RUN_AS_NODE
const cases = []
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const app = await electron.launch({
  executablePath,
  args: [join(workspace, 'apps/shell')],
  env,
  timeout: 60_000,
})
let nativeMessages = []
try {
  const home = await app.firstWindow()
  await home.waitForFunction(() => !!window.aiOffice?.openPath, undefined, { timeout: 30_000 })
  await app.evaluate(({ dialog }) => {
    globalThis.__legacyOfficeTest = { savePath: null, saveDialogs: [], messages: [] }
    dialog.showSaveDialog = async (...args) => {
      const state = globalThis.__legacyOfficeTest
      state.saveDialogs.push(args.at(-1))
      return { canceled: !state.savePath, filePath: state.savePath || undefined }
    }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      globalThis.__legacyOfficeTest.messages.push({
        type: options.type,
        message: options.message,
        detail: options.detail,
      })
      return { response: options.type === 'warning' ? 1 : 0, checkboxChecked: false }
    }
  })
  for (const sample of selectedSamples) {
    const row = { file: sample.file, passed: false }
    cases.push(row)
    const source = join(directory, sample.file)
    const target = sample.extension === 'doc' || sample.extension === 'dot' ? 'docx' : 'pptx'
    const kind = target === 'docx' ? 'docs' : 'slides'
    const previousPages = new Set(app.windows())
    try {
      await home.evaluate((path) => window.aiOffice.openPath(path), source)
      const deadline = Date.now() + 60_000
      let editor
      while (Date.now() < deadline && !editor) {
        for (const page of app.windows()) {
          if (previousPages.has(page)) continue
          const href =
            page.url() || (await page.evaluate(() => window.location.href).catch(() => ''))
          if (href.includes(`://${kind}/`)) {
            editor = page
            break
          }
        }
        if (!editor) await app.waitForEvent('window', { timeout: 500 }).catch(() => {})
      }
      assert(editor, `No editor page opened for ${sample.file}`)
      const marker = `UI edit verified for ${sample.extension.toUpperCase()}.`
      if (kind === 'docs') {
        await editor.waitForFunction(
          () => window.__aidocs?.editor?.state.doc.textContent.includes('Nawa Legacy Office Test'),
          undefined,
          { timeout: 60_000 },
        )
        const content = await editor.evaluate(() => window.__aidocs.editor.state.doc.textContent)
        for (const text of ['Nawa Legacy Office Test', 'テスト文書', 'مرحبا بالعالم', 'Notebook'])
          assert(content.includes(text), `Missing ${text}`)
        row.renderedTables = await editor.locator('.doc-page table').count()
        assert(row.renderedTables >= 1, 'Table was not rendered')
        await editor.screenshot({
          path: join(screenshotDirectory, `${sample.extension}-opened.png`),
        })
        await editor.evaluate((text) => {
          const editor = window.__aidocs.editor
          editor.commands.insertContentAt(editor.state.doc.content.size - 1, ` ${text}`)
        }, marker)
        await editor.waitForFunction(
          (text) => window.__aidocs.editor.state.doc.textContent.includes(text),
          marker,
        )
        await editor.evaluate(
          () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)),
        )
        await app.evaluate(() => {
          globalThis.__legacyOfficeTest.savePath = null
        })
        assert.equal(
          await editor.evaluate(() => window.__aidocs.save()),
          false,
          'Canceled save unexpectedly succeeded',
        )
        row.canceledSaveRetainedEdits = await editor.evaluate(
          (text) => window.__aidocs.editor.state.doc.textContent.includes(text),
          marker,
        )
        assert(row.canceledSaveRetainedEdits)
        await app.evaluate((_electron, path) => {
          globalThis.__legacyOfficeTest.savePath = path
        }, source)
        assert.equal(
          await editor.evaluate(() => window.__aidocs.save()),
          false,
          'Legacy overwrite was allowed',
        )
        const output = join(directory, 'edited', `ui-document-sample-${sample.extension}.docx`)
        await app.evaluate((_electron, path) => {
          globalThis.__legacyOfficeTest.savePath = path
        }, output)
        const modernSave = await editor.evaluate(() => window.__aidocs.save())
        const status = await editor.evaluate(() => window.__aidocs.getStatus())
        assert.equal(modernSave, true, `Modern save failed: ${status}`)
        const zip = await JSZip.loadAsync(await readFile(output))
        assert(
          (await zip.file('word/document.xml').async('string')).includes(marker),
          'Saved Word edit missing',
        )
        await editor.evaluate((path) => window.__aidocs.openPath(path), output)
        await editor.waitForFunction(
          (text) => window.__aidocs.editor.state.doc.textContent.includes(text),
          marker,
          { timeout: 30_000 },
        )
        row.editedFile = `edited/ui-document-sample-${sample.extension}.docx`
      } else {
        await editor.waitForFunction(
          async () => (await window.slidesApi?.getRenderSlides())?.length === 3,
          undefined,
          { timeout: 60_000 },
        )
        await editor
          .locator('.stage-wrap canvas')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 })
        await editor.screenshot({
          path: join(screenshotDirectory, `${sample.extension}-opened.png`),
        })
        const chartPresent = await editor.evaluate(async () => {
          const slides = await window.slidesApi.getRenderSlides()
          return slides[1].nodes.some((node) => node.type === 'chart')
        })
        assert(chartPresent, 'Imported chart missing from the render tree')
        await editor.locator('.thumb').nth(1).click()
        await editor.evaluate(
          () =>
            new Promise((resolveFrame) =>
              requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
            ),
        )
        await editor.screenshot({
          path: join(screenshotDirectory, `${sample.extension}-chart.png`),
        })
        await editor.locator('.thumb').first().click()
        row.renderedChart = true
        const returned = await editor.evaluate(async (text) => {
          const slides = await window.slidesApi.getRenderSlides()
          const node = slides[0].nodes.find((node) =>
            node.text?.lines
              ?.map((line) => line.runs.map((run) => run.text || '').join(''))
              .join('\n')
              .includes('Nawa Legacy Office Test'),
          )
          if (!node)
            throw new Error(
              `Title textbox not found in render tree: ${JSON.stringify(slides[0].nodes[0]).slice(0, 2000)}`,
            )
          const result = await window.slidesApi.editText({
            slideIndex: 0,
            sourceId: node.sourceId,
            paragraphs: [{ runs: [{ text }] }],
          })
          return { edited: !!result, slideCount: slides.length }
        }, marker)
        assert(returned.edited)
        row.renderedSlides = returned.slideCount
        await app.evaluate(() => {
          globalThis.__legacyOfficeTest.savePath = null
        })
        assert.equal(
          (await editor.evaluate(() => window.slidesApi.save())).ok,
          false,
          'Canceled save unexpectedly succeeded',
        )
        assert.equal(
          await editor.evaluate(() => window.slidesApi.isDirty()),
          true,
          'Canceled save lost dirty state',
        )
        row.canceledSaveRetainedEdits = true
        await app.evaluate((_electron, path) => {
          globalThis.__legacyOfficeTest.savePath = path
        }, source)
        assert.equal(
          (await editor.evaluate(() => window.slidesApi.save())).ok,
          false,
          'Legacy overwrite was allowed',
        )
        const output = join(directory, 'edited', `ui-presentation-sample-${sample.extension}.pptx`)
        await app.evaluate((_electron, path) => {
          globalThis.__legacyOfficeTest.savePath = path
        }, output)
        const saved = await editor.evaluate(() => window.slidesApi.save())
        assert(saved.ok, saved.error || 'Modern save failed')
        const reopened = await editor.evaluate(
          (path) => window.slidesApi.openPptxPath(path, 1280),
          output,
        )
        assert.equal(reopened.slides.length, 3)
        const zip = await JSZip.loadAsync(await readFile(output))
        assert(
          (await zip.file('ppt/slides/slide1.xml').async('string')).includes(marker),
          'Saved presentation edit missing',
        )
        row.editedFile = `edited/ui-presentation-sample-${sample.extension}.pptx`
      }
      row.sourceUnchanged = sha256(await readFile(source)) === sample.sha256
      assert(row.sourceUnchanged, 'Original source changed')
      row.screenshot = `screenshots/${sample.extension}-opened.png`
      row.passed = true
      console.log(
        `PASS ${sample.file}: rendered, edited, cancellation preserved, saved and reopened; source unchanged`,
      )
    } catch (error) {
      row.error = error.message
      row.sourceUnchanged = sha256(await readFile(source)) === sample.sha256
      console.log(`FAIL ${sample.file}: ${error.message}`)
    }
  }
  nativeMessages = await app.evaluate(() => globalThis.__legacyOfficeTest.messages)
} finally {
  await writeFile(
    join(directory, process.argv[2] ? `ui-report-${process.argv[2]}.json` : 'ui-report.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        cases,
        nativeMessages,
        passed: cases.length === selectedSamples.length && cases.every((row) => row.passed),
      },
      null,
      2,
    ) + '\n',
  )
  const childProcess = app.process()
  const timeout = setTimeout(() => {
    if (childProcess.exitCode === null) childProcess.kill('SIGKILL')
  }, 20_000)
  try {
    await app.close()
  } finally {
    clearTimeout(timeout)
  }
}
if (cases.length !== selectedSamples.length || !cases.every((row) => row.passed))
  process.exitCode = 1
