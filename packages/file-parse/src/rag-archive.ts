import JSZip from 'jszip'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { RagDocument } from './rag-types'

const MAX_ENTRIES = 100
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const allowed = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.ndjson',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.sql',
  '.log',
  '.pdf',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.cs',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.ps1',
  '.css',
  '.doc',
  '.odt',
  '.odp',
  '.ppt',
  '.docx',
  '.docm',
  '.dotx',
  '.dotm',
  '.xlsx',
  '.xlsm',
  '.xltx',
  '.xltm',
  '.pptx',
  '.potx',
  '.potm',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.eml',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
])

export async function archiveDocument(
  bytes: Uint8Array,
  title: string,
  parse: (path: string) => Promise<RagDocument>,
): Promise<RagDocument> {
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length > 5000) throw new Error('ZIP archive exceeds 5,000 entries.')
  const blocks: RagDocument['blocks'] = []
  const warnings: string[] = []
  let expanded = 0
  let partial = false
  const staging = await mkdtemp(join(tmpdir(), 'nawa-rag-zip-'))
  try {
    if (entries.length > MAX_ENTRIES)
      warnings.push(`Only the first ${MAX_ENTRIES} of ${entries.length} ZIP entries were checked.`)
    for (const [index, entry] of entries.slice(0, MAX_ENTRIES).entries()) {
      const name = entry.name
      const extension = extname(name).toLowerCase()
      if (!allowed.has(extension) || name.split('/').some((part) => part.startsWith('.'))) {
        warnings.push(`${name}: unsupported or hidden archive entry; content was not embedded.`)
        continue
      }
      const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize
      if (declared !== undefined && declared > MAX_ENTRY_BYTES) {
        warnings.push(`${name}: entry exceeds the 16 MiB extraction limit.`)
        continue
      }
      if (declared !== undefined && expanded + declared > MAX_TOTAL_BYTES) {
        warnings.push(`${name}: ZIP expanded-data limit reached; later entries were not checked.`)
        break
      }
      try {
        const data = await entry.async('uint8array')
        if (data.length > MAX_ENTRY_BYTES || expanded + data.length > MAX_TOTAL_BYTES) {
          warnings.push(`${name}: ZIP expanded-data limit reached; content was not embedded.`)
          continue
        }
        expanded += data.length
        const path = join(staging, `entry-${index}${extension}`)
        await writeFile(path, data)
        const document = await parse(path)
        partial ||= document.partial
        blocks.push(
          ...document.blocks.map((block) => ({
            ...block,
            headings: [name, ...block.headings],
            locator: `ZIP entry ${name}, ${block.locator}`,
          })),
        )
        warnings.push(...document.warnings.map((warning) => `${name}: ${warning}`))
      } catch (error) {
        warnings.push(
          `${name}: extraction failed (${error instanceof Error ? error.message : String(error)}).`,
        )
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  if (!blocks.length)
    throw new Error(
      'ZIP archive has no readable supported entries; no file-content vectors were created.',
    )
  return { title, format: 'zip', blocks, warnings, partial: partial || !!warnings.length }
}
