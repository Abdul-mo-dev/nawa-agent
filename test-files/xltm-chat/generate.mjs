import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const source = resolve(directory, '../xlsm-chat/sample.xlsm')
const zip = await JSZip.loadAsync(await readFile(source))
const entry = zip.file('[Content_Types].xml')
assert(entry)
const before = await entry.async('string')
const after = before.replace(
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
)
assert.notEqual(after, before)
zip.file('[Content_Types].xml', after)
const vba = await zip.file('xl/vbaProject.bin')?.async('nodebuffer')
assert(vba)
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(join(directory, 'sample.xltm'), bytes)
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      file: 'sample.xltm',
      source: 'test-files/xlsm-chat/sample.xlsm',
      sha256: sha256(bytes),
      vbaSha256: sha256(vba),
      bytes: bytes.length,
    },
    null,
    2,
  ) + '\n',
)
