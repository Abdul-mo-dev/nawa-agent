import { macroFreePackageChanges, officeMainPart, rewriteMainContentType } from './office-package'
export {
  isMacroPartName,
  macroPartRelsName,
  removeElementsByAttribute,
  removeMacroOverrides,
  removeMacroRelationships,
} from './office-package'
import extensions from './extensions.json'
import previews from './preview-extensions.json'
export { openDocumentMimeForPath, openDocumentManifestEncrypted } from './opendocument'

export const OFFICE_PACKAGE_METADATA_LIMIT = 16 * 1024 * 1024

/** Every editor entry point uses this catalog, including packaging metadata. */
export const EDITOR_EXTENSIONS = extensions
export const EDITOR_FILE_EXTENSIONS = Object.values(extensions).flat()
export const PREVIEW_IMAGE_EXTENSIONS = previews.image
export const PREVIEW_MESSAGE_EXTENSIONS = previews.message
export const PREVIEW_FILE_EXTENSIONS = [...PREVIEW_IMAGE_EXTENSIONS, ...PREVIEW_MESSAGE_EXTENSIONS]
export const OPENABLE_FILE_EXTENSIONS = [...EDITOR_FILE_EXTENSIONS, ...PREVIEW_FILE_EXTENSIONS]
export const EDITOR_DIALOG_EXTENSIONS = OPENABLE_FILE_EXTENSIONS
/** Source editing never passes through Markdown or executes scripts. CSV/TSV belong to Sheets. */
export const SOURCE_TEXT_EXTENSIONS = extensions.markdown.filter(
  (ext) => !['md', 'markdown'].includes(ext),
)
export const LEGACY_OFFICE_EXTENSIONS = ['doc', 'dot', 'ppt', 'pps', 'pot'] as const
export type LegacyOfficeExtension = (typeof LEGACY_OFFICE_EXTENSIONS)[number]
export const OPENDOCUMENT_IMPORT_EXTENSIONS = ['odt', 'odp'] as const
export const OFFICE_IMPORT_EXTENSIONS = [
  ...LEGACY_OFFICE_EXTENSIONS,
  ...OPENDOCUMENT_IMPORT_EXTENSIONS,
  'rtf',
] as const
export type OfficeImportExtension = (typeof OFFICE_IMPORT_EXTENSIONS)[number]

/** Legacy formats are imported copies, never valid destinations for OOXML bytes. */
export function legacyOfficeTarget(path: string): 'docx' | 'pptx' | undefined {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  if (ext === 'doc' || ext === 'dot') return 'docx'
  if (ext === 'ppt' || ext === 'pps' || ext === 'pot') return 'pptx'
  return undefined
}

/** Import-only formats always become editable OOXML copies. */
export function officeImportTarget(path: string): 'docx' | 'pptx' | undefined {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  if (extension === 'odt') return 'docx'
  if (extension === 'rtf') return 'docx'
  if (extension === 'odp') return 'pptx'
  return legacyOfficeTarget(path)
}

export function modernOfficePath(path: string): string {
  const target = officeImportTarget(path)
  return target ? path.replace(/\.[^.\\/]+$/, `.${target}`) : path
}

export const EDITOR_SAVE_EXTENSIONS = {
  docs: extensions.docs.filter((ext) => !officeImportTarget(`file.${ext}`)),
  slides: extensions.slides.filter((ext) => !officeImportTarget(`file.${ext}`)),
}
export const EDITOR_FILTER_FAMILIES: Record<string, readonly string[]> = {
  docx: extensions.docs,
  xlsx: extensions.sheets,
  pptx: extensions.slides,
  md: extensions.markdown,
  html: extensions.html,
}

export function extensionPattern(values: readonly string[]): RegExp {
  return new RegExp(
    `\\.(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
    'i',
  )
}

/** File dialogs may return a bare name; refuse unrelated extensions before writing. */
export function editorSavePath(path: string, allowed: readonly string[], fallback: string): string {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  if (!extension) return `${path}.${fallback}`
  if (allowed.includes(extension)) return path
  throw new Error(`Save as ${allowed.map((ext) => `.${ext}`).join(' or ')}.`)
}

const officeTypes = {
  docx: [
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  ],
  docm: ['word/document.xml', 'application/vnd.ms-word.document.macroEnabled.main+xml'],
  dotx: [
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  ],
  dotm: ['word/document.xml', 'application/vnd.ms-word.template.macroEnabled.main+xml'],
  xlsx: [
    'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  ],
  xltx: [
    'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  ],
  xlsm: ['xl/workbook.xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'],
  xltm: ['xl/workbook.xml', 'application/vnd.ms-excel.template.macroEnabled.main+xml'],
  pptx: [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  ],
  ppsx: [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  ],
  potx: [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  ],
  pptm: [
    'ppt/presentation.xml',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  ],
  ppsm: ['ppt/presentation.xml', 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml'],
  potm: ['ppt/presentation.xml', 'application/vnd.ms-powerpoint.template.macroEnabled.main+xml'],
} as const

/** Every main-part content type the normalizer may rewrite, whatever the part path. */
const KNOWN_MAIN_CONTENT_TYPES: Set<string> = new Set(
  Object.values(officeTypes).map(([, type]) => type),
)

/** Change only the main-part type; all relationships and authored parts survive. */
export function officeContentTypesForPath(xml: string, path: string, mainPart?: string): string {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  const format =
    ext && Object.hasOwn(officeTypes, ext)
      ? officeTypes[ext as keyof typeof officeTypes]
      : undefined
  if (!format) return xml
  try {
    return rewriteMainContentType(xml, format[1], KNOWN_MAIN_CONTENT_TYPES, mainPart)
  } catch (error) {
    throw new Error(
      `Office package is missing or has an invalid content type for /${mainPart ?? format[0]}.`,
      { cause: error },
    )
  }
}

/** Plan format conversion using the actual officeDocument relationship and namespace-aware metadata. */
export function officePackageChanges(
  names: readonly string[],
  metadata: ReadonlyMap<string, string>,
  targetPath: string,
) {
  const types = metadata.get('[Content_Types].xml')
  if (types === undefined) throw new Error('Office package is missing [Content_Types].xml.')
  const root = metadata.get('_rels/.rels')
  const main = root === undefined ? undefined : officeMainPart(root)
  const normalized = officeContentTypesForPath(types, targetPath, main)
  const effective = new Map(metadata)
  effective.set('[Content_Types].xml', normalized)
  const macroFree = /\.(?:docx|dotx|xlsx|xltx|pptx|ppsx|potx)$/i.test(targetPath)
  const changes = macroFree
    ? macroFreePackageChanges(names, effective)
    : { replaced: new Map<string, string>(), removed: new Set<string>() }
  if (!changes.replaced.has('[Content_Types].xml') && normalized !== types)
    changes.replaced.set('[Content_Types].xml', normalized)
  return changes
}
