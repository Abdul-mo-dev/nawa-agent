import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const source = resolve(directory, '../modern-office-chat/sample.dotx')
const zip = await JSZip.loadAsync(await readFile(source))
const typesFile = zip.file('[Content_Types].xml')
assert(typesFile)
const originalTypes = await typesFile.async('string')
let types = originalTypes.replace(
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-word.document.macroEnabled.main+xml',
)
assert.notEqual(types, originalTypes)
types = types.replace(
  '</Types>',
  '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
)
zip.file('[Content_Types].xml', types)
const relsPath = 'word/_rels/document.xml.rels'
const relsFile = zip.file(relsPath)
const originalRels = relsFile
  ? await relsFile.async('string')
  : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
const rels = originalRels.replace(
  '</Relationships>',
  '<Relationship Id="rIdVbaProject" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
)
assert.notEqual(rels, originalRels)
zip.file(relsPath, rels)
const vba = Buffer.from(Array.from({ length: 256 }, (_, index) => (index * 29 + 17) % 256))
zip.file('word/vbaProject.bin', vba)
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(join(directory, 'sample.docm'), bytes)
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      file: 'sample.docm',
      source: 'test-files/modern-office-chat/sample.dotx',
      sha256: sha256(bytes),
      vbaSha256: sha256(vba),
      bytes: bytes.length,
    },
    null,
    2,
  ) + '\n',
)
