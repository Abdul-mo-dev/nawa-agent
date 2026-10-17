import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { normalizeDocxFormat } from '@genoffice/docx-engine/zip-splice'
import { getUiLang, legacyOfficeMessage } from '@genoffice/i18n'
import {
  directoryImportTarget,
  MODERN_OFFICE_COPY_EXTENSIONS,
} from '../../shared/file-capabilities'
import type { ActionDependencies } from './manager'

export interface DirectoryImportedCopy {
  bytes: Uint8Array
  warnings: string[]
}

/** A private saved-byte snapshot is the only input; original paths never reach converters. */
export async function importDirectoryCopy(
  deps: Pick<ActionDependencies, 'importOffice' | 'importWorkbook'>,
  path: string,
): Promise<DirectoryImportedCopy> {
  const target = directoryImportTarget(path)
  const sourceExtension = extname(path).slice(1).toLowerCase()
  if (MODERN_OFFICE_COPY_EXTENSIONS.some((extension) => extension === sourceExtension)) {
    if (!target) throw new Error('Unsupported Office copy format.')
    const source = await stat(path)
    if (!source.isFile()) throw new Error('Office import requires an individual file.')
    if (source.size > 64 * 1024 * 1024) throw new Error('Office imports are limited to 64 MiB.')
    const bytes = await normalizeDocxFormat(await readFile(path), `copy.${target}`)
    if (bytes.length > 64 * 1024 * 1024)
      throw new Error('Converted Office package exceeds the 64 MiB limit.')
    return {
      bytes,
      warnings: [
        legacyOfficeMessage(getUiLang(), 'modernCopy', { from: sourceExtension, to: target }),
      ],
    }
  }
  if (target === 'xlsx') {
    if (!deps.importWorkbook) throw new Error('Spreadsheet import service is unavailable.')
    return deps.importWorkbook(path)
  }
  if (!target || !deps.importOffice) throw new Error('Legacy Office import service is unavailable.')
  return {
    bytes: await deps.importOffice(path),
    warnings: [legacyOfficeMessage(getUiLang(), 'chatCopy', { from: sourceExtension, to: target })],
  }
}
