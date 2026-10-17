import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  markdownBlocks,
  delimitedBlocks,
  jsonBlocks,
  codeBlocks,
  htmlBlocks,
  xmlBlocks,
} from './rag-text'
import { decodeXml } from './rag-xml'
import { RAG_TEXT_EXTENSIONS, RAG_OFFICE_EXTENSIONS, RAG_IMAGE_EXTENSIONS } from './formats'
import type { RagDocument } from './rag-types'
export type { RagBlock, RagDocument } from './rag-types'
export interface RagOcrOptions {
  pdfPages?: (bytes: Uint8Array, pages: number[]) => Promise<Map<number, string>>
  image?: (bytes: Uint8Array) => Promise<string | null>
}
const plain = new Set<string>(RAG_TEXT_EXTENSIONS)
const code = new Set([
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'cs',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sql',
  'sh',
  'ps1',
  'css',
])
export async function parseFileToRag(path: string, ocr?: RagOcrOptions): Promise<RagDocument> {
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error('RAG extraction accepts files up to 64 MiB.')
  const title = basename(path),
    ext = extname(path).slice(1).toLowerCase()
  if (plain.has(ext)) {
    const bytes = await readFile(path)
    // Explicit UTF-16 BOM support; reject malformed UTF-8 instead of indexing mojibake silently.
    let text: string
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    else if (bytes[0] === 0xfe && bytes[1] === 0xff)
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const warnings: string[] = []
    const blocks =
      ext === 'csv' || ext === 'tsv'
        ? delimitedBlocks(text, ext === 'csv' ? ',' : '\t')
        : ext === 'xml'
          ? xmlBlocks(text)
          : ext === 'json'
            ? jsonBlocks(text)
            : ext === 'jsonl' || ext === 'ndjson'
              ? text.split(/\r?\n/).flatMap((line, i) =>
                  line.trim()
                    ? jsonBlocks(line).map((b) => ({
                        ...b,
                        locator: `line ${i + 1}, ${b.locator}`,
                        lineStart: i + 1,
                        lineEnd: i + 1,
                      }))
                    : [],
                )
              : ext === 'html' || ext === 'htm'
                ? htmlBlocks(text).map((b) => ({
                    ...b,
                    text: decodeXml(b.text),
                    locator: `HTML section ${b.headings.join(' > ') || 'body'}`,
                  }))
                : code.has(ext)
                  ? codeBlocks(text)
                  : markdownBlocks(text)
    if (['yaml', 'yml', 'toml', 'ini'].includes(ext))
      warnings.push(
        'Configuration/XML chunks preserve source text and line references; no schema inference is performed.',
      )
    const partial =
      ['html', 'htm'].includes(ext) &&
      /<(?:img|canvas|svg|video)\b|(?:colspan|rowspan)\s*=/i.test(text)
    if (partial)
      warnings.push(
        'HTML visual media is not fetched or OCRed; merged table spans may require native inspection.',
      )
    return { title, format: ext, blocks, warnings, partial }
  }
  if (ext === 'eml') {
    const { emlDocument } = await import('./rag-message')
    return emlDocument(await readFile(path), title, ocr?.image)
  }
  if (ext === 'zip') {
    const { archiveDocument } = await import('./rag-archive')
    return archiveDocument(await readFile(path), title, (entry) => parseFileToRag(entry, ocr))
  }
  if (ext === 'odt' || ext === 'odp') {
    const { openDocumentRag } = await import('./opendocument')
    return openDocumentRag(await readFile(path), title, ext)
  }
  if ((RAG_OFFICE_EXTENSIONS as readonly string[]).includes(ext)) {
    const office = await import('./rag-office'),
      bytes = await readFile(path)
    let document: RagDocument
    try {
      document = await (['docx', 'docm', 'dotx', 'dotm'].includes(ext)
        ? office.docxDocument(bytes, title)
        : ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(ext)
          ? office.pptxDocument(bytes, title)
          : ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)
            ? office.xlsxDocument(bytes, title)
            : Promise.reject(new Error(`No RAG office extractor for .${ext}`)))
    } catch (error) {
      if (
        !ocr?.image ||
        !['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext) ||
        !(error instanceof Error) ||
        !error.message.includes('no extractable cell content')
      )
        throw error
      document = {
        title,
        format: ext,
        blocks: [],
        warnings: ['Workbook has no extractable cells; embedded images may contain OCR text.'],
        partial: true,
      }
    }
    document.format = ext
    if (ocr?.image) {
      const { ocrOfficeMedia } = await import('./rag-media')
      const recognized = await ocrOfficeMedia(bytes, ocr.image)
      document.blocks.push(...recognized.blocks)
      document.warnings.push(...recognized.warnings)
      if (recognized.blocks.length) document.partial = true
    }
    return document
  }
  if (ext === 'pdf') {
    const { pdfToPages } = await import('./pdf'),
      bytes = await readFile(path),
      pages = await pdfToPages(bytes)
    const missing = pages.flatMap((page, i) => (page.trim() ? [] : [i + 1]))
    let recovered = new Map<number, string>(),
      ocrFailure = ''
    if (missing.length && ocr?.pdfPages) {
      try {
        recovered = await ocr.pdfPages(bytes, missing)
      } catch (e) {
        ocrFailure = e instanceof Error ? e.message : String(e)
      }
    }
    for (const page of missing)
      if (recovered.get(page)?.trim()) pages[page - 1] = recovered.get(page)!.trim()
    const blocks = pages.flatMap((text, i) =>
      markdownBlocks(text).map((b) => ({
        ...b,
        headings: [],
        page: i + 1,
        locator: `page ${i + 1}, ${b.locator}`,
      })),
    )
    if (!blocks.length)
      throw new Error(
        'PDF has no extractable text, and local OCR recovered no text. Check the OCR helper and installed recognition languages.',
      )
    const unindexed = missing.filter((page) => !recovered.get(page)?.trim())
    return {
      title,
      format: 'pdf',
      blocks,
      partial: true,
      warnings: [
        'PDF indexing uses the text layer and local OCR for pages without extractable text. Complex table layout and visual content may need direct inspection.',
        ...(recovered.size
          ? [
              `Local OCR recovered text on pages: ${[...recovered.keys()].join(', ')}. Verify recognition against the original image before relying on exact wording.`,
            ]
          : []),
        ...(unindexed.length
          ? [`No text recovered on pages: ${unindexed.join(', ')}. These pages are not embedded.`]
          : []),
        ...(ocrFailure ? [`OCR failed: ${ocrFailure}`] : []),
      ],
    }
  }
  if ((RAG_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    if (!ocr?.image) throw new Error('Image OCR is unavailable in this environment.')
    const text = (await ocr.image(await readFile(path)))?.trim() ?? ''
    if (!text)
      throw new Error(
        'Local OCR found no readable text in this image; no file-content vectors were created.',
      )
    return {
      title,
      format: ext,
      blocks: markdownBlocks(text).map((b) => ({ ...b, locator: `image OCR, ${b.locator}` })),
      partial: true,
      warnings: [
        'Image text was recognized locally by OCR. Layout and visual meaning are not embedded; verify exact wording against the original image.',
      ],
    }
  }
  if (ext === 'doc' || ext === 'ppt') {
    const text =
      ext === 'doc'
        ? await (await import('./doc')).docToText(await readFile(path))
        : await (await import('./ppt')).pptToText(await readFile(path))
    return {
      title,
      format: ext,
      blocks: markdownBlocks(text).map((b) => ({
        ...b,
        locator: `legacy extracted text, ${b.locator}`,
      })),
      partial: true,
      warnings: [
        'Legacy format: extracted-text offsets only; original layout/page structure is not guaranteed. Save as DOCX/PPTX for richer structure.',
      ],
    }
  }
  throw new Error(
    `No RAG text extractor for .${ext || '(no extension)'}. Images/scans need OCR; legacy XLS needs conversion to XLSX. Filename-only records are never marked Embedded.`,
  )
}
