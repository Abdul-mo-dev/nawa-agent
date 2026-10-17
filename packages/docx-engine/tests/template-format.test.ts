import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { buildBlankDocx, parseDocx, saveDocx } from '../src'
import { bufferSource, normalizeDocxFormat, readZipEntries } from '../src/zip-splice'

it('opens a Word template and saves it as a document without changing compressed media', async () => {
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  zip.file('word/media/untouched.bin', Buffer.from('opaque attachment '.repeat(2000)))
  const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const template = await normalizeDocxFormat(original, 'template.dotx')
  const parsed = await parseDocx(template)
  const saved = await saveDocx(
    parsed,
    parsed.blocks.flatMap((block) =>
      block.docxIndex == null ? [] : [{ kind: 'original' as const, docxIndex: block.docxIndex }],
    ),
  )
  const document = await normalizeDocxFormat(Buffer.from(saved), 'document.docx')
  const restored = await JSZip.loadAsync(document)
  expect(await restored.file('[Content_Types].xml')!.async('text')).toContain(
    'wordprocessingml.document.main+xml',
  )
  expect(
    await (await JSZip.loadAsync(template)).file('[Content_Types].xml')!.async('text'),
  ).toContain('wordprocessingml.template.main+xml')
  const originalEntries = await readZipEntries(bufferSource(original))
  const documentEntries = await readZipEntries(bufferSource(document))
  const before = originalEntries.find((entry) => entry.name === 'word/media/untouched.bin')!
  const after = documentEntries.find((entry) => entry.name === before.name)!
  expect(document.subarray(after.dataOffset, after.dataOffset + after.csize)).toEqual(
    original.subarray(before.dataOffset, before.dataOffset + before.csize),
  )
  expect(await normalizeDocxFormat(document, 'document.docx')).toBe(document)
  const edited = await saveDocx(parsed, [
    ...parsed.blocks.flatMap((block) =>
      block.docxIndex == null ? [] : [{ kind: 'original' as const, docxIndex: block.docxIndex }],
    ),
    { kind: 'xml', xml: '<w:p><w:r><w:t>Template edit</w:t></w:r></w:p>' },
  ])
  const editedTemplate = await JSZip.loadAsync(
    await normalizeDocxFormat(Buffer.from(edited), 'edited.dotx'),
  )
  expect(await editedTemplate.file('[Content_Types].xml')!.async('text')).toContain(
    'wordprocessingml.template.main+xml',
  )
  expect(await editedTemplate.file('word/document.xml')!.async('text')).toContain('Template edit')
})
