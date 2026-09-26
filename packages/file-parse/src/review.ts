import JSZip, { type JSZipObject } from 'jszip'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Readable } from 'node:stream'

export interface FileReviewEntry { location: string; kind: string; before?: string; after?: string }
export interface FileReview { format: string; complete: boolean; changed: number; entries: FileReviewEntry[]; warnings: string[] }
const MAX_FILE = 64 * 1024 * 1024
const MAX_PART = 16 * 1024 * 1024
const MAX_TOTAL = 128 * 1024 * 1024
const MAX_ENTRIES = 100
const MAX_ELEMENT_RECORDS = 50000
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const excerpt = (text: string) => text.length > 2000 ? text.slice(0, 2000) + '\n[Excerpt truncated.]' : text
const unescapeXml = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity: string) => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  if (entity[0] !== '#') return named[entity] ?? all
  const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all
})
/** A bounded excerpt scanner, NOT a general OOXML validator or layout renderer. */
function tagText(xml: string, tag = 't'): string {
  return [...xml.matchAll(new RegExp(`<(?:(?:[\\w.-]+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}>`, 'g'))].map(m => unescapeXml(m[1] ?? '')).join(' ')
}
function attr(xml: string, name: string): string {
  return unescapeXml(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`).exec(xml)?.[1] ?? '')
}
function kindFor(name: string): string {
  if (/^xl\/worksheets\/.*\.xml$/.test(name)) return 'worksheet structure / cells'
  if (/^xl\/sharedStrings/.test(name)) return 'shared cell text'
  if (/styles|theme|slideMaster|slideLayout/.test(name)) return 'formatting / theme'
  if (/\/charts\//.test(name)) return 'chart data / formatting'
  if (/\/media\//.test(name)) return 'embedded media'
  if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return 'slide text / shapes / layout'
  if (/^word\/document\.xml$/.test(name)) return 'document blocks / layout'
  if (/header|footer|comments|footnotes|endnotes/.test(name)) return 'document notes / headers / comments'
  if (/\.rels$/.test(name)) return 'document relationships'
  return 'package metadata / structure'
}
interface Part { digest: string; size: number; xml?: string }
interface Snapshot { parts: Map<string, Part>; shared: string[]; cells: Map<string, string>; blocks: Map<string, string>; truncated: boolean }
function boundedPart(entry: JSZipObject, budget: { remaining: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0, done = false
    const chunks: Buffer[] = []
    const stream = entry.nodeStream('nodebuffer') as Readable
    stream.on('data', (data: Buffer) => {
      if (done) return
      bytes += data.length; budget.remaining -= data.length
      if (bytes > MAX_PART || budget.remaining < 0) {
        done = true; stream.destroy(); chunks.length = 0
        reject(new Error('Structured review exceeds its decompressed data limit.')); return
      }
      chunks.push(Buffer.from(data))
    }).on('error', (error: Error) => { if (!done) { done = true; reject(error) } })
      .on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } }).resume()
  })
}
export function worksheetCells(xml: string, shared: readonly string[] = []): Map<string, string> {
  const cells = new Map<string, string>()
  // Keep cell markup in the signature, so changes to formatting or formula metadata remain visible.
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g)) {
    const address = attr(match[1] ?? '', 'r')
    if (!/^[A-Z]{1,3}[1-9]\d*$/i.test(address)) continue
    const body = match[2] ?? '', type = attr(match[1] ?? '', 't'), style = attr(match[1] ?? '', 's')
    let value = tagText(body, 'v')
    if (type === 's') value = value.trim() && /^\d+$/.test(value) ? shared[Number(value)] ?? `[shared string ${value}]` : ''
    else if (type === 'inlineStr') value = tagText(body)
    const formula = tagText(body, 'f')
    cells.set(address.toUpperCase(), `cell XML SHA-256: ${hash(match[0])}\nresolved value SHA-256: ${hash(value)}\nstyle index: ${style || '0'}\ncell type: ${type || 'number/default'}\nstored value: ${excerpt(value).slice(0, 700)}\nformula: ${excerpt(formula || '(none or shared-formula reference)').slice(0, 700)}`)
    if (cells.size >= MAX_ELEMENT_RECORDS) break
  }
  return cells
}
async function snapshot(path: string | null, budget: { remaining: number }): Promise<Snapshot> {
  const output: Snapshot = { parts: new Map(), shared: [], cells: new Map(), blocks: new Map(), truncated: false }
  if (!path) return output
  if ((await stat(path)).size > MAX_FILE) throw new Error('File exceeds the structured review size limit.')
  const zip = await JSZip.loadAsync(await readFile(path))
  const entries = Object.values(zip.files).filter(e => !e.dir)
  if (entries.length > 10000) throw new Error('Too many archive entries for a bounded review.')
  for (const entry of entries) {
    const bytes = await boundedPart(entry, budget)
    const xml = /\.(xml|rels)$/i.test(entry.name) ? bytes.toString('utf8') : undefined
    if (xml && /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not supported in structured review.')
    output.parts.set(entry.name, { digest: hash(bytes), size: bytes.length, xml })
  }
  const shared = output.parts.get('xl/sharedStrings.xml')?.xml ?? ''
  output.shared = [...shared.matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g)].map(m => tagText(m[1] ?? ''))
  for (const [name, part] of output.parts) {
    if (!part.xml) continue
    if (/^xl\/worksheets\/.*\.xml$/.test(name)) {
      const cells = worksheetCells(part.xml, output.shared)
      if (cells.size >= MAX_ELEMENT_RECORDS) output.truncated = true
      for (const [address, value] of cells) {
        if (output.cells.size >= MAX_ELEMENT_RECORDS) { output.truncated = true; break }
        output.cells.set(`${name} · ${address}`, value)
      }
    }
    const word = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(name)
    const slide = /^ppt\/slides\/slide\d+\.xml$/.test(name)
    if (!word && !slide) continue
    const pattern = word ? /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
      : /<p:(sp|pic|graphicFrame)\b[^>]*>[\s\S]*?<\/p:\1>/g
    let ordinal = 0
    for (const match of part.xml.matchAll(pattern)) {
      if (output.blocks.size >= MAX_ELEMENT_RECORDS) { output.truncated = true; break }
      ordinal++
      const identity = word ? `paragraph ${ordinal}` : `element ${attr(/<p:cNvPr\b[^>]*>/.exec(match[0])?.[0] ?? '', 'id') || ordinal}`
      // The digest detects layout/style/image properties even when extracted text is unchanged.
      output.blocks.set(`${name} · ${identity}`, excerpt(`${tagText(match[0]).slice(0, 1600)}\nElement XML SHA-256: ${hash(match[0])}`))
    }
  }
  return output
}
export async function reviewFileChanges(before: string | null, after: string): Promise<FileReview> {
  const format = extname(after).toLowerCase().slice(1)
  const result: FileReview = { format, complete: true, changed: 0, entries: [], warnings: [] }
  const add = (entry: FileReviewEntry) => { result.changed++; if (result.entries.length < MAX_ENTRIES) result.entries.push(entry) }
  if (['docx', 'xlsx', 'pptx'].includes(format)) {
    const budget = { remaining: MAX_TOTAL }
    const a = await snapshot(before, budget), b = await snapshot(after, budget)
    // Prioritize human-actionable cell/formula changes before generic package details.
    for (const location of new Set([...a.cells.keys(), ...b.cells.keys()])) {
      const left = a.cells.get(location), right = b.cells.get(location)
      if (left !== right) add({ location, kind: 'cell / formula / formatting', before: left && excerpt(left), after: right && excerpt(right) })
    }
    for (const location of new Set([...a.blocks.keys(), ...b.blocks.keys()])) {
      const left = a.blocks.get(location), right = b.blocks.get(location)
      if (left !== right) add({ location, kind: format === 'docx' ? 'document paragraph / formatting' : 'slide element / layout', before: left, after: right })
    }
    if (a.truncated || b.truncated) {
      result.complete = false
      result.warnings.push(`Cell/block detail is limited to ${MAX_ELEMENT_RECORDS} records per version; all bounded package parts are still hash-compared.`)
    }
    for (const name of new Set([...a.parts.keys(), ...b.parts.keys()])) {
      const left = a.parts.get(name), right = b.parts.get(name)
      if (left?.digest === right?.digest) continue
      const describe = (part: Part | undefined) => part ? excerpt(`${part.xml ? tagText(part.xml).slice(0, 1600) : '(binary data)'}\n${part.size} bytes · SHA-256 ${part.digest}`) : undefined
      add({ location: name, kind: kindFor(name), before: describe(left), after: describe(right) })
    }
    result.warnings.push('Package-part hashes detect non-text changes, including formatting and media. This is not a rendered visual diff or a guarantee of document correctness.')
    if (format === 'docx') result.warnings.push('Paragraphs are compared by position. Insertions can shift later entries; nested text boxes and alternate XML prefixes may appear only in the package-part comparison.')
    if (format === 'xlsx') result.warnings.push('Cell values are saved values, not recalculated by this preview. Style indexes refer to the changed styles part. Shared-formula details remain in the cell XML hash.')
  } else if (['md', 'markdown', 'html', 'htm'].includes(format)) {
    const load = async (path: string | null) => {
      if (!path) return [] as string[]
      if ((await stat(path)).size > MAX_FILE) throw new Error('Text file exceeds the review limit.')
      return (await readFile(path, 'utf8')).split(/\r?\n/)
    }
    const a = await load(before), b = await load(after)
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) add({ location: `Line ${i + 1}`, kind: 'source line', before: a[i] === undefined ? undefined : excerpt(a[i]!), after: b[i] === undefined ? undefined : excerpt(b[i]!) })
    result.warnings.push('Line positions are compared; inserting a line can shift following entries. HTML is shown as source, never executed.')
  } else {
    result.complete = false
    result.warnings.push('A structured/visual diff is not available for this format. Review the native operation log and extracted text; formatting or image changes may not appear there.')
  }
  if (result.changed > MAX_ENTRIES) result.warnings.push(`Showing the first ${MAX_ENTRIES} of ${result.changed} changed cells/parts/lines.`)
  return result
}
