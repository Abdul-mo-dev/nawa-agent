import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const source = 'test-files/spreadsheet-chat/source/binary.xlsx'
const zip = await JSZip.loadAsync(await readFile(join(workspace, source)))
const typesFile = zip.file('[Content_Types].xml')
const relationshipsFile = zip.file('xl/_rels/workbook.xml.rels')
assert(typesFile && relationshipsFile)
const originalTypes = await typesFile.async('string')
let types = originalTypes.replace(
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
)
assert.notEqual(types, originalTypes)
types = types.replace(
  '</Types>',
  '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
)
assert(types.includes('application/vnd.ms-office.vbaProject'))
zip.file('[Content_Types].xml', types)
const originalRelationships = await relationshipsFile.async('string')
const relationships = originalRelationships.replace(
  '</Relationships>',
  '<Relationship Id="rIdVbaProject" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
)
assert.notEqual(relationships, originalRelationships)
zip.file('xl/_rels/workbook.xml.rels', relationships)
const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => (index * 37 + 11) % 256))
zip.file('xl/vbaProject.bin', payload)
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
await writeFile(join(directory, 'sample.xlsm'), bytes)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      file: 'sample.xlsm',
      source,
      sha256: sha256(bytes),
      vbaSha256: sha256(payload),
      bytes: bytes.length,
    },
    null,
    2,
  ) + '\n',
)
