import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
await mkdir(directory, { recursive: true })
const fixtureDirectory = join(workspace, 'apps/sheets/tests/fixtures/workbook-imports')
await copyFile(join(fixtureDirectory, 'basic.ods'), join(directory, 'formulas.ods'))
await copyFile(join(fixtureDirectory, 'any_sheets.xlsb'), join(directory, 'sheets.xlsb'))
await copyFile(join(fixtureDirectory, 'LICENSE.calamine'), join(directory, 'LICENSE.calamine'))
await copyFile(join(fixtureDirectory, 'provenance.json'), join(directory, 'provenance.json'))
const rows = [
  ['ID', 'Amount', 'Notes'],
  ['00123', '12.5', 'alpha,beta,gamma,delta'],
  ['日本語', '7', 'مرحبا بالعالم'],
  ['literal formula', '3', '=1+1'],
]
const csv =
  rows
    .map((row) =>
      row
        .map((value) => (/[,"\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
        .join(','),
    )
    .join('\r\n') + '\r\n'
await writeFile(join(directory, 'table.csv'), '\uFEFF' + csv)
await writeFile(
  join(directory, 'table.tsv'),
  Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(rows.map((row) => row.join('\t')).join('\r\n') + '\r\n', 'utf16le'),
  ]),
)
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
const zip = new JSZip()
zip.file(
  '[Content_Types].xml',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
)
zip.file(
  '_rels/.rels',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
)
zip.file(
  'xl/workbook.xml',
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>',
)
zip.file(
  'xl/_rels/workbook.xml.rels',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
)
zip.file(
  'xl/styles.xml',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
)
const sheetRows = rows.map(
  (row, index) =>
    `<row r="${index + 1}">${row
      .map((value, column) => {
        const address = `${String.fromCharCode(65 + column)}${index + 1}`
        return column === 1 && index > 0
          ? `<c r="${address}"><v>${value}</v></c>`
          : `<c r="${address}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`
      })
      .join('')}</row>`,
)
sheetRows.push(
  '<row r="5"><c r="A5" t="inlineStr"><is><t>Total</t></is></c><c r="B5"><f>SUM(B2:B4)</f><v>22.5</v></c></row>',
)
sheetRows.push(
  '<row r="6"><c r="A6" t="inlineStr"><is><t>Absolute total</t></is></c><c r="B6"><f>SUM($B$2:$B$4)</f><v>22.5</v></c></row>',
)
zip.file(
  'xl/worksheets/sheet1.xml',
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C6"/><sheetData>${sheetRows.join('')}</sheetData></worksheet>`,
)
const sourceDirectory = join(directory, 'source')
await mkdir(sourceDirectory, { recursive: true })
const seed = join(sourceDirectory, 'binary.xlsx')
await writeFile(seed, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
// LibreOffice is used only to author the genuine XLS test fixture. Runtime import uses Rust.
const executable =
  process.env.NAWA_LIBREOFFICE_PATH ?? 'C:/Program Files/LibreOffice/program/soffice.com'
await mkdir(join(workspace, '.task'), { recursive: true })
const profile = await mkdtemp(join(workspace, '.task', 'spreadsheet-fixture-profile-'))
await promisify(execFile)(
  executable,
  [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless',
    '--nologo',
    '--norestore',
    '--convert-to',
    'xls:MS Excel 97',
    '--outdir',
    directory,
    seed,
  ],
  { windowsHide: true, timeout: 90_000 },
)
const binary = await readFile(join(directory, 'binary.xls'))
assert.equal(binary.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1')
const files = []
for (const name of ['binary.xls', 'formulas.ods', 'sheets.xlsb', 'table.csv', 'table.tsv']) {
  const bytes = await readFile(join(directory, name))
  files.push({
    file: name,
    extension: name.split('.').pop(),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n',
)
console.log(
  'Created five spreadsheet chat fixtures; source XLSX and upstream XLSB provenance retained.',
)
