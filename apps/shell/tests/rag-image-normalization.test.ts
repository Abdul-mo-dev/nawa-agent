import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { ocrImage } from '../src/main/rag/ocr'

const recognition = vi.hoisted(() => vi.fn())
vi.mock('../src/main/pdf2docx-local', () => ({
  ensureOcrEngine: () => recognition,
  ensurePdfium: vi.fn(),
}))

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const temporaryDirectories: string[] = []

beforeEach(() => {
  recognition.mockReset().mockReturnValue({
    lines: [{ text: 'Recognized image', confidence: 0.9, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
  })
})

afterEach(() => {
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
  'normalizes %s image data to PNG before OCR',
  async (format) => {
    const source = await sharp({
      create: { width: 8, height: 6, channels: 3, background: '#eeeeee' },
    })
      .toFormat(format)
      .toBuffer()
    expect(await ocrImage(source, new AbortController().signal)).toBe('Recognized image')
    expect(recognition).toHaveBeenCalledOnce()
    const normalized = recognition.mock.calls[0]![0] as Uint8Array
    expect(await sharp(normalized).metadata()).toMatchObject({ format: 'png', width: 8, height: 6 })
  },
)

it('resolves the packaged sharp entry from its package exports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nawa-packaged-sharp-'))
  temporaryDirectories.push(directory)
  const packageDirectory = join(directory, 'embedding', 'node_modules', 'sharp')
  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'sharp',
      exports: { '.': './dist/index.cjs' },
    }),
  )
  const marker = join(directory, 'packaged-sharp-loaded')
  const actualSharp = createRequire(import.meta.url).resolve('sharp')
  writeFileSync(
    join(packageDirectory, 'dist', 'index.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\nmodule.exports = require(${JSON.stringify(actualSharp)});\n`,
  )
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: directory })
  const source = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  expect(await ocrImage(source, new AbortController().signal)).toBe('Recognized image')
  expect(readFileSync(marker, 'utf8')).toBe('loaded')
})

it('rejects malformed input before invoking OCR', async () => {
  await expect(
    ocrImage(Buffer.from('not an image'), new AbortController().signal),
  ).rejects.toThrow()
  expect(recognition).not.toHaveBeenCalled()
})

it('retains the input pixel limit while normalizing images', async () => {
  const source = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="5000" height="5000" fill="white"/></svg>',
  )
  await expect(ocrImage(source, new AbortController().signal)).rejects.toThrow(/pixel limit/i)
  expect(recognition).not.toHaveBeenCalled()
})

it('keeps Transformers image decoding and resizing compatible with the shared sharp runtime', async () => {
  const { RawImage } = await import('@huggingface/transformers')
  const source = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#eeeeee' },
  })
    .png()
    .toBuffer()
  const decoded = await RawImage.fromBlob(new Blob([new Uint8Array(source)], { type: 'image/png' }))
  expect([decoded.width, decoded.height, decoded.channels]).toEqual([8, 6, 3])
  const resized = await decoded.resize(4, 3)
  expect([resized.width, resized.height, resized.channels]).toEqual([4, 3, 3])
  expect(resized.data).toHaveLength(36)
})
