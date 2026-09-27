import { createReadStream } from 'node:fs'
export interface RawCell { value: string | null; kind?: 'text' | 'number' | 'boolean' | 'date'; formula?: string; error?: string }
export interface RawRow { row: number; cells: Record<number, RawCell>; hidden?: boolean; firstLine?: number; lastLine?: number }
export interface SourceTable {
  key: string; name: string; sheet: string; range: string; kind: string;
  firstColumn: number; lastColumn: number; headerRow: number; firstRow: number; lastRow: number | null;
  headers?: string[]; warnings: string[]
}
export type ReadEvent = { kind: 'table'; table: SourceTable } | { kind: 'row'; table: string; row: RawRow }
export interface ReadLimits { maxColumns: number; maxRows: number; maxBytes: number; check(): void }
export async function* utf8(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const chunk of chunks) { const text = decoder.decode(chunk, { stream: true }); if (text) yield text }
  const tail = decoder.decode(); if (tail) yield tail
}
export async function* fileText(path: string): AsyncGenerator<string> { yield* utf8(createReadStream(path, { highWaterMark: 65536 })) }
/** Streaming RFC4180 records. Quoted newlines are not mistaken for record boundaries. */
export async function* delimited(chunks: AsyncIterable<string>, separator: string, limits: ReadLimits): AsyncGenerator<RawRow> {
  let fields: string[] = [], field = '', quoted = false, afterQuote = false, atStart = true, skipLF = false
  let row = 0, line = 1, firstLine = 1, bytes = 0, any = false
  const push = () => { fields.push(field); field = ''; atStart = true; if (fields.length > limits.maxColumns) throw new Error('Table exceeds the configured column limit.') }
  const record = (): RawRow => {
    push(); if (++row > limits.maxRows + 1) throw new Error('Row limit reached. No partial table was published.')
    const out = { row, cells: Object.fromEntries(fields.map((value,i) => [i+1, { value, kind: 'text' as const }])), firstLine, lastLine: line }
    fields = []; bytes = 0; any = false; firstLine = line + 1; return out
  }
  for await (const chunk of chunks) {
    limits.check()
    for (const ch of chunk) {
      if (skipLF) { skipLF = false; if (ch === '\n') continue }
      any = true
      if (++bytes > 4 * 1024 * 1024) throw new Error('A delimited record exceeds 4 MiB.')
      if (quoted) {
        if (ch === '"') { quoted = false; afterQuote = true }
        else { field += ch; if (ch === '\n') line++ }
        continue
      }
      if (afterQuote) {
        if (ch === '"') { field += '"'; quoted = true; afterQuote = false; continue }
        if (ch !== separator && ch !== '\r' && ch !== '\n') throw new Error(`Unexpected character after closing quote at line ${line}.`)
        afterQuote = false
      } else if (ch === '"') {
        if (!atStart) throw new Error(`Unexpected quote in unquoted field at line ${line}.`)
        quoted = true; atStart = false; continue
      }
      if (ch === separator) { push(); continue }
      if (ch === '\r' || ch === '\n') { yield record(); line++; if (ch === '\r') skipLF = true; continue }
      field += ch; atStart = false
    }
  }
  if (quoted) throw new Error('Unclosed quoted field; the file was not imported.')
  if (any || fields.length || field) yield record()
}
/** Lossless JSON values: retain numeric lexemes and nested JSON rather than coercing to Number. */
export function jsonRecord(source: string): Record<string, RawCell> {
  let at = 0, nodes = 0
  const ws = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++ }
  const string = (): string => {
    const start = at++; let escaped = false
    while (at < source.length) { const c = source[at++]!; if (!escaped && c === '"') return JSON.parse(source.slice(start, at)) as string; if (!escaped && c === '\\') escaped = true; else escaped = false }
    throw new Error('Unclosed JSON string.')
  }
  const value = (depth: number): RawCell => {
    if (++nodes > 100000 || depth > 64) throw new Error('JSON record is too complex.')
    ws(); const start = at, c = source[at]
    if (c === '"') return { value: string(), kind: 'text' }
    if (c === '{' || c === '[') {
      const end = c === '{' ? '}' : ']'; at++; ws()
      const keys = new Set<string>()
      if (source[at] !== end) for (;;) {
        if (c === '{') { if (source[at] !== '"') throw new Error('JSON key expected.'); const key = string(); if (keys.has(key)) throw new Error('Duplicate JSON key.'); keys.add(key); ws(); if (source[at++] !== ':') throw new Error('JSON colon expected.') }
        value(depth + 1); ws(); if (source[at] === end) break
        if (source[at++] !== ',') throw new Error('JSON comma expected.'); ws()
      }
      at++; return { value: source.slice(start,at), kind: 'text' }
    }
    for (const literal of ['true','false','null']) if (source.startsWith(literal,at)) { at += literal.length; return { value: literal === 'null' ? null : literal, kind: literal === 'null' ? 'text' : 'boolean' } }
    const n = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0]
    if (!n) throw new Error('Invalid JSON value.')
    at += n.length; return { value: n, kind: 'number' }
  }
  ws(); if (source[at++] !== '{') throw new Error('Every table JSON record must be an object.')
  const out: Record<string, RawCell> = Object.create(null); ws()
  if (source[at] !== '}') for (;;) {
    if (source[at] !== '"') throw new Error('JSON key expected.')
    const key = string(); if (Object.hasOwn(out,key)) throw new Error('Duplicate JSON field.')
    ws(); if (source[at++] !== ':') throw new Error('JSON colon expected.')
    out[key] = value(1); ws(); if (source[at] === '}') break
    if (source[at++] !== ',') throw new Error('JSON comma expected.'); ws()
  }
  at++; ws(); if (at !== source.length) throw new Error('Trailing JSON content.')
  return out
}
export async function* jsonLines(chunks: AsyncIterable<string>, limits: ReadLimits): AsyncGenerator<{ text: string; row: number }> {
  let buffer = '', row = 0
  for await (const chunk of chunks) {
    limits.check(); buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,end).replace(/\r$/, ''); buffer = buffer.slice(end+1); row++; if (row > limits.maxRows) throw new Error('JSONL row limit reached.'); if (line.trim()) yield { text: line, row } }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('JSONL record exceeds 4 MiB.')
  }
  if (buffer.trim()) { if (++row > limits.maxRows) throw new Error('JSONL row limit reached.'); yield { text: buffer, row } }
}
export async function* jsonArray(chunks: AsyncIterable<string>, limits: ReadLimits): AsyncGenerator<{ text: string; row: number }> {
  let state: 'start' | 'value' | 'after' | 'done' = 'start', depth = 0, quote = false, escape = false, record = '', row = 0, afterComma = false
  for await (const chunk of chunks) {
    limits.check()
    for (const c of chunk) {
      if (depth) {
        record += c
        if (record.length > 4 * 1024 * 1024) throw new Error('JSON record exceeds 4 MiB.')
        if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quote = false }
        else if (c === '"') quote = true
        else if (c === '{' || c === '[') depth++
        else if (c === '}' || c === ']') { if (--depth === 0) { if (++row > limits.maxRows) throw new Error('JSON row limit reached.'); yield { text: record, row }; record = ''; state = 'after' } }
        continue
      }
      if (/\s/.test(c)) continue
      if (state === 'start' && c === '[') { state = 'value'; continue }
      if (state === 'value' && c === '{') { record = c; depth = 1; afterComma = false; continue }
      if ((state === 'value' && !afterComma || state === 'after') && c === ']') { state = 'done'; continue }
      if (state === 'after' && c === ',') { state = 'value'; afterComma = true; continue }
      throw new Error('Expected a JSON array of objects, without trailing commas or extra content.')
    }
  }
  if (state !== 'done' || depth) throw new Error('Incomplete JSON array.')
}
/** Stream XML tokens and return bounded complete elements. Reject DTDs and malformed nesting. */
export async function* xmlFragments(chunks: AsyncIterable<Uint8Array>, target: string, limits: ReadLimits): AsyncGenerator<string> {
  let buffer = '', capture = '', captureDepth = -1, roots = 0
  const stack: string[] = []
  for await (const chunk of utf8(chunks)) {
    limits.check(); buffer += chunk
    while (buffer.length) {
      let end = -1
      if (buffer[0] !== '<') { end = buffer.indexOf('<'); if (end < 0) { if (captureDepth >= 0) capture += buffer; else if (!stack.length && buffer.trim()) throw new Error('Text outside XML root.'); buffer = ''; break } }
      else if (buffer.startsWith('<!--')) { const i = buffer.indexOf('-->'); if (i >= 0) end = i+3 }
      else if (buffer.startsWith('<![CDATA[')) { const i = buffer.indexOf(']]>'); if (i >= 0) end = i+3 }
      else if (buffer.startsWith('<?')) { const i = buffer.indexOf('?>'); if (i >= 0) end = i+2 }
      else {
        let quote = ''
        for (let i=1;i<buffer.length;i++) { const c = buffer[i]!; if (quote) { if(c === quote) quote = '' } else if(c === '"' || c === "'") quote=c; else if(c === '>') { end=i+1; break } }
      }
      if (end < 0) break
      const token = buffer.slice(0,end); buffer = buffer.slice(end)
      if (token.startsWith('<!') && !token.startsWith('<!--') && !token.startsWith('<![CDATA[')) throw new Error('XML DTD/entity declarations are forbidden.')
      const close = /^<\/([^\s>]+)\s*>$/.exec(token)
      const open = /^<([^!?/\s>]+)(?:\s[\s\S]*?)?\s*\/?>$/.exec(token)
      if (close) {
        if (stack.pop() !== close[1]) throw new Error('Mismatched XML closing element.')
      } else if (open) {
        if (!stack.length && ++roots > 1) throw new Error('Multiple XML root elements.')
        if (open[1]!.split(':').pop() === target && captureDepth < 0) { captureDepth = stack.length; capture = '' }
        if (!/\/\s*>$/.test(token)) stack.push(open[1]!)
        if (stack.length > 128) throw new Error('XML nesting limit reached.')
      } else if (token.startsWith('<') && !token.startsWith('<!--') && !token.startsWith('<?') && !token.startsWith('<![CDATA[')) throw new Error('Malformed XML element.')
      if (captureDepth >= 0) {
        capture += token
        if (capture.length > 4 * 1024 * 1024) throw new Error(`An XML ${target} element exceeds 4 MiB.`)
        if (stack.length === captureDepth) { yield capture; capture = ''; captureDepth = -1 }
      }
    }
    if (buffer.length > 4 * 1024 * 1024 || capture.length > 4 * 1024 * 1024) throw new Error('XML element limit reached.')
  }
  if (buffer.trim() || stack.length || captureDepth >= 0 || roots !== 1) throw new Error('Incomplete XML document.')
}
