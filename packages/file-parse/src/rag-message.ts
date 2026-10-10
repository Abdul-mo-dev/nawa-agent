import PostalMime from 'postal-mime'
import { extname } from 'node:path'
import { htmlBlocks, markdownBlocks } from './rag-text'
import type { RagBlock, RagDocument } from './rag-types'

const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const textExtensions = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.xml',
])
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])

export async function emlDocument(
  bytes: Uint8Array,
  title: string,
  recognize?: (image: Uint8Array) => Promise<string | null>,
): Promise<RagDocument> {
  const email = await PostalMime.parse(bytes, {
    maxNestingDepth: 32,
    maxHeadersSize: 1024 * 1024,
    maxRfc822NestingDepth: 4,
  })
  const blocks: RagBlock[] = []
  const warnings: string[] = []
  const header = (name: string) => email.headers.find((item) => item.key === name)?.value ?? ''
  const metadata = [
    ['Subject', email.subject],
    ['From', header('from')],
    ['To', header('to')],
    ['Cc', header('cc')],
    ['Date', email.date],
    ['Message ID', email.messageId],
  ]
    .filter((item) => item[1])
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
  if (metadata)
    blocks.push({
      kind: 'record',
      text: metadata,
      headings: ['Message headers'],
      locator: 'message headers',
    })
  const body = email.text?.trim() ?? ''
  if (body) {
    blocks.push(
      ...markdownBlocks(body).map((block) => ({
        ...block,
        locator: `message text body, ${block.locator}`,
      })),
    )
  } else if (email.html?.trim()) {
    blocks.push(
      ...htmlBlocks(email.html).map((block) => ({
        ...block,
        locator: `message HTML body, ${block.locator}`,
      })),
    )
    warnings.push('Message has no plain-text body; HTML was converted to searchable text.')
  }
  if (email.attachments.length > MAX_ATTACHMENTS)
    warnings.push(
      `Only the first ${MAX_ATTACHMENTS} of ${email.attachments.length} attachments were checked.`,
    )
  for (const [index, attachment] of email.attachments.slice(0, MAX_ATTACHMENTS).entries()) {
    const name = attachment.filename || `attachment ${index + 1}`
    const extension = extname(name).toLowerCase()
    const content = attachment.content
    const data =
      typeof content === 'string'
        ? Buffer.from(content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
        : new Uint8Array(content)
    if (data.length > MAX_ATTACHMENT_BYTES) {
      warnings.push(`${name}: attachment exceeds the 16 MiB extraction limit.`)
      continue
    }
    if (textExtensions.has(extension) || attachment.mimeType === 'text/plain') {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
        blocks.push(
          ...markdownBlocks(text).map((block) => ({
            ...block,
            locator: `message attachment ${index + 1} (${name}), ${block.locator}`,
          })),
        )
      } catch {
        warnings.push(`${name}: text attachment is not UTF-8 and was not embedded.`)
      }
    } else if (
      (imageExtensions.has(extension) || attachment.mimeType.startsWith('image/')) &&
      recognize
    ) {
      try {
        const text = (await recognize(data))?.trim()
        if (text) {
          blocks.push({
            kind: 'notes',
            text,
            headings: ['Image attachment'],
            locator: `message image attachment ${index + 1} (${name}), OCR`,
          })
          warnings.push(
            `${name}: image text was recognized by OCR; verify wording and visual context against the attachment.`,
          )
        } else {
          warnings.push(`${name}: local OCR recovered no readable text from this image attachment.`)
        }
      } catch (error) {
        warnings.push(
          `${name}: image OCR failed (${error instanceof Error ? error.message : String(error)}).`,
        )
      }
    } else {
      warnings.push(`${name}: attachment content is not available in the native message index.`)
    }
  }
  if (!blocks.length)
    throw new Error('Email has no readable headers, body, or supported attachments.')
  return {
    title,
    format: 'eml',
    blocks,
    warnings,
    partial: !!warnings.length,
  }
}
