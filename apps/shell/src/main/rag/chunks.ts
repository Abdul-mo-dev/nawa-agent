import type { RagBlock, RagDocument } from '@genoffice/file-parse'
import type { RagSettings } from '../../shared/rag-api'
import { hashText } from './config'
export interface RagChunk {
  ordinal: number; text: string; embeddingText: string; hash: string
  locator: string; metadata: Omit<RagBlock, 'text'> & { title: string; format: string; charStart?: number; charEnd?: number }
}
const clip = (text: string, length: number): string => Array.from(text).slice(0, length).join('')
function groupKey(block: RagBlock): string { return JSON.stringify([block.kind, block.headings, block.page, block.sheet, block.slide, block.context]) }
/** Pack adjacent same-section blocks, never across sheets/pages/slides or code/table boundaries. */
export function draftBlocks(doc: RagDocument, targetChars: number): RagBlock[] {
  const out: RagBlock[] = []; let current: RagBlock | undefined
  for (const raw of doc.blocks) {
    if (!raw.text.trim()) continue
    const block = { ...raw, headings: raw.headings.filter(Boolean) }
    if (current && groupKey(current) === groupKey(block) && current.text.length + block.text.length + 2 <= targetChars && block.kind !== 'outline') {
      current.text += '\n\n' + block.text
      current.locator += `; ${block.locator}`
      if (block.rowEnd !== undefined) current.rowEnd = block.rowEnd
      if (block.lineEnd !== undefined) current.lineEnd = block.lineEnd
    } else { current = { ...block }; out.push(current) }
  }
  return out
}
/** Final token measurement includes prefixes and structural context; no silent model truncation. */
export async function chunkDocument(doc: RagDocument, settings: RagSettings, countTokens: (text: string) => Promise<number>, signal?: AbortSignal): Promise<RagChunk[]> {
  const chunks: RagChunk[] = [], blocks = draftBlocks(doc, settings.chunkTokens * 3)
  const title = clip(doc.title, 120)
  for (const block of blocks) {
    signal?.throwIfAborted()
    const header = `File: ${title}\nFormat: ${doc.format}\nLocation: ${clip(block.locator, 160)}\nSection: ${clip(block.headings.join(' > '), 160)}\nType: ${block.kind}${block.context ? `\nContext: ${clip(block.context, 240)}` : ''}\n\n`
    const prefix = settings.documentPrefix + header
    const headerTokens = await countTokens(prefix)
    if (headerTokens >= settings.maxInputTokens - 24) throw new Error('Structural context/prefix exceeds the embedding input limit. Increase max input tokens or shorten the document prefix.')
    const target = Math.max(headerTokens + 24, Math.min(settings.chunkTokens, settings.maxInputTokens - 8))
    const chars = Array.from(block.text); let start = 0
    while (start < chars.length) {
      signal?.throwIfAborted()
      let low = 1, high = Math.min(chars.length - start, Math.max(64, settings.maxInputTokens * 8)), take = high
      const textFor = (n: number) => chars.slice(start, start + n).join('')
      if (await countTokens(prefix + textFor(high)) > target) {
        take = 0
        while (low <= high) {
          const mid = Math.floor((low + high) / 2)
          if (await countTokens(prefix + textFor(mid)) <= target) { take = mid; low = mid + 1 } else high = mid - 1
        }
      }
      if (!take) throw new Error('Embedding input limit is too small for this document context.')
      if (start + take < chars.length) {
        const text = textFor(take), minimum = Math.floor(take * 0.6)
        // Prefer paragraph/line boundaries, then sentence endings. Never split a surrogate pair.
        const boundaries = [...text.matchAll(/\n\n|\n|[。！？.!?]\s*/g)]
        const at = boundaries.reverse().find(m => Array.from(text.slice(0, m.index! + m[0].length)).length >= minimum)
        if (at) take = Array.from(text.slice(0, at.index! + at[0].length)).length
      }
      const text = textFor(take), embeddingText = prefix + text
      if (await countTokens(embeddingText) > settings.maxInputTokens) throw new Error('Chunk token validation failed; file was not committed.')
      const { text: _body, ...metadata } = block
      const fragmented = start > 0 || take < chars.length
      chunks.push({ ordinal: chunks.length, text, embeddingText, hash: hashText(embeddingText),
        locator: block.locator + (fragmented ? `, text characters ${start + 1}–${start + take}` : ''),
        metadata: { ...metadata, locator: clip(metadata.locator, 1200), headings: metadata.headings.map(h => clip(h, 500)), context: metadata.context ? clip(metadata.context, 2000) : undefined, title: clip(doc.title, 300), format: doc.format, ...(fragmented ? { charStart: start, charEnd: start + take } : {}) },
      })
      if (chunks.length > 50000) throw new Error('File exceeds 50,000 chunks. Split it into smaller documents; no partial generation was committed.')
      if (start + take >= chars.length) break
      const overlap = Math.min(Math.floor(take / 4), Math.floor(take * settings.overlapTokens / settings.chunkTokens))
      start += Math.max(1, take - overlap)
    }
  }
  if (!chunks.length) throw new Error('No extractable nonempty text. The file was not marked Embedded.')
  return chunks
}
