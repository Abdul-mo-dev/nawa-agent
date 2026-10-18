import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PNG } from 'pngjs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
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
    const canvas = createCanvas(8, 6)
    canvas.getContext('2d').fillRect(0, 0, 8, 6)
    const source = await canvas.encode(format)
    expect(await ocrImage(source, new AbortController().signal)).toBe('Recognized image')
    expect(recognition).toHaveBeenCalledOnce()
    const normalized = recognition.mock.calls[0]![0] as Uint8Array
    expect(PNG.sync.read(Buffer.from(normalized))).toMatchObject({ width: 8, height: 6 })
  },
)

it('resolves the packaged canvas entry from its package exports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nawa-packaged-canvas-'))
  temporaryDirectories.push(directory)
  const packageDirectory = join(directory, 'image', 'node_modules', '@napi-rs', 'canvas')
  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@napi-rs/canvas',
      exports: { '.': './dist/index.cjs' },
    }),
  )
  const marker = join(directory, 'packaged-canvas-loaded')
  const actualCanvas = createRequire(import.meta.url).resolve('@napi-rs/canvas')
  writeFileSync(
    join(packageDirectory, 'dist', 'index.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\nmodule.exports = require(${JSON.stringify(actualCanvas)});\n`,
  )
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: directory })
  const source = await createCanvas(8, 6).encode('png')
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

it('loads the built text embedding runtime and rejects image tasks', async () => {
  const runtime = await import(
    pathToFileURL(resolve(__dirname, '../out/embedding/runtime.mjs')).href
  )
  expect(runtime.env).toBeDefined()
  expect(() => runtime.pipeline('image-to-text', 'unused')).toThrow('text only')
})
