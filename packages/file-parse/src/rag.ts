import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { markdownBlocks, delimitedBlocks, jsonBlocks, codeBlocks, htmlBlocks, xmlBlocks } from './rag-text'
import { decodeXml } from './rag-xml'
import type { RagDocument } from './rag-types'
export type { RagBlock, RagDocument } from './rag-types'
const plain = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'log', 'py', 'js', 'jsx', 'ts', 'tsx', 'cs', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'yaml', 'yml', 'toml', 'ini', 'sh', 'ps1', 'css'])
const code = new Set(['py', 'js', 'jsx', 'ts', 'tsx', 'cs', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'sh', 'ps1', 'css'])
export async function parseFileToRag(path: string): Promise<RagDocument> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error('RAG extraction accepts files up to 64 MiB.')
  const title = basename(path), ext = extname(path).slice(1).toLowerCase()
  if (plain.has(ext)) {
    const bytes = await readFile(path)
    // Explicit UTF-16 BOM support; reject malformed UTF-8 instead of indexing mojibake silently.
    let text: string
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const warnings: string[] = []
    const blocks = ext === 'csv' || ext === 'tsv' ? delimitedBlocks(text, ext === 'csv' ? ',' : '\t')
      : ext === 'xml' ? xmlBlocks(text)
      : ext === 'json' ? jsonBlocks(text)
      : ext === 'jsonl' || ext === 'ndjson' ? text.split(/\r?\n/).flatMap((line, i) => line.trim() ? jsonBlocks(line).map(b => ({ ...b, locator: `line ${i + 1}, ${b.locator}`, lineStart: i + 1, lineEnd: i + 1 })) : [])
      : ext === 'html' || ext === 'htm' ? htmlBlocks(text).map(b => ({ ...b, text: decodeXml(b.text), locator: `HTML section ${b.headings.join(' > ') || 'body'}` }))
      : code.has(ext) ? codeBlocks(text) : markdownBlocks(text)
    if (['yaml', 'yml', 'toml', 'ini'].includes(ext)) warnings.push('Configuration/XML chunks preserve source text and line references; no schema inference is performed.')
    const partial = ['html', 'htm'].includes(ext) && /<(?:img|canvas|svg|video)\b|(?:colspan|rowspan)\s*=/i.test(text)
    if (partial) warnings.push('HTML visual media is not fetched or OCRed; merged table spans may require native inspection.')
    return { title, format: ext, blocks, warnings, partial }
  }
  if (['docx', 'xlsx', 'xlsm', 'pptx'].includes(ext)) {
    const office = await import('./rag-office'), bytes = await readFile(path)
    return ext === 'docx' ? office.docxDocument(bytes, title) : ext === 'pptx' ? office.pptxDocument(bytes, title) : office.xlsxDocument(bytes, title)
  }
  if (ext === 'pdf') {
    const { pdfToPages } = await import('./pdf'), pages = await pdfToPages(await readFile(path))
    const missing = pages.flatMap((page, i) => page.trim() ? [] : [i + 1])
    const blocks = pages.flatMap((text, i) => markdownBlocks(text).map(b => ({ ...b, headings: [], page: i + 1, locator: `page ${i + 1}, ${b.locator}` })))
    if (!blocks.length) throw new Error('PDF has no extractable text. OCR is required before embedding.')
    return { title, format: 'pdf', blocks, partial: true, warnings: [
      'PDF indexing uses the existing text layer, with exact page numbers. Visual content is not OCRed; complex table layout/reading order may need native inspection.',
      ...(missing.length ? [`No text on pages: ${missing.join(', ')}. These pages are not embedded.`] : []),
    ] }
  }
  if (ext === 'doc' || ext === 'ppt') {
    const text = ext === 'doc' ? await (await import('./doc')).docToText(await readFile(path)) : await (await import('./ppt')).pptToText(await readFile(path))
    return { title, format: ext, blocks: markdownBlocks(text).map(b => ({ ...b, locator: `legacy extracted text, ${b.locator}` })), partial: true, warnings: ['Legacy format: extracted-text offsets only; original layout/page structure is not guaranteed. Save as DOCX/PPTX for richer structure.'] }
  }
  throw new Error(`No RAG text extractor for .${ext || '(no extension)'}. Images/scans need OCR; legacy XLS needs conversion to XLSX. Filename-only records are never marked Embedded.`)
}
