import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as CFB from 'cfb'
import sharp from 'sharp'

const directory = import.meta.dirname
await mkdir(directory, { recursive: true })
const files = {
  'sample.mjs': '\uFEFF// 日本語 / العربية\r\nexport const value = 1;\r\n',
  'sample.cjs': '// Nawa source fixture\nmodule.exports = { value: 1 };\n',
  'sample.json': '{\n  "title": "日本語 / العربية",\n  "value": 1\n}\n',
  'sample.rtf':
    '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0 Nawa RTF Import\\par \\b Bold text\\b0  and \\u26085?\\u26412?\\u35486?\\par}',
  'sample.eml':
    'From: sender@example.com\r\nTo: reader@example.com\r\nSubject: Nawa project review\r\nDate: Fri, 16 Oct 2026 09:00:00 +0900\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease review the project by Friday.\r\n日本語 / العربية\r\n',
}
for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value)
const archive = CFB.utils.cfb_new()
CFB.utils.cfb_add(archive, '__properties_version1.0', Buffer.alloc(32))
for (const [id, value] of Object.entries({
  '0037': 'Nawa project review',
  1000: 'Please review the project by Friday.\r\n日本語 / العربية',
  '0C1F': 'sender@example.com',
}))
  CFB.utils.cfb_add(archive, `__substg1.0_${id}001F`, Buffer.from(value + '\0', 'utf16le'))
await writeFile(join(directory, 'sample.msg'), CFB.write(archive, { type: 'buffer' }))
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="white"/><text x="40" y="110" font-family="Arial" font-size="60" fill="black">NAWA OCR TEST</text></svg>',
)
await sharp(svg).png().toFile(join(directory, 'sample.png'))
await sharp(svg).tiff().toFile(join(directory, 'sample.tiff'))
