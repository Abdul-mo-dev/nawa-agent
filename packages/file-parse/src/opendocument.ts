import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'
import { openDocumentManifestEncrypted, openDocumentMimeForPath } from '@genoffice/file-formats'
import type { RagBlock, RagDocument } from './rag-types'

const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
const DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0'
const MAX_TEXT = 1_000_000
const MAX_NODES = 200_000

/** Read saved XML only; links, embedded objects and scripts are never executed. */
export async function openDocumentRag(
  bytes: Uint8Array,
  title: string,
  extension: 'odt' | 'odp',
): Promise<RagDocument> {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('OpenDocument exceeds 64 MiB.')
  await assertZipInflatesWithinLimits(bytes, {
    maxParts: 10_000,
    maxPartBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
  })
  const zip = await JSZip.loadAsync(bytes)
  if ((await zip.file('mimetype')?.async('string'))?.trim() !== openDocumentMimeForPath(title))
    throw new Error('OpenDocument MIME type does not match its extension.')
  const manifest = await zip.file('META-INF/manifest.xml')?.async('string')
  if (!manifest) throw new Error('OpenDocument manifest is missing.')
  if (openDocumentManifestEncrypted(manifest))
    throw new Error('Password-protected OpenDocument files cannot be read.')
  const xml = await zip.file('content.xml')?.async('string')
  if (!xml || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new Error('Invalid OpenDocument content XML.')
  const fail = (message: string) => {
    throw new Error(`Invalid OpenDocument XML: ${message}`)
  }
  const doc = new DOMParser({
    errorHandler: { warning: fail, error: fail, fatalError: fail },
  }).parseFromString(xml, 'application/xml')
  if (
    doc.documentElement.namespaceURI !== OFFICE ||
    doc.documentElement.localName !== 'document-content'
  )
    throw new Error('Invalid OpenDocument content root.')
  const body = doc.getElementsByTagNameNS(OFFICE, extension === 'odt' ? 'text' : 'presentation')[0]
  if (!body) throw new Error('OpenDocument body does not match its extension.')

  let nodes = 0,
    characters = 0,
    slideCount = 0
  const blocks: RagBlock[] = []
  const stack: { node: Node; slide?: number }[] = [{ node: body }]
  while (stack.length) {
    const { node, slide: parentSlide } = stack.pop()!
    if (++nodes > MAX_NODES) throw new Error('OpenDocument exceeds the XML node limit.')
    if (node.nodeType !== 1) continue
    const element = node as typeof body
    const { namespaceURI: ns, localName: name } = element
    if ((ns === TEXT && name === 'tracked-changes') || (ns === OFFICE && name === 'scripts'))
      continue
    const slide = ns === DRAW && name === 'page' ? ++slideCount : parentSlide
    if (ns === TEXT && (name === 'p' || name === 'h')) {
      const parts: string[] = []
      const pending: Node[] = []
      for (let child = node.lastChild; child; child = child.previousSibling) pending.push(child)
      while (pending.length) {
        const child = pending.pop()!
        if (++nodes > MAX_NODES) throw new Error('OpenDocument exceeds the XML node limit.')
        let text = ''
        if (child.nodeType === 3 || child.nodeType === 4) text = child.nodeValue ?? ''
        else if (child.nodeType === 1) {
          const el = child as typeof body
          if (el.namespaceURI === TEXT && el.localName === 's') {
            const count = Number(el.getAttributeNS(TEXT, 'c') || '1')
            if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TEXT - characters)
              throw new Error('OpenDocument exceeds the text expansion limit.')
            text = ' '.repeat(count)
          } else if (el.namespaceURI === TEXT && el.localName === 'tab') text = '\t'
          else if (el.namespaceURI === TEXT && el.localName === 'line-break') text = '\n'
          else
            for (let nested = child.lastChild; nested; nested = nested.previousSibling)
              pending.push(nested)
        }
        characters += text.length
        if (characters > MAX_TEXT) throw new Error('OpenDocument exceeds the text expansion limit.')
        parts.push(text)
      }
      const text = parts.join('').trim()
      if (text)
        blocks.push({
          text,
          kind: 'paragraph',
          headings: [],
          locator: `${slide ? `slide ${slide}, ` : ''}paragraph ${blocks.length + 1}`,
          ...(slide ? { slide } : {}),
        })
      continue
    }
    for (let child = node.lastChild; child; child = child.previousSibling)
      stack.push({ node: child, slide })
  }
  if (!blocks.length) throw new Error('OpenDocument has no extractable text.')
  return {
    title,
    format: extension,
    blocks,
    partial: true,
    warnings: [
      'OpenDocument extraction includes saved paragraphs and slide notes. Layout, table relationships, embedded objects and visual media require native inspection.',
    ],
  }
}
