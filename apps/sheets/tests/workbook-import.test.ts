import { copyFile, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { saveWorkbookViaSidecar } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import {
  MAX_CONVERTED_IMPORT_BYTES,
  prepareConvertedWorkbookForOpen,
  importWorkbookCopyBytes,
  MAX_DELIMITED_IMPORT_BYTES,
  WorkbookConversionBudgetError,
} from '../src/main/workbook-import'
import { cleanupImportTempDirectory } from '../src/main/temp-files'

const fixtureDirectory = fileURLToPath(new URL('./fixtures/workbook-imports/', import.meta.url))
let directory: string
let client: XlsxSidecarClient

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbook-import-test-'))
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  client = new XlsxSidecarClient(
    fileURLToPath(new URL(`../native/xlsx-engine/target/release/${executable}`, import.meta.url)),
  )
})

afterAll(async () => {
  client.stop()
  await rm(directory, { recursive: true, force: true })
})

it.each(['basic.ods', 'any_sheets.xlsb'])(
  'opens %s as an editable XLSX copy and leaves the source untouched after saving',
  async (name) => {
    const source = join(directory, name)
    await copyFile(join(fixtureDirectory, name), source)
    const original = await readFile(source)
    const prepared = await prepareConvertedWorkbookForOpen(client, source, directory)
    expect(prepared.openPath).not.toBe(source)
    expect(prepared.suggestSaveAs).toBe(source.replace(/\.[^.]+$/, '.xlsx'))
    expect(dirname(prepared.openPath)).toBe(prepared.importTempDir)
    const opened = (await client.open(prepared.openPath)) as {
      sessionId: string
      sheets: { id: string; name: string }[]
    }
    const sheetName = opened.sheets[0]!.name
    expect(opened.sheets.length).toBeGreaterThan(0)
    await client.close(opened.sessionId)
    await saveWorkbookViaSidecar({
      client,
      sourcePath: prepared.openPath,
      targetPath: prepared.suggestSaveAs,
      edits: [{ sheetName, row: 0, column: 0, writeValue: true, cell: { value: 'Imported edit' } }],
    })
    const saved = await JSZip.loadAsync(await readFile(prepared.suggestSaveAs))
    expect(await saved.file('xl/worksheets/sheet1.xml')!.async('text')).toContain('Imported edit')
    expect(await readFile(source)).toEqual(original)
    expect(prepared.importInfo?.format).toBe(name.endsWith('.ods') ? 'ods' : 'xlsb')
    if (name.endsWith('.ods')) {
      expect(prepared.importInfo?.formulasAsValues).toBe(1)
      const imported = await JSZip.loadAsync(await readFile(prepared.openPath))
      const xml = await imported.file('xl/worksheets/sheet1.xml')!.async('text')
      expect(xml).toContain('<f>SUM(A1:B1)</f>')
      expect(xml).toContain("<f>'Other Sheet'!A1</f>")
      expect(xml).toContain('<c r="C2"><v>42</v></c>')
      expect(xml).toContain('<c r="A2" s="1"><v>45293</v></c>')
      expect(xml).toContain('<c r="A3" t="str"><f>IF(')
      expect(xml).not.toContain('of:=')
    }
    const reopened = (await client.open(prepared.suggestSaveAs)) as { sessionId: string }
    await client.close(reopened.sessionId)
    await cleanupImportTempDirectory(directory, prepared.importTempDir)
    await expect(stat(prepared.importTempDir)).rejects.toThrow()
  },
)

it('cleans up an unsuccessful conversion without changing the input', async () => {
  const source = join(directory, 'broken.ods')
  await writeFile(source, 'not a workbook')
  const importRoot = join(directory, 'genoffice-imports')
  const before = await readdir(importRoot)
  await expect(prepareConvertedWorkbookForOpen(client, source, directory)).rejects.toThrow()
  expect(await readdir(importRoot)).toEqual(before)
  expect(await readFile(source, 'utf8')).toBe('not a workbook')
})

it('rejects oversized inputs before calling the converter', async () => {
  const source = join(directory, 'large.xlsb')
  const handle = await open(source, 'w')
  await handle.truncate(MAX_CONVERTED_IMPORT_BYTES + 1)
  await handle.close()
  const convertWorkbook = vi.fn()
  await expect(
    prepareConvertedWorkbookForOpen({ convertWorkbook }, source, directory),
  ).rejects.toThrow('64 MiB')
  expect(convertWorkbook).not.toHaveBeenCalled()
})

it.each(['binary.xls', 'formulas.ods', 'sheets.xlsb', 'table.csv', 'table.tsv'])(
  'imports %s for directory chat, saves native cell edits and preserves source bytes',
  async (name) => {
    const source = join(directory, name)
    await copyFile(
      resolve(import.meta.dirname, '../../../test-files/spreadsheet-chat', name),
      source,
    )
    const original = await readFile(source)
    const imported = await importWorkbookCopyBytes(client, source, directory)
    const zip = await JSZip.loadAsync(imported.bytes)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text')
    if (name.endsWith('.csv') || name.endsWith('.tsv')) {
      expect(xml).toContain('00123')
      expect(xml).toContain('日本語')
      expect(xml).toContain('مرحبا بالعالم')
      expect(xml).toContain('alpha,beta,gamma,delta')
      expect(xml).toContain('=1+1')
      expect(xml).not.toContain('<f>')
      expect(xml).toContain('A1:C4')
    }
    if (name.endsWith('.xls')) {
      expect(xml).toContain('<f>SUM($B$2:$B$4)</f>')
      expect(xml).toContain('<c r="B5"><v>22.5</v></c>')
      expect(xml).not.toContain('USN')
      expect(imported.formulasAsValues).toBe(1)
    }
    if (name.endsWith('.ods')) expect(imported.formulasAsValues).toBe(1)
    const copy = join(directory, `${name}.imported.xlsx`)
    const saved = join(directory, `${name}.edited.xlsx`)
    await writeFile(copy, imported.bytes)
    const opened = (await client.open(copy)) as { sessionId: string; sheets: { name: string }[] }
    const sheetName = opened.sheets[0]!.name
    await client.close(opened.sessionId)
    await saveWorkbookViaSidecar({
      client,
      sourcePath: copy,
      targetPath: saved,
      edits: [
        {
          sheetName,
          row: 0,
          column: 0,
          writeValue: true,
          cell: { value: 'Directory chat edit verified' },
        },
      ],
    })
    const editedZip = await JSZip.loadAsync(await readFile(saved))
    expect(await editedZip.file('xl/worksheets/sheet1.xml')!.async('text')).toContain(
      'Directory chat edit verified',
    )
    const reopened = (await client.open(saved)) as { sessionId: string }
    await client.close(reopened.sessionId)
    expect(await readFile(source)).toEqual(original)
    expect(await readdir(join(directory, 'genoffice-imports'))).toEqual([])
  },
)

it('rejects oversized delimited imports before reading or converting them', async () => {
  const source = join(directory, 'large.csv')
  const handle = await open(source, 'w')
  await handle.truncate(MAX_DELIMITED_IMPORT_BYTES + 1)
  await handle.close()
  const convertWorkbook = vi.fn()
  await expect(importWorkbookCopyBytes({ convertWorkbook }, source, directory)).rejects.toThrow(
    '32 MiB',
  )
  expect(convertWorkbook).not.toHaveBeenCalled()
})

it('cleans up oversized converted outputs without reading them into memory', async () => {
  const source = join(directory, 'large-output.ods')
  await writeFile(source, 'fake source for converter limit check')
  const convertWorkbook = vi.fn(async ({ targetPath }: { path: string; targetPath: string }) => {
    const handle = await open(targetPath, 'w')
    await handle.truncate(MAX_CONVERTED_IMPORT_BYTES + 1)
    await handle.close()
    return { sheets: 1, cells: 1 }
  })
  await expect(importWorkbookCopyBytes({ convertWorkbook }, source, directory)).rejects.toThrow(
    /64 MiB/,
  )
  expect(await readdir(join(directory, 'genoffice-imports'))).toEqual([])
})

it('surfaces sidecar budget refusals as WorkbookConversionBudgetError and cleans up', async () => {
  const source = join(directory, 'huge.ods')
  await writeFile(source, 'fake ods refused by the converter')
  const convertWorkbook = vi.fn(async () => {
    throw new Error(
      "Workbook conversion refuses huge dimensions: sheet 'Sheet1' spans about 17179869184 cells (1048576 rows by 16384 columns), over the 10000000 cells-per-sheet conversion budget.",
    )
  })
  const error = await prepareConvertedWorkbookForOpen({ convertWorkbook }, source, directory).catch(
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(WorkbookConversionBudgetError)
  expect((error as Error).message).toMatch(/refuses huge dimensions/)
  expect(await readdir(join(directory, 'genoffice-imports'))).toEqual([])
})

it('propagates budget refusals through directory-chat imports without wrapping other errors', async () => {
  const budgetSource = join(directory, 'huge-directory.ods')
  await writeFile(budgetSource, 'fake ods refused by the converter')
  const budgetClient = {
    convertWorkbook: vi.fn(async () => {
      throw new Error('Workbook conversion exceeded the 120 s conversion deadline.')
    }),
  }
  await expect(importWorkbookCopyBytes(budgetClient, budgetSource, directory)).rejects.toThrow(
    WorkbookConversionBudgetError,
  )
  const corruptSource = join(directory, 'corrupt-directory.ods')
  await writeFile(corruptSource, 'not a workbook')
  const corruptClient = {
    convertWorkbook: vi.fn(async () => {
      throw new Error('Unable to read the workbook: unsupported file.')
    }),
  }
  const error = await importWorkbookCopyBytes(corruptClient, corruptSource, directory).catch(
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(WorkbookConversionBudgetError)
  expect(await readdir(join(directory, 'genoffice-imports'))).toEqual([])
})

it('refuses a huge-dimension ODS through the real converter without exhausting memory', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet')
  zip.file(
    'content.xml',
    '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
  )
  const source = join(directory, 'real-huge.ods')
  await writeFile(source, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  expect((await stat(source)).size).toBeLessThan(10_000)
  const started = Date.now()
  const error = await prepareConvertedWorkbookForOpen(client, source, directory).catch(
    (failure: unknown) => failure,
  )
  // Plausibility bound, not a benchmark: refusal must arrive without
  // inflating or allocating the claimed gigas.
  expect(Date.now() - started).toBeLessThan(30_000)
  expect(error).toBeInstanceOf(WorkbookConversionBudgetError)
  expect((error as Error).message).toMatch(/refuses huge dimensions/)
}, 60_000)
