import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import sharp from 'sharp'
import { ocrImage } from '../src/main/rag/ocr'

const fixture = resolve(__dirname, '../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png')
const helper = resolve(__dirname, '../../../packages/pdf2docx/ocr-helper/win-ocr.exe')

it.skipIf(process.platform !== 'win32' || !existsSync(helper))(
  'recognizes image text with the packaged local Windows OCR helper',
  async () => {
    const text = await ocrImage(readFileSync(fixture), new AbortController().signal)
    expect(text).toContain('OCR Smoke Fixture')
    expect(text).toContain('quick brown fox')
  },
)

it.skipIf(process.platform !== 'win32' || !existsSync(helper))(
  'normalizes WebP and GIF images before system OCR',
  async () => {
    const source = readFileSync(fixture)
    for (const format of ['webp', 'gif'] as const) {
      const image = await sharp(source).toFormat(format).toBuffer()
      const text = await ocrImage(image, new AbortController().signal)
      expect(text).toContain('OCR Smoke Fixture')
    }
  },
)
