import { readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const zip = new JSZip()
zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' })
zip.file(
  'content.xml',
  (await readFile(new URL('./ods-content.xml', import.meta.url), 'utf8')).replace(/>\s+</g, '><'),
)
zip.file(
  'META-INF/manifest.xml',
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
)
await writeFile(
  new URL('./basic.ods', import.meta.url),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
)
