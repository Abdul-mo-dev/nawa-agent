import { expect, it, vi } from 'vitest'
import { parseFileToRag } from '../src/index'
import { TINY_PNG_BASE64, writeFixture } from './helpers/fixtures'

it('indexes MIME text and OCR from image attachments with message locators', async () => {
  const message = [
    'From: Analyst <analyst@example.com>',
    'To: Team <team@example.com>',
    'Subject: Quarterly review',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="nawa-test"',
    '',
    '--nawa-test',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Revenue note for the quarter.',
    '--nawa-test',
    'Content-Type: image/png; name="chart.png"',
    'Content-Disposition: attachment; filename="chart.png"',
    'Content-Transfer-Encoding: base64',
    '',
    TINY_PNG_BASE64,
    '--nawa-test--',
    '',
  ].join('\r\n')
  const recognize = vi.fn(async () => 'Chart label 12345')
  const result = await parseFileToRag(writeFixture('review.eml', message), {
    image: recognize,
  })
  expect(result.blocks.map((block) => block.text).join('\n')).toContain(
    'Revenue note for the quarter.',
  )
  expect(result.blocks.map((block) => block.text).join('\n')).toContain('Chart label 12345')
  expect(result.blocks.some((block) => block.locator.includes('chart.png'))).toBe(true)
  expect(recognize).toHaveBeenCalledOnce()
})

it('marks unsupported binary attachments instead of implying their content was embedded', async () => {
  const message = [
    'Subject: Files',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="nawa-test"',
    '',
    '--nawa-test',
    'Content-Type: text/plain',
    '',
    'See attached file.',
    '--nawa-test',
    'Content-Type: application/pdf; name="scan.pdf"',
    'Content-Disposition: attachment; filename="scan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQ=',
    '--nawa-test--',
    '',
  ].join('\r\n')
  const result = await parseFileToRag(writeFixture('attachments.eml', message))
  expect(result.partial).toBe(true)
  expect(result.warnings.join(' ')).toContain('scan.pdf')
  expect(result.blocks.map((block) => block.text).join('\n')).toContain('See attached file.')
})
