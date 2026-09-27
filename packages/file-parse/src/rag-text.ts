import type { RagBlock } from './rag-types'
import { readXml, children, innerText, decodeXml, type XmlNode } from './rag-xml'
const clean = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
/** Markdown sections retain their breadcrumb; fences and table rows are not mixed with prose. */
export function markdownBlocks(input: string): RagBlock[] {
  const lines = clean(input).split('\n'), blocks: RagBlock[] = [], headings: string[] = []
  let buffer: string[] = [], start = 1, fence = '', kind: RagBlock['kind'] = 'paragraph', tableHeader = ''
  const flush = (end: number) => {
    if (buffer.some(s => s.trim())) blocks.push({ text: buffer.join('\n'), kind, locator: `lines ${start}–${end}`, headings: [...headings], lineStart: start, lineEnd: end, ...(tableHeader ? { context: tableHeader } : {}) })
    buffer = []; tableHeader = ''; kind = 'paragraph'
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, n = i + 1, marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      buffer.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) { fence = ''; flush(n) }
      continue
    }
    if (marker) { flush(i); start = n; kind = 'code'; fence = marker; buffer.push(line); continue }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) { flush(i); headings.length = h[1]!.length - 1; headings[h[1]!.length - 1] = h[2]!; start = n; buffer.push(line); continue }
    const table = line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)
    if (table) {
      flush(i); const header = `${line}\n${lines[i + 1]}`; i++
      let row = 0
      while (i + 1 < lines.length && lines[i + 1]!.includes('|') && lines[i + 1]!.trim()) {
        const data = lines[++i]!; row++
        blocks.push({ text: `${header}\n${data}`, kind: 'row', locator: `Markdown table, line ${i + 1}, row ${row}`, headings: [...headings], lineStart: i + 1, lineEnd: i + 1 })
      }
      if (!row) blocks.push({ text: header, kind: 'table', locator: `table at line ${n}`, headings: [...headings], lineStart: n, lineEnd: n + 1 })
      continue
    }
    if (!line.trim()) { flush(i); start = n + 1; continue }
    if (!buffer.length) start = n
    buffer.push(line)
  }
  flush(lines.length)
  return blocks
}
/** RFC-style CSV/TSV reader: quoted newlines and escaped quotes stay in their record. */
export function delimitedRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  const text = clean(input).replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ }
      else if (!cell || quoted) quoted = !quoted
      else cell += c
    } else if (!quoted && (c === delimiter || c === '\n')) {
      row.push(cell); cell = ''
      if (c === '\n') { rows.push(row); row = [] }
    } else cell += c
    if (cell.length > 4 * 1024 * 1024 || row.length > 16384 || rows.length > 1000000) throw new Error('Delimited file exceeds structural safety limits.')
  }
  if (quoted) throw new Error('Unclosed quoted field in delimited file.')
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
export function delimitedBlocks(input: string, delimiter: string): RagBlock[] {
  const rows = delimitedRows(input, delimiter), first = rows[0] ?? []
  if (!rows.some(row => row.some(cell => cell.trim()))) return []
  const labels = first.map((value, i) => value.trim() || `Column ${i + 1}`)
  const blocks: RagBlock[] = [{ kind: 'outline', headings: [], locator: 'table overview', text: `Records: ${rows.length}. Columns: ${Math.max(0, ...rows.slice(0, 1000).map(r => r.length))}.\nFirst record (possible headers; not guaranteed): ${JSON.stringify(first)}` }]
  rows.forEach((row, i) => { if (row.some(value => value.trim())) blocks.push({
    kind: 'row', headings: ['Delimited records'], locator: `record ${i + 1}`, rowStart: i + 1, rowEnd: i + 1,
    text: row.map((value, col) => `Column ${col + 1}${i ? ` [first-record label: ${labels[col] ?? ''}]` : ''}: ${value}`).join('\n'),
  }) })
  return blocks
}
export function jsonBlocks(input: string): RagBlock[] {
  const value: unknown = JSON.parse(input), blocks: RagBlock[] = []
  const visit = (v: unknown, pointer: string, depth: number) => {
    if (depth > 48) throw new Error('JSON nesting exceeds 48 levels.')
    const text = JSON.stringify(v, null, 2)
    if (text.length < 3000 || !v || typeof v !== 'object') { blocks.push({ text, kind: 'record', headings: [], locator: `JSON pointer ${pointer || '/'}` }); return }
    for (const [key, child] of Object.entries(v)) visit(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1)
  }
  visit(value, '', 0); return blocks
}
export function codeBlocks(input: string): RagBlock[] {
  const lines = clean(input).split('\n'), blocks: RagBlock[] = []
  let start = 0, symbol = 'Source', part: string[] = []
  const flush = () => { if (part.some(s => s.trim())) blocks.push({ kind: 'code', headings: [symbol], locator: `lines ${start + 1}–${start + part.length}`, lineStart: start + 1, lineEnd: start + part.length, text: part.join('\n') }); part = [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, declaration = /^\s*(?:(?:export|public|private|protected|static|async|pub|abstract)\s+)*(?:class|interface|function|def|fn|struct|enum|namespace)\s+([\w$]+)/.exec(line)
    if (declaration || part.length >= 80) { flush(); start = i; if (declaration) symbol = declaration[1]! }
    part.push(line)
  }
  flush(); return blocks
}
export function htmlBlocks(input: string): RagBlock[] {
  // Script/style content is never embedded; images are not fetched.
  const text = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_all, body: string) => {
      const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(row => [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map(cell => decodeXml(cell[1]!.replace(/<[^>]*>/g, ' ').replace(/\|/g, '／').replace(/\s+/g, ' ').trim())))
      if (!rows.length) return '\n\n'
      return '\n\n| ' + rows[0]!.join(' | ') + ' |\n| ' + rows[0]!.map(() => '---').join(' | ') + ' |\n' + rows.slice(1).map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n'
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${body.replace(/<[^>]*>/g, '')}\n\n`)
    .replace(/<\/(?:p|div|section|article|ul|ol|table|pre)\s*>/gi, '\n\n').replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<tr\b[^>]*>/gi, '\n').replace(/<\/(?:td|th)\s*>/gi, ' | ').replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ')
  // Imported lazily by dispatcher so this module remains a small pure chunking helper.
  return markdownBlocks(text)
}

/** XML records retain element paths and attributes, without resolving external resources. */
export function xmlBlocks(input: string): RagBlock[] {
  const root = readXml(input), blocks: RagBlock[] = []
  const describe = (node: XmlNode, depth = 0): string => {
    const pad = '  '.repeat(depth)
    const attributes = Object.entries(node.attrs).filter(([name]) => !name.startsWith('xmlns')).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(' ')
    const direct = node.children.filter((v): v is string => typeof v === 'string').join('').trim()
    return `${pad}${node.name}${attributes ? ` [${attributes}]` : ''}${direct ? `: ${direct}` : ''}\n` + children(node).map(child => describe(child, depth + 1)).join('')
  }
  const visit = (node: XmlNode, locator: string, headings: string[]) => {
    const nested = children(node)
    if (!nested.length || (innerText(node).length < 2000 && nested.length < 12)) {
      blocks.push({ kind: 'record', text: describe(node), locator: `XML path ${locator}`, headings }); return
    }
    const own = node.children.filter((v): v is string => typeof v === 'string').join('').trim()
    const attrs = Object.entries(node.attrs).filter(([name]) => !name.startsWith('xmlns'))
    if (own || attrs.length) blocks.push({ kind: 'record', text: `${node.name} attributes: ${JSON.stringify(Object.fromEntries(attrs))}\n${own}`, locator: `XML path ${locator}`, headings })
    const counts = new Map<string, number>()
    for (const child of nested) { const index = (counts.get(child.name) ?? 0) + 1; counts.set(child.name, index); visit(child, `${locator}/${child.name}[${index}]`, [...headings, node.name]) }
  }
  for (const node of children(root)) visit(node, `/${node.name}`, [])
  return blocks
}
