import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCanvas, loadImage, GifEncoder } from '@napi-rs/canvas'
import * as TIFF from 'utif2'
import { PNG } from 'pngjs'
import { decodeStillImage, normalizeImagePng, previewImageBuffers } from '../src/main/image-runtime'

it('keeps transparency in PNG and flattens vision JPEG to white without upscaling', async () => {
  const source = await createCanvas(4, 3).encode('png')
  const result = await previewImageBuffers(source)
  expect(PNG.sync.read(result.png).data[3]).toBe(0)
  const jpeg = await loadImage(result.jpeg)
  expect([jpeg.width, jpeg.height]).toEqual([4, 3])
  const canvas = createCanvas(4, 3)
  canvas.getContext('2d').drawImage(jpeg, 0, 0)
  expect([...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([255, 255, 255, 255])
})

it('bounds vision images while keeping full-size preview pixels', async () => {
  const source = await createCanvas(2000, 1000).encode('png')
  const { png, jpeg } = await previewImageBuffers(source)
  expect(PNG.sync.read(png)).toMatchObject({ width: 2000, height: 1000 })
  const vision = await loadImage(jpeg)
  expect([vision.width, vision.height]).toEqual([1536, 768])
})

it('normalizes JPEG EXIF orientation before OCR and preview', async () => {
  const original = await createCanvas(3, 2).encode('jpeg')
  const exif = Buffer.from(
    'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
    'hex',
  )
  const image = await decodeStillImage(
    Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)]),
  )
  expect([image.width, image.height]).toEqual([2, 3])
})

it('decodes TIFF pixels and orientation while keeping the source untouched', async () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
  const bytes = new Uint8Array(TIFF.encodeImage(rgba.buffer, 2, 1, { t274: [6] }))
  const before = new Uint8Array(bytes)
  const png = PNG.sync.read(await normalizeImagePng(bytes))
  expect([png.width, png.height]).toEqual([1, 2])
  expect([...png.data]).toEqual([...rgba])
  expect(bytes).toEqual(before)
  const fixture = await normalizeImagePng(
    readFileSync(resolve('../../test-files/extended-formats/sample.tiff')),
  )
  expect(PNG.sync.read(fixture).width).toBeGreaterThan(0)
})

it('rejects oversized or malformed images before allocating a drawing surface', async () => {
  await expect(normalizeImagePng(Buffer.from('bad input'))).rejects.toThrow()
  await expect(
    normalizeImagePng(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"/>'),
    ),
  ).rejects.toThrow(/pixel limit/i)
})

it('rejects oversized JPEG frames hidden inside a small TIFF directory', async () => {
  const bytes = new Uint8Array(TIFF.encodeImage(new Uint8Array(16).buffer, 2, 2, { t259: [7] }))
  bytes.set([255, 192, 0, 17, 8, 19, 136, 19, 136], 1000)
  await expect(normalizeImagePng(bytes)).rejects.toThrow(/pixel limit/i)
})

it('retains BMP preview support', async () => {
  const bmp = Buffer.alloc(62)
  bmp.write('BM')
  bmp.writeUInt32LE(62, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(2, 18)
  bmp.writeInt32LE(1, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)
  bmp.set([0, 0, 255, 0, 255, 0, 0, 0], 54)
  const png = PNG.sync.read(await normalizeImagePng(bmp))
  expect([png.width, png.height]).toEqual([2, 1])
  expect([...png.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
})

it('uses the first frame of an animated GIF', async () => {
  const encoder = new GifEncoder(1, 1)
  encoder.addFrame(new Uint8Array([255, 0, 0, 255]), 1, 1, { delay: 100 })
  encoder.addFrame(new Uint8Array([0, 255, 0, 255]), 1, 1, { delay: 100 })
  const png = PNG.sync.read(await normalizeImagePng(encoder.finish()))
  expect([...png.data]).toEqual([255, 0, 0, 255])
})
