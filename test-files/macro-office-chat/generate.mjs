import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'

const directory = import.meta.dirname
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const files = []
for (const extension of ['docm', 'dotm', 'pptm', 'ppsm', 'potm']) {
  const docs = extension.endsWith('docm') || extension === 'dotm'
  const source = join(
    directory,
    docs ? '../docm-chat/sample.docm' : '../modern-office-chat/sample.potx',
  )
  const zip = await JSZip.loadAsync(await readFile(source))
  const typesFile = zip.file('[Content_Types].xml')
  assert(typesFile)
  const mainPart = docs ? 'word/document.xml' : 'ppt/presentation.xml'
  const mainType = docs
    ? `application/vnd.ms-word.${extension === 'docm' ? 'document' : 'template'}.macroEnabled.main+xml`
    : `application/vnd.ms-powerpoint.${extension === 'pptm' ? 'presentation' : extension === 'ppsm' ? 'slideshow' : 'template'}.macroEnabled.main+xml`
  let types = (await typesFile.async('string')).replace(
    new RegExp(`(<Override[^>]*PartName="/${mainPart}"[^>]*ContentType=")[^"]+`),
    `$1${mainType}`,
  )
  const vbaPart = docs ? 'word/vbaProject.bin' : 'ppt/vbaProject.bin'
  if (!docs) {
    types = types.replace(
      '</Types>',
      `<Override PartName="/${vbaPart}" ContentType="application/vnd.ms-office.vbaProject"/></Types>`,
    )
    const rels = 'ppt/_rels/presentation.xml.rels'
    zip.file(
      rels,
      (await zip.file(rels).async('string')).replace(
        '</Relationships>',
        '<Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
      ),
    )
    zip.file(vbaPart, Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 31 + 11) % 256)))
  }
  zip.file('[Content_Types].xml', types)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const file = `sample.${extension}`
  await writeFile(join(directory, file), bytes)
  files.push({
    extension,
    target: docs ? 'docx' : 'pptx',
    file,
    sha256: sha256(bytes),
    vbaPart,
    vbaSha256: sha256(await zip.file(vbaPart).async('nodebuffer')),
    mainType,
    bytes: bytes.length,
  })
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n')
