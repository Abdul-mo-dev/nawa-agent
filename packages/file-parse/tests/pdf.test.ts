import { describe, expect, it } from 'vitest'
import { parseFileToRag, parseFileToText } from '../src/index'
import { buildPdfFixture, writeFixture } from './helpers/fixtures'

describe('parseFileToText: pdf', () => {
  it('extracts page text via pdfjs', async () => {
    const path = writeFixture('doc.pdf', buildPdfFixture('Hello PDF parsing'))
    const result = await parseFileToText(path)
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('text')
    expect(result.text).toContain('Hello PDF parsing')
  })

  it('fails gracefully on a corrupt pdf', async () => {
    const path = writeFixture('broken.pdf', Buffer.from('%PDF-1.4 garbage'))
    const result = await parseFileToText(path)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('indexes local OCR text on a page with no PDF text layer and preserves its page citation', async () => {
    const path = writeFixture('scan.pdf', buildPdfFixture(''))
    const result = await parseFileToRag(path, {
      pdfPages: async (_bytes, pages) => {
        expect(pages).toEqual([1])
        return new Map([[1, 'Recognized invoice number 12345']])
      },
    })
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: 1,
          text: expect.stringContaining('Recognized invoice number 12345'),
        }),
      ]),
    )
    expect(result.warnings.join(' ')).toContain('Local OCR recovered text on pages: 1')
  })
})
