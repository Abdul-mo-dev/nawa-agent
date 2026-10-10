import JSZip from 'jszip'
import { posix } from 'node:path'
import { attr, descendants, readXml } from './rag-xml'
import type { RagBlock } from './rag-types'

const mediaPath = /^(?:word|ppt|xl)\/media\/[^/]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i
const MAX_IMAGES = 100
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_RELATIONSHIPS = 1000
const MAX_RELATIONSHIP_BYTES = 2 * 1024 * 1024

export async function ocrOfficeMedia(
  bytes: Uint8Array,
  recognize: (image: Uint8Array) => Promise<string | null>,
): Promise<{ blocks: RagBlock[]; warnings: string[] }> {
  const zip = await JSZip.loadAsync(bytes)
  const warnings: string[] = []
  const references = new Map<string, Set<string>>()
  const relationNames = Object.keys(zip.files).filter((name) => name.endsWith('.rels'))
  if (relationNames.length > MAX_RELATIONSHIPS)
    warnings.push(
      `Embedded-image OCR checks only the first ${MAX_RELATIONSHIPS} of ${relationNames.length} relationship parts.`,
    )
  for (const name of relationNames.slice(0, MAX_RELATIONSHIPS)) {
    const file = zip.file(name)
    if (!file || !name.includes('/_rels/')) continue
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize
    if (size !== undefined && size > MAX_RELATIONSHIP_BYTES) {
      warnings.push(`${name}: image relationships exceed the 2 MiB OCR limit.`)
      continue
    }
    const source = name.replace('/_rels/', '/').replace(/\.rels$/, '')
    let xml
    try {
      xml = readXml(await file.async('string'))
    } catch {
      warnings.push(`${name}: malformed image relationships; embedded-image OCR skipped.`)
      continue
    }
    for (const relation of descendants(xml, 'Relationship')) {
      if (
        !attr(relation, 'Type').endsWith('/image') ||
        attr(relation, 'TargetMode').toLowerCase() === 'external'
      )
        continue
      const target = attr(relation, 'Target').trim()
      const path = posix.normalize(
        target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target),
      )
      if (!mediaPath.test(path) || !zip.file(path)) continue
      const sources = references.get(path) ?? new Set<string>()
      sources.add(source)
      references.set(path, sources)
    }
  }
  const names = [...references.keys()].sort()
  const blocks: RagBlock[] = []
  if (names.length > MAX_IMAGES)
    warnings.push(
      `Embedded-image OCR is limited to the first ${MAX_IMAGES} of ${names.length} images.`,
    )
  for (const name of names.slice(0, MAX_IMAGES)) {
    const file = zip.file(name)
    if (!file) continue
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      warnings.push(`${name}: image exceeds the 16 MiB OCR limit.`)
      continue
    }
    try {
      const image = await file.async('uint8array')
      if (image.length > MAX_IMAGE_BYTES) {
        warnings.push(`${name}: image exceeds the 16 MiB OCR limit.`)
        continue
      }
      const text = (await recognize(image))?.trim()
      if (text)
        blocks.push({
          kind: 'notes',
          text,
          headings: ['Embedded image'],
          locator: `embedded image ${name} (referenced by ${[...references.get(name)!].join(', ')}), OCR`,
        })
    } catch (error) {
      warnings.push(
        `${name}: OCR failed (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
  }
  if (blocks.length)
    warnings.push(
      `Local OCR recognized text in ${blocks.length} embedded image(s). Verify wording and image location against the source; visual meaning is not interpreted.`,
    )
  return { blocks, warnings }
}
