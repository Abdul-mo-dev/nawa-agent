/** Strict source decoding for edits: never save lossy replacement characters over the original. */
export function decodeSource(bytes: Uint8Array): { text: string; encode(text: string): Buffer } {
  const input = Buffer.from(bytes)
  if (
    (input[0] === 0xff && input[1] === 0xfe && input[2] === 0 && input[3] === 0) ||
    (input[0] === 0 && input[1] === 0 && input[2] === 0xfe && input[3] === 0xff)
  )
    throw new Error('UTF-32 source editing is unsupported. Save a UTF-8 or UTF-16 copy first.')
  const little = input[0] === 0xff && input[1] === 0xfe
  const big = input[0] === 0xfe && input[1] === 0xff
  const bom = input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf
  const encoding = little ? 'utf-16le' : big ? 'utf-16be' : 'utf-8'
  const body = input.subarray(little || big ? 2 : bom ? 3 : 0)
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body)
  if (text.includes('\0')) throw new Error('Source contains binary NUL characters.')
  return {
    text,
    encode(value) {
      if (little || big) {
        const result = Buffer.from(value, 'utf16le')
        if (big) result.swap16()
        return Buffer.concat([Buffer.from(big ? [0xfe, 0xff] : [0xff, 0xfe]), result])
      }
      return Buffer.concat([
        bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
        Buffer.from(value, 'utf8'),
      ])
    },
  }
}
