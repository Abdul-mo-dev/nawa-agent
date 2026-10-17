import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { cleanupImportTempDirectory } from './temp-files'
import type { WorkbookImportInfo } from '../shared/desktop-api'
import { csvToXlsxBufferForOpen, decodeCsvBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'

export const CONVERTED_WORKBOOK_EXTENSIONS = new Set(['xls', 'ods', 'xlsb'])
export const MAX_CONVERTED_IMPORT_BYTES = 64 * 1024 * 1024
export const MAX_DELIMITED_IMPORT_BYTES = 32 * 1024 * 1024

const conversionResult = z.object({
  sheets: z.number().int().positive(),
  cells: z.number().int().nonnegative(),
  formulasAsValues: z.number().int().nonnegative().default(0),
  formulaReadFailures: z.number().int().nonnegative().default(0),
})

export class WorkbookImportTooLargeError extends Error {
  constructor() {
    super('Workbook imports accept files up to 64 MiB.')
  }
}

/**
 * The sidecar refused conversion before allocating the grid: the file claims
 * dimensions (or an inflated size) past the conversion budgets. Kept distinct
 * from corrupt-file failures so the UI can tell "too big to convert safely"
 * from "could not be read".
 */
export class WorkbookConversionBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbookConversionBudgetError'
  }
}

/** Matches the sidecar's budget-refusal wording (see convert.rs preflights). */
export function isConversionBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /refuses huge dimensions|conversion budget|conversion deadline|inflates to/i.test(message)
}

/** Imports always write an owned copy; the source never becomes a save target. */
export async function prepareConvertedWorkbookForOpen(
  client: { convertWorkbook(input: { path: string; targetPath: string }): Promise<unknown> },
  path: string,
  tempRoot: string,
): Promise<{
  openPath: string
  importTempDir: string
  suggestSaveAs: string
  importInfo?: WorkbookImportInfo
  conversionInfo: { formulasAsValues: number; formulaReadFailures: number }
}> {
  const format = extname(path).slice(1).toLowerCase()
  if (!CONVERTED_WORKBOOK_EXTENSIONS.has(format)) throw new Error('Unsupported workbook import.')
  const sourceStat = await stat(path)
  if (!sourceStat.isFile()) throw new Error('Workbook import requires an individual file.')
  if (sourceStat.size > MAX_CONVERTED_IMPORT_BYTES) throw new WorkbookImportTooLargeError()
  const directory = join(tempRoot, 'genoffice-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, basename(path).replace(/\.[^.]+$/, '.xlsx'))
  try {
    const result = conversionResult.parse(
      await client.convertWorkbook({ path, targetPath: openPath }),
    )
    const outStat = await stat(openPath)
    if (outStat.size > MAX_CONVERTED_IMPORT_BYTES) {
      throw new WorkbookImportTooLargeError()
    }
    return {
      openPath,
      importTempDir: directory,
      suggestSaveAs: path.replace(/\.[^.]+$/, '.xlsx'),
      conversionInfo: {
        formulasAsValues: result.formulasAsValues,
        formulaReadFailures: result.formulaReadFailures,
      },
      ...(format === 'ods' || format === 'xlsb' || format === 'xls'
        ? {
            importInfo: {
              format,
              formulasAsValues: result.formulasAsValues,
              formulaReadFailures: result.formulaReadFailures,
            },
          }
        : {}),
    }
  } catch (error) {
    await cleanupImportTempDirectory(tempRoot, directory)
    if (isConversionBudgetError(error)) {
      const message = error instanceof Error ? error.message : String(error)
      throw new WorkbookConversionBudgetError(message)
    }
    throw error
  }
}

/** Directory chat uses the same engines, but always saves to a new XLSX copy. */
export async function importWorkbookCopyBytes(
  client: { convertWorkbook(input: { path: string; targetPath: string }): Promise<unknown> },
  path: string,
  tempRoot: string,
  preferredCharset?: string,
): Promise<{
  bytes: Buffer
  format: string
  formulasAsValues: number
  formulaReadFailures: number
}> {
  const format = extname(path).slice(1).toLowerCase()
  const delimited = format === 'csv' || format === 'tsv'
  if (!delimited && !CONVERTED_WORKBOOK_EXTENSIONS.has(format))
    throw new Error('Unsupported workbook import.')
  const source = await stat(path)
  if (!source.isFile()) throw new Error('Workbook import requires an individual file.')
  if (source.size > (delimited ? MAX_DELIMITED_IMPORT_BYTES : MAX_CONVERTED_IMPORT_BYTES))
    throw new Error(`Workbook import exceeds the ${delimited ? 32 : 64} MiB limit.`)
  if (delimited) {
    const input = await readFile(path)
    if (input.length > MAX_DELIMITED_IMPORT_BYTES)
      throw new Error('Workbook import exceeds the 32 MiB limit.')
    const converted = await csvToXlsxBufferForOpen(
      decodeCsvBuffer(input, preferredCharset),
      'Sheet1',
      format === 'tsv' ? '\t' : undefined,
    )
    return { bytes: converted.buffer, format, formulasAsValues: 0, formulaReadFailures: 0 }
  }
  const prepared = await prepareConvertedWorkbookForOpen(client, path, tempRoot)
  try {
    if ((await stat(prepared.openPath)).size > MAX_CONVERTED_IMPORT_BYTES)
      throw new Error('Converted workbook exceeds the 64 MiB limit.')
    return { bytes: await readFile(prepared.openPath), format, ...prepared.conversionInfo }
  } finally {
    await cleanupImportTempDirectory(tempRoot, prepared.importTempDir)
  }
}
