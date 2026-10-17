// @vitest-environment node
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { findLibreOffice, importLegacyOffice } from '@genoffice/electron-utils/legacy-office'

const converter = await findLibreOffice()
describe.skipIf(!converter)('legacy Word import into the Docs engine', () => {
  it.each(['doc', 'dot'])(
    'edits .%s and reopens a modern copy while preserving the original',
    async (extension) => {
      const root = await mkdtemp(join(tmpdir(), 'nawa-docs-legacy-'))
      try {
        const fixture =
          extension === 'doc'
            ? resolve(
                import.meta.dirname,
                '../../../packages/file-parse/tests/fixtures/legacy-sample.doc',
              )
            : resolve(
                import.meta.dirname,
                '../../../packages/electron-utils/tests/fixtures/legacy-office/legacy-sample.dot',
              )
        const source = join(root, `source.${extension}`)
        await copyFile(fixture, source)
        const before = await readFile(source)
        const imported = await importLegacyOffice(source, {
          executablePath: converter!,
          tempRoot: root,
        })
        const parsed = await parseDocx(imported.bytes)
        const saved = await saveDocx(parsed, [
          ...parsed.blocks.flatMap((block) =>
            block.docxIndex == null
              ? []
              : [{ kind: 'original' as const, docxIndex: block.docxIndex }],
          ),
          { kind: 'xml', xml: '<w:p><w:r><w:t>Edited in Nawa</w:t></w:r></w:p>' },
        ])
        await writeFile(imported.suggestSaveAs, saved)
        const reopened = await parseDocx(await readFile(imported.suggestSaveAs))
        expect(reopened.blocks.length).toBeGreaterThan(parsed.blocks.length)
        const zip = await JSZip.loadAsync(saved)
        expect(await zip.file('word/document.xml')!.async('string')).toContain('Edited in Nawa')
        expect(await zip.file('word/document.xml')!.async('string')).toContain(
          'Legacy DOC body text',
        )
        expect(await readFile(source)).toEqual(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
