import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importLegacyOffice, findLibreOffice } from '@genoffice/electron-utils/legacy-office'
import { parseDocx, saveDocx, type SaveBlock } from '@genoffice/docx-engine'
import { openPptx, getSlideNotes, savePptxToFile, commitSaved } from '@genoffice/pptx-engine'

const directory = import.meta.dirname
const editedDirectory = join(directory, 'edited')
const converter = await findLibreOffice()
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
  files: { file: string; extension: string; sha256: string }[]
}
const records: Record<string, unknown>[] = []
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const markers = ['Nawa Legacy Office Test', 'テスト文書', 'مرحبا بالعالم']
const edit = 'Edited and saved by Nawa sample verification.'

beforeAll(async () => {
  expect(converter, 'LibreOffice must be installed to run sample validation').toBeTruthy()
  await mkdir(editedDirectory, { recursive: true })
})

afterAll(async () => {
  const report = {
    testedAt: new Date().toISOString(),
    converter,
    checks:
      'Real conversion, engine parsing, content checks, editing, save/reopen, source SHA-256, corrupt-input rejection',
    cases: records,
    passed: records.length === 7 && records.every((record) => record.passed === true),
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const table = records
    .map(
      (record) =>
        `| ${record.file} | ${record.passed ? 'PASS' : 'FAIL'} | ${record.editedFile ?? 'Rejected as expected'} | ${record.sourceUnchanged ? 'Yes' : 'No'} |`,
    )
    .join('\n')
  await writeFile(
    join(directory, 'report.md'),
    `# Legacy Office sample results\n\nRun: ${report.testedAt}\n\nOverall: **${report.passed ? 'PASS' : 'FAIL'}**\n\n| Input | Result | Saved output | Original unchanged |\n| --- | --- | --- | --- |\n${table}\n\nThese tests use the actual LibreOffice importer and Nawa engines. They verify\ntext, tables, images, formatting, Unicode, headers/footers or slide notes, and\nsaving edited copies. Structural assertions do not establish pixel-perfect\nlayout equivalence with Microsoft Office. See report.json for detailed counts.\n`,
  )
})

describe('generated legacy Office samples', () => {
  it.each(manifest.files)('imports, edits, and reopens $file', async (sample) => {
    const source = join(directory, sample.file)
    const before = await readFile(source)
    const record: Record<string, unknown> = {
      file: sample.file,
      passed: false,
      sourceUnchanged: false,
    }
    records.push(record)
    try {
      expect(before.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
      expect(sha256(before)).toBe(sample.sha256)
      const imported = await importLegacyOffice(source, {
        executablePath: converter!,
        tempRoot: resolve(directory, '../../.task'),
      })
      const archive = await JSZip.loadAsync(imported.bytes)
      const partNames = Object.keys(archive.files)
      const allXml = (
        await Promise.all(
          partNames
            .filter((name) => name.endsWith('.xml') || name.endsWith('.rels'))
            .map((name) => archive.file(name)!.async('string')),
        )
      ).join('\n')
      for (const marker of markers) expect(allXml).toContain(marker)
      expect(allXml).toContain('https://example.org')
      const media = partNames.filter((name) => /\/(?:media)\/[^/]+$/.test(name))
      expect(media.length).toBeGreaterThan(0)
      expect(allXml).toMatch(/<(?:w:b\b|a:rPr\b[^>]*\bb="1")/)
      if (sample.extension === 'doc' || sample.extension === 'dot') {
        const parsed = await parseDocx(imported.bytes)
        const table = parsed.blocks.find((block) => block.type === 'table')?.table
        expect(table?.rows.length).toBe(4)
        expect(table?.rows[0]?.length).toBe(3)
        expect(table?.rows[2]?.[0]?.paras.join(' ')).toContain('Notebook')
        expect(parsed.blocks.some((block) => block.type === 'image')).toBe(true)
        expect(parsed.blocks.some((block) => block.type === 'listItem')).toBe(true)
        expect(allXml).toContain('Nawa fixture header')
        expect(allXml).toContain('Nawa fixture footer')
        expect(allXml).toMatch(/<w:br\b[^>]*w:type="page"/)
        let replaced = false
        const saved = await saveDocx(
          parsed,
          parsed.blocks.flatMap<SaveBlock>((block) => {
            if (block.docxIndex == null) return []
            if (
              block.runs
                ?.map((run) => run.text)
                .join('')
                .includes('Editable sentence before saving.')
            ) {
              replaced = true
              return [{ kind: 'xml' as const, xml: `<w:p><w:r><w:t>${edit}</w:t></w:r></w:p>` }]
            }
            return [{ kind: 'original' as const, docxIndex: block.docxIndex }]
          }),
        )
        expect(replaced).toBe(true)
        const editedFile = `document-sample-${sample.extension}.docx`
        const outputPath = join(editedDirectory, editedFile)
        await writeFile(outputPath, saved)
        const reopened = await parseDocx(await readFile(outputPath))
        expect(
          reopened.blocks
            .map((block) => block.runs?.map((run) => run.text).join('') ?? '')
            .join('\n'),
        ).toContain(edit)
        expect(reopened.blocks.find((block) => block.type === 'table')?.table?.rows.length).toBe(4)
        expect(reopened.blocks.some((block) => block.type === 'image')).toBe(true)
        record.editedFile = `edited/${editedFile}`
        record.features = {
          table: '4 rows × 3 columns',
          image: true,
          bullets: true,
          unicode: true,
          pageBreak: true,
          header: true,
          footer: true,
          hyperlink: true,
        }
        record.blocks = parsed.blocks.length
      } else {
        const opened = await openPptx(imported.bytes)
        expect(opened.deck.slides.length).toBe(3)
        const elements = opened.deck.slides.flatMap((slide) => slide.elements)
        const table = elements.find((element) => element.type === 'table')
        expect(table?.type).toBe('table')
        if (table?.type === 'table') {
          expect(table.rows.length).toBe(4)
          expect(table.rows[0]?.length).toBe(3)
        }
        expect(elements.some((element) => element.type === 'picture')).toBe(true)
        expect(elements.some((element) => element.type === 'chart')).toBe(true)
        expect(getSlideNotes(opened.archive, opened.deck.slides[1]!.path)).toContain(
          'Nawa legacy fixture notes on slide 2.',
        )
        const editable = opened.deck.slides[2]!.elements.find(
          (element) =>
            (element.type === 'text' || element.type === 'shape') &&
            element.text?.paragraphs.some((paragraph) =>
              paragraph.runs
                .map((run) => run.text)
                .join('')
                .includes('Editable sentence before saving.'),
            ),
        )
        expect(editable).toBeTruthy()
        if (editable?.type !== 'text' && editable?.type !== 'shape')
          throw new Error('Editable textbox was not imported')
        editable.text!.paragraphs = [{ runs: [{ text: edit }] }]
        editable.dirty = true
        const editedFile = `presentation-sample-${sample.extension}.pptx`
        const outputPath = join(editedDirectory, editedFile)
        await savePptxToFile(opened, outputPath)
        commitSaved(opened)
        const reopened = await openPptx(await readFile(outputPath))
        expect(reopened.deck.slides.length).toBe(3)
        expect(
          reopened.deck.slides[2]!.elements.filter(
            (element) => element.type === 'text' || element.type === 'shape',
          )
            .flatMap(
              (element) =>
                element.text?.paragraphs.map((paragraph) =>
                  paragraph.runs.map((run) => run.text).join(''),
                ) ?? [],
            )
            .join('\n'),
        ).toContain(edit)
        expect(getSlideNotes(reopened.archive, reopened.deck.slides[1]!.path)).toContain(
          'Nawa legacy fixture notes on slide 2.',
        )
        record.editedFile = `edited/${editedFile}`
        record.features = {
          slides: 3,
          table: '4 rows × 3 columns',
          image: true,
          chart: true,
          unicode: true,
          notes: true,
          hyperlink: true,
        }
        record.elementTypes = elements.map((element) => element.type)
      }
      record.sourceUnchanged = sha256(await readFile(source)) === sample.sha256
      expect(record.sourceUnchanged).toBe(true)
      record.passed = true
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.sourceUnchanged = sha256(await readFile(source)) === sample.sha256
      throw error
    }
  })

  it.each(['corrupt.doc', 'corrupt.ppt'])('rejects $0 without changing the file', async (file) => {
    const source = join(directory, 'negative', file)
    const before = await readFile(source)
    await expect(
      importLegacyOffice(source, {
        executablePath: converter!,
        tempRoot: resolve(directory, '../../.task'),
      }),
    ).rejects.toMatchObject({ code: 'failed' })
    const unchanged = (await readFile(source)).equals(before)
    expect(unchanged).toBe(true)
    records.push({ file: `negative/${file}`, passed: true, sourceUnchanged: unchanged })
  })
})
