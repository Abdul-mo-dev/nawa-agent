import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { imageSize } from 'image-size'
import * as TIFF from 'utif2'
import type { Canvas } from '@napi-rs/canvas'

const MAX_PIXELS = 20_000_000
const MAX_BYTES = 64 * 1024 * 1024
const MAX_DECODED_BYTES = 160 * 1024 * 1024
type TiffImage = TIFF.IFD

/** Native bindings live outside asar; source and packaged applications use the same codec. */
export async function imageCanvasRuntime(): Promise<typeof import('@napi-rs/canvas')> {
  const manifest = process.resourcesPath
    ? join(process.resourcesPath, 'image', 'node_modules', '@napi-rs', 'canvas', 'package.json')
    : ''
  const module = await (manifest && existsSync(manifest)
    ? import(pathToFileURL(createRequire(manifest).resolve('@napi-rs/canvas')).href)
    : import('@napi-rs/canvas'))
  return module.default ?? module
}

function dimensions(width: number | undefined, height: number | undefined): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !width ||
    !height ||
    width < 0 ||
    height < 0
  )
    throw new Error('Image dimensions are unavailable.')
  if (width * height > MAX_PIXELS) throw new Error('Image exceeds the 20-million-pixel limit.')
}

/** Read just the first bounded TIFF directory. Do not traverse EXIF, MakerNotes,
 * subimages or linked directories supplied by untrusted files. */
function tiffDirectory(bytes: Uint8Array): TiffImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const little = bytes[0] === 0x49
  if (view.getUint16(2, little) !== 42) throw new Error('Unsupported TIFF header.')
  const start = view.getUint32(4, little)
  const count = view.getUint16(start, little)
  if (count > 512 || start + 2 + count * 12 + 4 > bytes.length)
    throw new Error('Invalid TIFF directory.')
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]
  // The decoder fills width, height and data after validating the header tags.
  const ifd = {} as TiffImage
  for (let index = 0; index < count; index++) {
    const entry = start + 2 + index * 12
    const tag = view.getUint16(entry, little),
      type = view.getUint16(entry + 2, little)
    const length = view.getUint32(entry + 4, little),
      size = sizes[type]
    if (!size || type === 2 || [330, 34665, 34853, 37500].includes(tag)) continue
    if (length > 1_000_000) throw new Error('TIFF metadata exceeds its limit.')
    const offset = length * size <= 4 ? entry + 8 : view.getUint32(entry + 8, little)
    if (offset + length * size > bytes.length) throw new Error('Truncated TIFF metadata.')
    const values: number[] = []
    for (let item = 0; item < length; item++) {
      const position = offset + item * size
      values.push(
        type === 3
          ? view.getUint16(position, little)
          : type === 4
            ? view.getUint32(position, little)
            : type === 5
              ? view.getUint32(position, little) / view.getUint32(position + 4, little)
              : type === 6
                ? view.getInt8(position)
                : type === 8
                  ? view.getInt16(position, little)
                  : type === 9
                    ? view.getInt32(position, little)
                    : type === 10
                      ? view.getInt32(position, little) / view.getInt32(position + 4, little)
                      : type === 11
                        ? view.getFloat32(position, little)
                        : type === 12
                          ? view.getFloat64(position, little)
                          : view.getUint8(position),
      )
    }
    ifd[`t${tag}`] = values
  }
  return ifd
}

const tag = (ifd: TiffImage, number: number): number[] =>
  (ifd[`t${number}`] as number[] | undefined) ?? []

function validateTiff(bytes: Uint8Array, ifd: TiffImage): void {
  const width = tag(ifd, 256)[0],
    height = tag(ifd, 257)[0]
  dimensions(width, height)
  const channels = tag(ifd, 277)[0] ?? 1,
    bits = tag(ifd, 258)[0] ?? 1
  if (
    channels < 1 ||
    channels > 4 ||
    ![1, 2, 4, 8, 16, 32].includes(bits) ||
    (width! * height! * channels * bits) / 8 > MAX_DECODED_BYTES
  )
    throw new Error('TIFF sample layout exceeds its decoding limit.')
  const offsets = tag(ifd, 273).length ? tag(ifd, 273) : tag(ifd, 324)
  const lengths = tag(ifd, 279).length ? tag(ifd, 279) : tag(ifd, 325)
  if (offsets.length !== lengths.length) throw new Error('Invalid TIFF strip directory.')
  let inflated = 0
  for (let index = 0; index < offsets.length; index++) {
    const offset = offsets[index]!,
      length = lengths[index]!
    if (offset + length > bytes.length) throw new Error('Truncated TIFF strip.')
    if ([6, 7].includes(tag(ifd, 259)[0] ?? 1)) {
      // A JPEG strip can lie about its own dimensions independently of its TIFF
      // directory. Check SOF before the embedded decoder allocates its frame.
      const frame = bytes.subarray(offset, offset + length)
      for (let position = 0; position + 8 < frame.length; position++) {
        const marker = frame[position + 1]!
        if (
          frame[position] !== 255 ||
          marker < 0xc0 ||
          marker > 0xcf ||
          [0xc4, 0xc8, 0xcc].includes(marker)
        )
          continue
        const jpegHeight = frame[position + 5]! * 256 + frame[position + 6]!
        const jpegWidth = frame[position + 7]! * 256 + frame[position + 8]!
        dimensions(jpegWidth, jpegHeight)
        if (
          jpegWidth > Math.max(width!, tag(ifd, 322)[0] ?? 0) ||
          jpegHeight > Math.max(height!, tag(ifd, 323)[0] ?? 0)
        )
          throw new Error('TIFF JPEG strip dimensions differ from its directory.')
        break
      }
    }
    // Bound DEFLATE before the TIFF library inflates the same strip. Its API has
    // no output limit. Native zlib checks the limit while decoding.
    if ([8, 32946].includes(tag(ifd, 259)[0] ?? 1)) {
      inflated += inflateSync(bytes.subarray(offset, offset + length), {
        maxOutputLength: MAX_DECODED_BYTES,
      }).length
      if (inflated > MAX_DECODED_BYTES) throw new Error('TIFF decompressed data exceeds its limit.')
    }
  }
}

export async function decodeStillImage(bytes: Uint8Array): Promise<Canvas> {
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new Error('Image exceeds the 64-MiB input limit.')
  const info = imageSize(bytes)
  dimensions(info.width, info.height)
  const runtime = await imageCanvasRuntime()
  if (info.type === 'tiff') {
    const ifd = tiffDirectory(bytes)
    validateTiff(bytes, ifd)
    const buffer = new Uint8Array(bytes).buffer
    TIFF.decodeImage(buffer, ifd)
    dimensions(ifd.width, ifd.height)
    const width = ifd.width!,
      height = ifd.height!,
      pixels = TIFF.toRGBA8(ifd)
    if (pixels.length !== width * height * 4) throw new Error('Invalid TIFF pixel data.')
    const source = runtime.createCanvas(width, height)
    source
      .getContext('2d')
      .putImageData(new runtime.ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
    const orientation = tag(ifd, 274)[0] ?? 1
    const canvas = runtime.createCanvas(
      orientation >= 5 && orientation <= 8 ? height : width,
      orientation >= 5 && orientation <= 8 ? width : height,
    )
    const transforms: Record<number, [number, number, number, number, number, number]> = {
      2: [-1, 0, 0, 1, width, 0],
      3: [-1, 0, 0, -1, width, height],
      4: [1, 0, 0, -1, 0, height],
      5: [0, 1, 1, 0, 0, 0],
      6: [0, 1, -1, 0, height, 0],
      7: [0, -1, -1, 0, height, width],
      8: [0, -1, 1, 0, 0, width],
    }
    const context = canvas.getContext('2d')
    if (transforms[orientation]) context.setTransform(...transforms[orientation]!)
    context.drawImage(source, 0, 0)
    return canvas
  }
  // Skia applies EXIF orientation, and decodes the first frame of animated inputs.
  const image = await runtime.loadImage(bytes)
  dimensions(image.width, image.height)
  const canvas = runtime.createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas
}

export async function normalizeImagePng(bytes: Uint8Array): Promise<Buffer> {
  return (await decodeStillImage(bytes)).encode('png')
}

export async function previewImageBuffers(
  bytes: Uint8Array,
): Promise<{ png: Buffer; jpeg: Buffer }> {
  const canvas = await decodeStillImage(bytes)
  const runtime = await imageCanvasRuntime()
  const ratio = Math.min(1, 1536 / canvas.width, 1536 / canvas.height)
  const vision = runtime.createCanvas(
    Math.max(1, Math.round(canvas.width * ratio)),
    Math.max(1, Math.round(canvas.height * ratio)),
  )
  const context = vision.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, vision.width, vision.height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, vision.width, vision.height)
  const [png, jpeg] = await Promise.all([canvas.encode('png'), vision.encode('jpeg', 85)])
  return { png, jpeg }
}
