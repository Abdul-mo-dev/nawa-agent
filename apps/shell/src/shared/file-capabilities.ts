import { RAG_FILE_EXTENSIONS, RAG_IMAGE_EXTENSIONS } from '@genoffice/file-parse/formats'

export const NATIVE_FILE_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
] as const
export const ANALYTICAL_FILE_EXTENSIONS = [
  '.csv',
  '.tsv',
  '.jsonl',
  '.ndjson',
  '.json',
  '.xlsx',
  '.xlsm',
] as const
const native = new Set<string>(NATIVE_FILE_EXTENSIONS)
const analytical = new Set<string>(ANALYTICAL_FILE_EXTENSIONS)
const searchable = new Set<string>(RAG_FILE_EXTENSIONS.map((extension) => '.' + extension))
const images = new Set<string>(RAG_IMAGE_EXTENSIONS.map((extension) => '.' + extension))

/** Format support is distinct from successful ingestion, review or editor availability. */
export function fileCapabilities(path: string) {
  const extension = /\.[^.\\/]+$/.exec(path)?.[0].toLowerCase() ?? ''
  return {
    extension,
    search: searchable.has(extension),
    inspection: native.has(extension),
    analysis: analytical.has(extension),
    editing: native.has(extension),
    ocr:
      images.has(extension) ||
      extension === '.pdf' ||
      /\.(?:doc|dot|xls|xlt|ppt|pps)[xm]$/.test(extension),
    legacy: ['.xls', '.doc', '.ppt'].includes(extension),
  }
}
