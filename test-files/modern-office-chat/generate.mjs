import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const sources = [
  {
    extension: 'dotx',
    target: 'docx',
    source: 'test-files/legacy-office/source/document-sample.docx',
    mainType: 'wordprocessingml.document.main+xml',
    copyType: 'wordprocessingml.template.main+xml',
  },
  {
    extension: 'xltx',
    target: 'xlsx',
    source: 'test-files/spreadsheet-chat/source/binary.xlsx',
    mainType: 'spreadsheetml.sheet.main+xml',
    copyType: 'spreadsheetml.template.main+xml',
  },
  ...['ppsx', 'potx'].map((extension) => ({
    extension,
    target: 'pptx',
    source: 'test-files/legacy-office/source/presentation-sample.pptx',
    mainType: 'presentationml.presentation.main+xml',
    copyType: `presentationml.${extension === 'ppsx' ? 'slideshow' : 'template'}.main+xml`,
  })),
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const files = []
for (const sample of sources) {
  const input = await readFile(join(workspace, sample.source))
  const zip = await JSZip.loadAsync(input)
  const types = zip.file('[Content_Types].xml')
  assert(types, sample.source)
  const original = await types.async('string')
  const changed = original.replace(sample.mainType, sample.copyType)
  assert.notEqual(changed, original, sample.source)
  zip.file('[Content_Types].xml', changed)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const file = `sample.${sample.extension}`
  await writeFile(join(directory, file), bytes)
  files.push({
    extension: sample.extension,
    target: sample.target,
    file,
    source: sample.source,
    sha256: hash(bytes),
    bytes: bytes.length,
  })
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n')
