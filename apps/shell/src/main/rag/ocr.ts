import type { OcrLine, OcrRecognition } from '../../../../../packages/pdf2docx/src/ocr'
import { renderPagePng } from '../../../../../packages/pdf2docx/src/extract'
import { withPdfDocument } from '../../../../../packages/pdf2docx/src/extract/pdfium'
import { ensureOcrEngine, ensurePdfium } from '../pdf2docx-local'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function imagePng(bytes: Uint8Array): Promise<Buffer> {
  const packaged = process.resourcesPath
    ? join(process.resourcesPath, 'embedding', 'node_modules', 'sharp', 'package.json')
    : ''
  const sharpModule =
    packaged && existsSync(packaged)
      ? await import(pathToFileURL(createRequire(packaged).resolve('sharp')).href)
      : await import('sharp')
  const sharp = sharpModule.default as unknown as (
    input: Uint8Array,
    options: { limitInputPixels: number; animated: boolean },
  ) => import('sharp').Sharp
  const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height)
    throw new Error('Image dimensions are unavailable for local OCR.')
  return image.rotate().png().toBuffer()
}

function recognizedText(result: OcrRecognition | null): string | null {
  if (!result) return null
  const lines = result.lines.filter(
    (line: OcrLine) =>
      line.text.trim() && Number.isFinite(line.confidence) && line.confidence >= 0.3,
  )
  if (!lines.length || lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length < 0.55)
    return null
  return lines
    .sort((a, b) => b.box.y1 - a.box.y1 || a.box.x0 - b.box.x0)
    .map((line) => line.text.trim())
    .join('\n')
}

export async function ocrPdfPages(
  bytes: Uint8Array,
  pages: number[],
  signal: AbortSignal,
  onPage?: (page: number) => void,
): Promise<Map<number, string>> {
  const engine = ensureOcrEngine(),
    recovered = new Map<number, string>()
  if (!engine || !pages.length) return recovered
  const pdfium = await ensurePdfium()
  signal.throwIfAborted()
  withPdfDocument(pdfium, bytes, (document) => {
    const count = pdfium._FPDF_GetPageCount(document)
    for (const number of pages) {
      signal.throwIfAborted()
      onPage?.(number)
      if (number < 1 || number > count) continue
      const page = pdfium._FPDF_LoadPage(document, number - 1)
      if (!page) continue
      try {
        const width = pdfium._FPDF_GetPageWidthF(page),
          height = pdfium._FPDF_GetPageHeightF(page)
        if (width <= 0 || height <= 0 || width * height * 9 > 20_000_000) continue
        const render = renderPagePng(pdfium, page, 3)
        if (!render) continue
        const text = recognizedText(engine(render.data, { widthPt: width, heightPt: height }))
        if (text && [...text].filter((char) => !/\s/.test(char)).length >= 8)
          recovered.set(number, text)
      } finally {
        pdfium._FPDF_ClosePage(page)
      }
    }
  })
  return recovered
}

export async function ocrImage(bytes: Uint8Array, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  const engine = ensureOcrEngine()
  if (!engine) return null
  // Normalize still frames to PNG; the packaged helpers share a PNG input contract.
  const png = await imagePng(bytes)
  signal.throwIfAborted()
  const text = recognizedText(engine(png, { widthPt: 0, heightPt: 0 }))
  signal.throwIfAborted()
  return text
}
