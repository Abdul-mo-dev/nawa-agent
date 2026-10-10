import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import { parseFileToRag } from '../src/index'
import {
  buildDocxFixture,
  buildPptxFixture,
  buildXlsxFixture,
  TINY_PNG_BASE64,
  writeFixture,
} from './helpers/fixtures'

it('reads macro-enabled and template OOXML variants with the same structural parser', async () => {
  const presentation = async () => {
    const zip = await JSZip.loadAsync(await buildPptxFixture())
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    )
    return zip.generateAsync({ type: 'uint8array' })
  }
  for (const [extensions, build] of [
    [['docm', 'dotx', 'dotm'], buildDocxFixture],
    [['xltx', 'xltm'], buildXlsxFixture],
    [['pptm', 'ppsx', 'ppsm'], presentation],
  ] as const) {
    const bytes = await build()
    for (const extension of extensions) {
      const result = await parseFileToRag(writeFixture(`variant.${extension}`, bytes))
      expect(result.format).toBe(extension)
      expect(result.blocks.length).toBeGreaterThan(0)
    }
  }
})

it('indexes OCR text from referenced Office images without indexing orphan archive entries', async () => {
  const zip = await JSZip.loadAsync(await buildDocxFixture())
  zip.file('word/media/image1.png', Buffer.from(TINY_PNG_BASE64, 'base64'))
  zip.file('word/media/orphan.png', Buffer.from(TINY_PNG_BASE64, 'base64'))
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '</Relationships>',
  )
  const path = writeFixture('image-report.docx', await zip.generateAsync({ type: 'uint8array' }))
  const recognize = vi.fn(async () => 'Recognized image reference 12345')
  const result = await parseFileToRag(path, { image: recognize })
  expect(recognize).toHaveBeenCalledOnce()
  expect(result.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: 'Recognized image reference 12345',
        locator: expect.stringContaining('word/media/image1.png'),
      }),
    ]),
  )
  expect(result.blocks.some((block) => block.locator.includes('orphan.png'))).toBe(false)
  expect(result.partial).toBe(true)
})
