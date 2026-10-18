import { describe, expect, it } from 'vitest'
import * as CFB from 'cfb'
import { messageDocument, readMessage } from '../src/message'
import { decodeSource } from '../src/source-text'

function msg(entries: Record<string, string | Buffer>) {
  const archive = CFB.utils.cfb_new()
  CFB.utils.cfb_add(archive, '__properties_version1.0', Buffer.alloc(32))
  for (const [path, value] of Object.entries(entries))
    CFB.utils.cfb_add(
      archive,
      path,
      typeof value === 'string' ? Buffer.from(value + '\0', 'utf16le') : value,
    )
  return Buffer.from(CFB.write(archive, { type: 'buffer' }))
}
describe('saved message preview', () => {
  it('decodes multilingual EML, lists attachments and keeps HTML inert', async () => {
    const raw = Buffer.from(
      'From: sender@example.com\r\nTo: reader@example.com\r\nSubject: Planning\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=part\r\n\r\n--part\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>مرحبا 日本語 &amp; English</p><img src="https://example.com/tracker"><script>throw 1</script>\r\n--part\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nAttachment text\r\n--part--\r\n',
    )
    const result = await readMessage(raw, 'eml')
    expect(result.body).toContain('مرحبا 日本語 & English')
    expect(result.body).not.toMatch(/<img|<script|throw 1|tracker/)
    expect(result.attachments).toMatchObject([{ name: 'notes.txt' }])
    expect(result.headers).toContainEqual({ name: 'from', value: 'sender@example.com' })
  })
  it('reads real MSG streams and does not substitute an embedded message body', async () => {
    const bytes = msg({
      '__substg1.0_0037001F': 'Project 日本語',
      '__substg1.0_1000001F': 'مرحبا — review on Friday',
      '__substg1.0_0C1F001F': 'sender@example.com',
      '__recip_version1.0_#00000000/__substg1.0_3003001F': 'reader@example.com',
      '__attach_version1.0_#00000000/__substg1.0_3707001F': 'report.txt',
      '__attach_version1.0_#00000000/__substg1.0_37010102': Buffer.from('attachment'),
      '__attach_version1.0_#00000001/__substg1.0_3701000D/__substg1.0_1000001F':
        'Not the outer body',
    })
    const result = await readMessage(bytes, 'msg')
    expect(result.subject).toBe('Project 日本語')
    expect(result.body).toBe('مرحبا — review on Friday')
    expect(result.headers).toContainEqual({ name: 'recipients', value: 'reader@example.com' })
    expect(result.attachments[0]).toMatchObject({ name: 'report.txt', bytes: 10 })
    const document = await messageDocument(bytes, 'project.msg', 'msg')
    expect(document.blocks.some((block) => block.locator.startsWith('message body'))).toBe(true)
    expect(document.warnings.join(' ')).toContain('not extracted')
  })
  it('reports unsupported MSG bodies and rejects unrelated compound files', async () => {
    const result = await readMessage(
      msg({ '__substg1.0_10090102': Buffer.from('compressed') }),
      'msg',
    )
    expect(result.body).toBe('')
    expect(result.warnings.join(' ')).toContain('Compressed RTF')
    await expect(readMessage(Buffer.from('fake'), 'msg')).rejects.toThrow('Compound File')
    const archive = CFB.utils.cfb_new()
    await expect(
      readMessage(Buffer.from(CFB.write(archive, { type: 'buffer' })), 'msg'),
    ).rejects.toThrow('MSG properties')
  })
})
describe('source byte preservation', () => {
  it.each(['utf8', 'utf16le', 'utf16be'])('retains %s BOM and CRLF', (encoding) => {
    const text = 'مرحبا 日本語\r\nconst value = 1;\r\n'
    const content = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le')
    if (encoding === 'utf16be') content.swap16()
    const bom =
      encoding === 'utf8'
        ? [0xef, 0xbb, 0xbf]
        : encoding === 'utf16le'
          ? [0xff, 0xfe]
          : [0xfe, 0xff]
    const original = Buffer.concat([Buffer.from(bom), content])
    const source = decodeSource(original)
    expect(source.text).toBe(text)
    expect(source.encode(source.text)).toEqual(original)
  })
  it('rejects malformed UTF-8 and binary inputs instead of saving lossy text', () => {
    expect(() => decodeSource(Buffer.from([0xff]))).toThrow()
    expect(() => decodeSource(Buffer.from('binary\0data'))).toThrow('binary')
    expect(() => decodeSource(Buffer.from([0xff, 0xfe, 0, 0]))).toThrow('UTF-32')
  })
})
