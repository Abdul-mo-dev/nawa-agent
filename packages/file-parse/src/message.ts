import PostalMime from 'postal-mime'
import * as CFB from 'cfb'
import { htmlBlocks, markdownBlocks } from './rag-text'
import { decodeXml } from './rag-xml'
import type { RagDocument } from './rag-types'

export interface SavedMessage {
  subject: string
  headers: { name: string; value: string }[]
  body: string
  attachments: { name: string; bytes: number; mime?: string }[]
  warnings: string[]
}
const MAX_BYTES = 64 * 1024 * 1024
const htmlText = (html: string) =>
  htmlBlocks(html)
    .map((block) => decodeXml(block.text))
    .join('\n\n')

/** Saved messages are inert text: no remote images, scripts, attachment execution or network fetches. */
export async function readMessage(bytes: Uint8Array, format: 'eml' | 'msg'): Promise<SavedMessage> {
  if (bytes.length > MAX_BYTES) throw new Error('Email preview accepts files up to 64 MiB.')
  let message: SavedMessage
  if (format === 'eml') {
    const email = await PostalMime.parse(bytes, {
      maxNestingDepth: 32,
      maxHeadersSize: 1024 * 1024,
      maxRfc822NestingDepth: 4,
    })
    const headers = ['from', 'to', 'cc', 'date', 'message-id'].flatMap((name) => {
      const value = email.headers.find((header) => header.key === name)?.value
      return value ? [{ name, value }] : []
    })
    message = {
      subject: email.subject ?? '',
      headers,
      body: email.text || htmlText(email.html || ''),
      attachments: email.attachments.slice(0, 100).map((attachment, i) => ({
        name: attachment.filename || `attachment ${i + 1}`,
        mime: attachment.mimeType,
        bytes:
          typeof attachment.content === 'string'
            ? Buffer.byteLength(
                attachment.content,
                attachment.encoding === 'base64' ? 'base64' : 'utf8',
              )
            : attachment.content.byteLength,
      })),
      warnings:
        email.attachments.length > 100 ? ['Attachment list is limited to 100 entries.'] : [],
    }
  } else {
    const input = Buffer.from(bytes)
    if (!input.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
      throw new Error('MSG content is not a valid Compound File message.')
    const archive = CFB.read(input, { type: 'buffer' })
    if (archive.FileIndex.length > 10000) throw new Error('MSG has too many streams.')
    const root = archive.FullPaths[0] ?? ''
    const streams = new Map(
      archive.FullPaths.map((path, i) => [
        path.slice(root.length).toLowerCase(),
        Buffer.from(archive.FileIndex[i]!.content ?? []),
      ]),
    )
    if (!streams.has('__properties_version1.0'))
      throw new Error('Compound file does not contain MSG properties.')
    const warnings: string[] = []
    const properties = streams.get('__properties_version1.0')!
    let charset = 'windows-1252'
    for (let offset = 32; offset + 16 <= properties.length; offset += 16) {
      const tag = properties.readUInt32LE(offset)
      if (tag === 0x3ffd0003 || tag === 0x3fde0003) {
        const cp = properties.readUInt32LE(offset + 8)
        charset =
          (
            { 65001: 'utf-8', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' } as Record<
              number,
              string
            >
          )[cp] ?? `windows-${cp}`
      }
    }
    const value = (id: string, prefix = '') => {
      const key = `${prefix}__substg1.0_${id}`.toLowerCase()
      const unicode = streams.get(key + '001f')
      if (unicode)
        return new TextDecoder('utf-16le', { fatal: true }).decode(unicode).replace(/\0+$/, '')
      const ansi = streams.get(key + '001e')
      if (!ansi) return ''
      try {
        return new TextDecoder(charset, { fatal: true }).decode(ansi).replace(/\0+$/, '')
      } catch {
        throw new Error(
          `Cannot decode MSG text using ${charset}. Export a Unicode MSG or EML copy.`,
        )
      }
    }
    const groups = (kind: string) => [
      ...new Set(
        [...streams.keys()].flatMap((path) => {
          const match = new RegExp(`^(__${kind}_version1\\.0_#[0-9a-f]{8}/)`).exec(path)
          return match ? [match[1]!] : []
        }),
      ),
    ]
    const from = [value('0c1a'), value('5d01') || value('0c1f')].filter(Boolean).join(' ')
    const recipients = groups('recip')
      .slice(0, 100)
      .map((prefix) =>
        [value('3001', prefix), value('39fe', prefix) || value('3003', prefix)]
          .filter(Boolean)
          .join(' '),
      )
    const headers = [
      ...(from ? [{ name: 'from', value: from }] : []),
      ...(recipients.length ? [{ name: 'recipients', value: recipients.join('; ') }] : []),
      ...(value('007d')
        ? [{ name: 'transport headers', value: value('007d').slice(0, 16000) }]
        : []),
    ]
    let body = value('1000')
    if (!body) {
      const html = streams.get('__substg1.0_10130102')
      if (html) {
        try {
          body = htmlText(new TextDecoder(charset, { fatal: true }).decode(html))
        } catch {
          warnings.push('The HTML message body could not be decoded.')
        }
      }
    }
    if (!body)
      warnings.push(
        'No plain-text or readable HTML body. Compressed RTF and encrypted message bodies are not extracted.',
      )
    const attachments = groups('attach')
      .slice(0, 100)
      .map((prefix, i) => ({
        name: value('3707', prefix) || value('3704', prefix) || `attachment ${i + 1}`,
        bytes: streams.get(prefix + '__substg1.0_37010102')?.length ?? 0,
        mime: value('370e', prefix) || undefined,
      }))
    if (attachments.length)
      warnings.push(
        'MSG attachments are listed; their contents and embedded messages are not extracted.',
      )
    message = { subject: value('0037'), headers, body, attachments, warnings }
  }
  if (message.body.length > 2_000_000) {
    message.body = message.body.slice(0, 2_000_000)
    message.warnings.push('Message body is limited to 2,000,000 characters.')
  }
  return message
}

export async function messageDocument(
  bytes: Uint8Array,
  title: string,
  format: 'eml' | 'msg',
): Promise<RagDocument> {
  const message = await readMessage(bytes, format)
  const metadata = [
    `Subject: ${message.subject}`,
    ...message.headers.map((header) => `${header.name}: ${header.value}`),
  ].join('\n')
  return {
    title,
    format,
    partial: !!message.warnings.length,
    warnings: message.warnings,
    blocks: [
      { kind: 'record', text: metadata, headings: ['Message headers'], locator: 'message headers' },
      ...markdownBlocks(message.body).map((block) => ({
        ...block,
        locator: `message body, ${block.locator}`,
      })),
      ...message.attachments.map((attachment, i) => ({
        kind: 'record' as const,
        text: `Attachment: ${attachment.name} (${attachment.bytes} bytes)`,
        headings: ['Attachments'],
        locator: `attachment ${i + 1} metadata`,
      })),
    ],
  }
}
