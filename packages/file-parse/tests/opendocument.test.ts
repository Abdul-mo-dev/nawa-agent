import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseFileToText, parseFileToRag } from '../src'
import { openDocumentRag } from '../src/opendocument'
import { writeFixture } from './helpers/fixtures'

const ns = 'urn:oasis:names:tc:opendocument:xmlns:'
async function fixture(content: string, manifest?: string, mime = 'text') {
  const zip = new JSZip()
  zip.file('mimetype', `application/vnd.oasis.opendocument.${mime}`)
  zip.file('META-INF/manifest.xml', manifest ?? `<m:manifest xmlns:m="${ns}manifest:1.0"/>`)
  zip.file(
    'content.xml',
    `<o:document-content xmlns:o="${ns}office:1.0" xmlns:t="${ns}text:1.0"><o:body><o:text>${content}</o:text></o:body></o:document-content>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

it.each([
  ['odt', 'document-sample.odt'],
  ['odp', 'presentation-sample.odp'],
] as const)('extracts real .%s fixtures for chat attachments and search', async (ext, file) => {
  const path = resolve(import.meta.dirname, '../../../test-files/opendocument', file)
  const text = await parseFileToText(path)
  expect(text.ok).toBe(true)
  expect(text.text).toContain('Nawa Legacy Office Test')
  expect(text.text).toContain('テスト')
  const rag = await parseFileToRag(path)
  expect(rag.format).toBe(ext)
  expect(rag.partial).toBe(true)
  expect(rag.blocks.length).toBeGreaterThan(5)
  if (ext === 'odp') {
    expect(new Set(rag.blocks.map((b) => b.slide))).toEqual(new Set([1, 2, 3]))
    expect(rag.blocks.some((b) => b.text.includes('fixture notes on slide 1'))).toBe(true)
  }
})

it('preserves inline spans, Unicode, tabs, spaces and line breaks in saved text', async () => {
  const bytes = await fixture(
    '<t:p>こんにちは<t:s t:c="3"/><t:span>world</t:span><t:tab/>1<t:line-break/>2 &amp; 3</t:p>',
  )
  const result = await parseFileToText(writeFixture('inline.odt', bytes))
  expect(result.text).toBe('こんにちは   world\t1\n2 & 3')
})

it('rejects encrypted packages, mismatched MIME types and XML entity declarations', async () => {
  const encrypted = await fixture(
    '<t:p>secret</t:p>',
    `<m:manifest xmlns:m="${ns}manifest:1.0"><m:encryption-data/></m:manifest>`,
  )
  await expect(openDocumentRag(encrypted, 'locked.odt', 'odt')).rejects.toThrow(
    'Password-protected',
  )
  await expect(
    openDocumentRag(await fixture('<t:p>x</t:p>', undefined, 'presentation'), 'wrong.odt', 'odt'),
  ).rejects.toThrow('MIME')
  await expect(
    openDocumentRag(
      await fixture('<!DOCTYPE x [<!ENTITY a "bad">]><t:p>&a;</t:p>'),
      'entity.odt',
      'odt',
    ),
  ).rejects.toThrow('XML')
  await expect(
    openDocumentRag(await fixture('<t:p>unclosed'), 'broken.odt', 'odt'),
  ).rejects.toThrow('XML')
})

it('bounds XML text expansion and actual ZIP inflation', async () => {
  await expect(
    openDocumentRag(await fixture('<t:p><t:s t:c="999999999"/></t:p>'), 'huge.odt', 'odt'),
  ).rejects.toThrow('expansion limit')
  const zip = new JSZip()
  zip.file('content.xml', 'a'.repeat(16 * 1024 * 1024 + 1))
  await expect(
    openDocumentRag(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      'bomb.odt',
      'odt',
    ),
  ).rejects.toThrow('limit')
})
