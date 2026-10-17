import { RAG_FILE_EXTENSIONS, RAG_IMAGE_EXTENSIONS } from '@genoffice/file-parse/formats'
import {
  OFFICE_IMPORT_EXTENSIONS,
  legacyOfficeTarget,
  officeImportTarget,
} from '@genoffice/file-formats'

export const SPREADSHEET_COPY_EXTENSIONS = ['xls', 'ods', 'xlsb', 'csv', 'tsv'] as const
export const MODERN_OFFICE_COPY_EXTENSIONS = ['dotx', 'xltx', 'xltm', 'ppsx', 'potx'] as const

/** Folder edits of import formats always create modern copies. */
export function directoryImportTarget(path: string): 'docx' | 'pptx' | 'xlsx' | 'xlsm' | undefined {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  if (extension === 'dotx') return 'docx'
  if (extension === 'xltx') return 'xlsx'
  if (extension === 'xltm') return 'xlsm'
  if (extension === 'ppsx' || extension === 'potx') return 'pptx'
  return SPREADSHEET_COPY_EXTENSIONS.some((value) => value === extension)
    ? 'xlsx'
    : officeImportTarget(path)
}

export function directoryImportPath(path: string): string {
  const target = directoryImportTarget(path)
  return target ? path.replace(/\.[^.\\/]+$/, `.${target}`) : path
}

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
export const DIRECTORY_FILE_EXTENSIONS = [
  ...NATIVE_FILE_EXTENSIONS,
  '.docm',
  '.dotm',
  '.xlsm',
  '.pptm',
  '.ppsm',
  '.potm',
  ...OFFICE_IMPORT_EXTENSIONS.map((extension) => `.${extension}`),
  ...SPREADSHEET_COPY_EXTENSIONS.map((extension) => `.${extension}`),
  ...MODERN_OFFICE_COPY_EXTENSIONS.map((extension) => `.${extension}`),
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
const native = new Set<string>(DIRECTORY_FILE_EXTENSIONS)
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
    ...(directoryImportTarget(path) ? { editOutput: directoryImportTarget(path) } : {}),
    ocr:
      images.has(extension) ||
      extension === '.pdf' ||
      /\.(?:doc|dot|xls|xlt|ppt|pps|pot)[xm]$/.test(extension),
    legacy: extension === '.xls' || legacyOfficeTarget(path) !== undefined,
  }
}
