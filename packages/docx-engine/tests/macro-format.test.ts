import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { parseDocx, saveDocx } from '../src'

const source = resolve('../../test-files/docm-chat/sample.docm')
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

it('edits a DOCM paragraph without dropping or changing its VBA project', async () => {
  const bytes = await readFile(source)
  const parsed = await parseDocx(bytes)
  const edited = await saveDocx(parsed, [
    ...parsed.blocks.flatMap((block) =>
      block.docxIndex == null ? [] : [{ kind: 'original' as const, docxIndex: block.docxIndex }],
    ),
    { kind: 'xml', xml: '<w:p><w:r><w:t>DOCM edit verified.</w:t></w:r></w:p>' },
  ])
  const original = await JSZip.loadAsync(bytes)
  const saved = await JSZip.loadAsync(edited)
  expect(await saved.file('word/document.xml')!.async('string')).toContain('DOCM edit verified.')
  expect(await saved.file('[Content_Types].xml')!.async('string')).toContain(
    'application/vnd.ms-word.document.macroEnabled.main+xml',
  )
  expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).toContain(
    'relationships/vbaProject',
  )
  expect(sha256(await saved.file('word/vbaProject.bin')!.async('nodebuffer'))).toBe(
    sha256(await original.file('word/vbaProject.bin')!.async('nodebuffer')),
  )
  expect((await parseDocx(edited)).blocks.length).toBeGreaterThan(parsed.blocks.length)
})
