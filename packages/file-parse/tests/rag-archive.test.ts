import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import { parseFileToRag } from '../src/index'
import { buildPdfFixture, TINY_PNG_BASE64, writeFixture } from './helpers/fixtures'

it('indexes supported ZIP entries with entry locators and OCR', async () => {
  const zip = new JSZip()
  zip.file('notes/summary.txt', 'Project A is ready for launch.')
  zip.file('reports/plan.pdf', buildPdfFixture('Quarterly plan summary'))
  zip.file('images/label.png', Buffer.from(TINY_PNG_BASE64, 'base64'))
  const recognize = vi.fn(async () => 'Image label 45678')
  const result = await parseFileToRag(
    writeFixture('bundle.zip', await zip.generateAsync({ type: 'uint8array' })),
    { image: recognize },
  )
  expect(result.blocks.map((block) => block.text).join('\n')).toContain(
    'Project A is ready for launch.',
  )
  expect(result.blocks.map((block) => block.text).join('\n')).toContain('Quarterly plan summary')
  expect(result.blocks.map((block) => block.text).join('\n')).toContain('Image label 45678')
  expect(
    result.blocks.some((block) => block.locator.includes('ZIP entry reports/plan.pdf, page 1')),
  ).toBe(true)
  expect(recognize).toHaveBeenCalledOnce()
})

it('reports unsupported archive entries instead of treating names as embedded content', async () => {
  const zip = new JSZip()
  zip.file('readme.txt', 'Readable report content.')
  zip.file('nested.zip', 'not another archive')
  const result = await parseFileToRag(
    writeFixture('mixed.zip', await zip.generateAsync({ type: 'uint8array' })),
  )
  expect(result.partial).toBe(true)
  expect(result.warnings.join(' ')).toContain('nested.zip')
  expect(result.blocks.map((block) => block.text).join(' ')).not.toContain('nested.zip')
})

it('rejects an archive whose only entry expands beyond the per-entry limit', async () => {
  const zip = new JSZip()
  zip.file('oversized.txt', 'x'.repeat(17 * 1024 * 1024))
  const path = writeFixture(
    'large-entry.zip',
    await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  )
  await expect(parseFileToRag(path)).rejects.toThrow('no readable supported entries')
})
