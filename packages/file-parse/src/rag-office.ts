import JSZip from 'jszip'
import { posix } from 'node:path'
import { readXml, children, descendants, attr, innerText, local, officeText, type XmlNode } from './rag-xml'
import type { RagBlock, RagDocument } from './rag-types'
import { builtinDateFormat, classifyFormatCode, formatSerial, type DateFormatParts } from './xlsx-dates'

async function openZip(bytes: Uint8Array): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes), entries = Object.values(zip.files)
  if (entries.length > 20000) throw new Error('Office archive exceeds 20,000 entries.')
  let expanded = 0
  for (const file of entries) {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    expanded += size
    if (size > 32 * 1024 * 1024 || expanded > 256 * 1024 * 1024) throw new Error('Office archive exceeds the expanded-data safety limit.')
  }
  return zip
}
async function xml(zip: JSZip, name: string): Promise<XmlNode | null> {
  const item = zip.file(name)
  if (!item) return null
  return readXml(await item.async('string'))
}
function target(base: string, value: string): string {
  const result = posix.normalize(value.startsWith('/') ? value.slice(1) : posix.join(posix.dirname(base), value))
  if (result.startsWith('../') || /^(?:[a-z]+:|\\)/i.test(result)) throw new Error('Invalid Office relationship target.')
  return result
}
async function relationships(zip: JSZip, name: string): Promise<Map<string, { path: string; type: string }>> {
  const root = await xml(zip, posix.join(posix.dirname(name), '_rels', `${posix.basename(name)}.rels`)), out = new Map<string, { path: string; type: string }>()
  if (root) for (const rel of descendants(root, 'Relationship')) {
    if (attr(rel, 'TargetMode').toLowerCase() === 'external') continue
    out.set(attr(rel, 'Id'), { path: target(name, attr(rel, 'Target')), type: attr(rel, 'Type') })
  }
  return out
}
function tableBlocks(node: XmlNode, locator: string, headings: string[], extra: Partial<RagBlock> = {}): RagBlock[] {
  const rows = children(node, 'tr').map(row => children(row, 'tc').map(cell => descendants(cell, 'p').map(officeText).filter(Boolean).join('\n')))
  const first = rows[0] ?? []
  return rows.map((row, i) => ({
    kind: 'row', headings: [...headings], locator: `${locator}, row ${i + 1}`, ...extra,
    rowStart: i + 1, rowEnd: i + 1,
    text: row.map((text, col) => `Column ${col + 1}${i && first[col] ? ` [first-row label: ${first[col]}]` : ''}: ${text}`).join('\n'),
  }))
}
export async function docxDocument(bytes: Uint8Array, title: string): Promise<RagDocument> {
  const zip = await openZip(bytes), doc = await xml(zip, 'word/document.xml')
  if (!doc) throw new Error('Missing Word document part.')
  const styles = await xml(zip, 'word/styles.xml'), levels = new Map<string, number>()
  if (styles) for (const style of descendants(styles, 'style')) {
    const name = attr(descendants(style, 'name')[0], 'val'), outline = attr(descendants(style, 'outlineLvl')[0], 'val')
    const named = /heading\s*(\d)/i.exec(name)
    if (outline !== '' && Number(outline) < 9) levels.set(attr(style, 'styleId'), Number(outline) + 1)
    else if (named) levels.set(attr(style, 'styleId'), Number(named[1]))
  }
  const blocks: RagBlock[] = [], headings: string[] = [], warnings: string[] = []
  const body = descendants(doc, 'body')[0]
  let paragraph = 0, table = 0
  if (body) for (const node of children(body)) {
    if (local(node.name) === 'p') {
      paragraph++; const text = officeText(node)
      const style = attr(descendants(node, 'pStyle')[0], 'val'), direct = attr(descendants(node, 'outlineLvl')[0], 'val')
      const level = direct !== '' && Number(direct) < 9 ? Number(direct) + 1 : levels.get(style)
      if (level && text) { headings.length = level - 1; headings[level - 1] = text }
      if (text) blocks.push({ kind: 'paragraph', text, headings: headings.filter(Boolean), locator: `paragraph ${paragraph}` })
    } else if (local(node.name) === 'tbl') blocks.push(...tableBlocks(node, `table ${++table}`, headings.filter(Boolean)))
    else if (local(node.name) === 'sdt') {
      for (const p of descendants(node, 'p')) { const text = officeText(p); if (text) blocks.push({ kind: 'paragraph', text, headings: headings.filter(Boolean), locator: `content control, paragraph ${++paragraph}` }) }
    }
  }
  for (const name of Object.keys(zip.files).filter(n => /^word\/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(n)).sort()) {
    const root = await xml(zip, name)
    if (root) for (const [i, node] of descendants(root, 'p').entries()) { const text = officeText(node); if (text) blocks.push({ kind: 'notes', text, headings: [posix.basename(name, '.xml')], locator: `${posix.basename(name)}, paragraph ${i + 1}` }) }
  }
  if (descendants(doc, 'drawing').length || descendants(doc, 'pict').length) warnings.push('Embedded graphics are not OCRed. Native inspection is required for visual content.')
  if (descendants(doc, 'altChunk').length) warnings.push('Embedded altChunk content is not parsed.')
  warnings.push('Word references use paragraphs/tables, not layout-dependent page numbers. Field values are saved text, not recalculated.')
  return { title, format: 'docx', blocks, warnings, partial: descendants(doc, 'drawing').length > 0 || descendants(doc, 'pict').length > 0 || descendants(doc, 'altChunk').length > 0 }
}
const columnName = (index: number): string => { let s = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s }
function colIndex(ref: string): number { let n = 0; for (const c of (/^[A-Za-z]+/.exec(ref)?.[0] ?? '').toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64; return n - 1 }
export async function xlsxDocument(bytes: Uint8Array, title: string): Promise<RagDocument> {
  const zip = await openZip(bytes), workbook = await xml(zip, 'xl/workbook.xml')
  if (!workbook) throw new Error('Missing Excel workbook part.')
  const rels = await relationships(zip, 'xl/workbook.xml'), sharedXml = await xml(zip, 'xl/sharedStrings.xml')
  const shared = sharedXml ? descendants(sharedXml, 'si').map(n => descendants(n, 't').map(innerText).join('')) : []
  const styleXml = await xml(zip, 'xl/styles.xml'), dates = new Map<number, DateFormatParts>(), custom = new Map<number, DateFormatParts | null>()
  if (styleXml) {
    for (const numFmt of descendants(styleXml, 'numFmt')) custom.set(Number(attr(numFmt, 'numFmtId')), classifyFormatCode(attr(numFmt, 'formatCode')))
    const xfs = descendants(styleXml, 'cellXfs')[0]
    if (xfs) children(xfs, 'xf').forEach((xf, i) => { const id = Number(attr(xf, 'numFmtId')), parts = custom.has(id) ? custom.get(id) : builtinDateFormat(id); if (parts) dates.set(i, parts) })
  }
  const date1904 = ['1', 'true'].includes(attr(descendants(workbook, 'workbookPr')[0], 'date1904'))
  const blocks: RagBlock[] = [], warnings: string[] = ['Spreadsheet values and formula results are saved/cached values. Embedding does not recalculate formulas. Use native workbook tools for exact aggregation or recalculation.']
  let partial = false
  for (const sheet of descendants(workbook, 'sheet')) {
    const name = attr(sheet, 'name'), part = rels.get(attr(sheet, 'id'))?.path
    if (!part) { partial = true; warnings.push(`Unresolved sheet: ${name}`); continue }
    const root = await xml(zip, part)
    if (!root) { partial = true; warnings.push(`Missing worksheet: ${name}`); continue }
    const data = descendants(root, 'sheetData')[0]
    if (!data) { partial = true; warnings.push(`${name}: no worksheet cell data (possibly a chart sheet).`); continue }
    const rows = children(data, 'row'), firstLabels = new Map<number, string>(), stats = new Map<number, { n: number; sum: number; min: number; max: number }>()
    const sheetRels = await relationships(zip, part), tables: Array<{ name: string; ref: string; start: number; end: number; col: number; labels: string[]; header: number }> = []
    for (const rel of sheetRels.values()) if (rel.type.endsWith('/table')) {
      const table = await xml(zip, rel.path), node = table && descendants(table, 'table')[0]
      if (node) { const ref = attr(node, 'ref'), range = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(ref); if (range) tables.push({ name: attr(node, 'displayName') || attr(node, 'name'), ref, start: Number(range[2]), end: Number(range[4]), col: colIndex(range[1]!), labels: descendants(node, 'tableColumn').map(n => attr(n, 'name')), header: attr(node, 'headerRowCount') === '0' ? 0 : 1 }) }
    }
    let actualRows = 0, cellCount = 0, formulaCount = 0
    const values = (cell: XmlNode): { value: string; numeric?: number; formula: string } => {
      const type = attr(cell, 't'), raw = children(cell, 'v')[0], stored = raw ? innerText(raw) : '', f = children(cell, 'f')[0]
      let value = stored
      const parts = dates.get(Number(attr(cell, 's')))
      if (type === 's') value = stored.trim() && Number.isInteger(Number(stored)) ? shared[Number(stored)] ?? '' : ''
      else if (type === 'inlineStr') value = descendants(cell, 't').map(innerText).join('')
      else if (type === 'b') value = stored === '1' ? 'TRUE' : 'FALSE'
      else if ((!type || type === 'n') && parts && stored.trim()) value = formatSerial(Number(stored), parts, date1904) ?? stored
      const numeric = (!type || type === 'n') && !parts && stored.trim() && Number.isFinite(Number(stored)) ? Number(stored) : undefined
      const formula = f ? innerText(f) || `[shared/array formula reference ${attr(f, 'si') || attr(f, 'ref')}; expression not repeated in this cell]` : ''
      return { value, ...(typeof numeric === 'number' ? { numeric } : {}), formula }
    }
    for (const [index, row] of rows.entries()) {
      const rowNumber = Number(attr(row, 'r')) || index + 1, cells = children(row, 'c')
      const parsed = cells.map((cell, i) => ({ ref: attr(cell, 'r') || `${columnName(i)}${rowNumber}`, col: Math.max(0, colIndex(attr(cell, 'r') || columnName(i))), ...values(cell) }))
      if (!parsed.some(c => c.value || c.formula)) continue
      actualRows++
      if (actualRows === 1) for (const cell of parsed) firstLabels.set(cell.col, cell.value)
      const lines: string[] = []
      for (const cell of parsed) {
        if (!cell.value && !cell.formula) continue
        cellCount++; if (cell.formula) formulaCount++
        const table = tables.find(t => rowNumber >= t.start && rowNumber <= t.end && cell.col >= t.col && cell.col < t.col + t.labels.length)
        const label = table ? `column: ${table.labels[cell.col - table.col]}` : actualRows > 1 ? `possible first-row label: ${firstLabels.get(cell.col) ?? ''}` : ''
        lines.push(`${cell.ref}${label ? ` [${label}]` : ''}: ${cell.formula ? `=${cell.formula}; cached value: ` : ''}${cell.value || (cell.formula ? '[no cached result]' : '')}`)
        if (cell.numeric !== undefined) {
          const s = stats.get(cell.col) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity }
          s.n++; s.sum += cell.numeric; s.min = Math.min(s.min, cell.numeric); s.max = Math.max(s.max, cell.numeric); stats.set(cell.col, s)
        }
      }
      const inTables = tables.filter(t => rowNumber >= t.start && rowNumber <= t.end).map(t => t.name)
      blocks.push({ text: lines.join('\n'), kind: 'row', headings: [name, ...inTables], sheet: name, rowStart: rowNumber, rowEnd: rowNumber, locator: `sheet "${name}", row ${rowNumber}` })
    }
    const merges = descendants(root, 'mergeCell').map(n => attr(n, 'ref'))
    const numeric = [...stats].map(([col, s]) => `${columnName(col)}: stored numeric-cell count=${s.n}, sum=${s.sum}, min=${s.min}, max=${s.max}`)
    blocks.push({ kind: 'outline', sheet: name, headings: [name], locator: `sheet "${name}" overview`, text: [
      `Sheet: ${name}; visibility: ${attr(sheet, 'state') || 'visible'}. Nonempty rows=${actualRows}; nonempty cells=${cellCount}; formula cells=${formulaCount}.`,
      ...tables.map(t => `Excel table ${t.name} (${t.ref}), headers=${JSON.stringify(t.labels)}, header row count=${t.header}.`),
      ...(merges.length ? [`Merged ranges: ${merges.join(', ')}`] : []),
      'Mechanical numeric profiles across ALL stored numeric cells (may include totals, IDs and mixed units; NOT business totals):', ...numeric,
    ].join('\n') })
    if (descendants(root, 'drawing').length || descendants(root, 'legacyDrawing').length) { partial = true; warnings.push(`${name}: charts/images/drawings are not visually interpreted.`) }
  }
  if (!blocks.some(block => block.kind !== 'outline' && block.text.trim())) throw new Error('Workbook has no extractable cell content. Embedded images require OCR; no file-content vectors were created.')
  return { title, format: 'xlsx', blocks, warnings, partial }
}
export async function pptxDocument(bytes: Uint8Array, title: string): Promise<RagDocument> {
  const zip = await openZip(bytes), presentation = await xml(zip, 'ppt/presentation.xml')
  if (!presentation) throw new Error('Missing PowerPoint presentation part.')
  const rels = await relationships(zip, 'ppt/presentation.xml'), blocks: RagBlock[] = [], warnings: string[] = []
  let partial = false, number = 0
  for (const id of descendants(presentation, 'sldId')) {
    const slide = ++number, part = rels.get(attr(id, 'r:id'))?.path
    if (!part) { partial = true; warnings.push(`Slide ${slide}: unresolved relationship.`); continue }
    const root = await xml(zip, part)
    if (!root) { partial = true; warnings.push(`Slide ${slide}: missing part.`); continue }
    const titleShape = descendants(root, 'sp').find(n => descendants(n, 'ph').some(p => ['title', 'ctrTitle'].includes(attr(p, 'type'))))
    const heading = titleShape ? officeText(titleShape) : `Slide ${slide}`
    for (const [i, shape] of descendants(root, 'sp').entries()) {
      const text = descendants(shape, 'p').map(officeText).filter(Boolean).join('\n')
      if (text) blocks.push({ kind: 'paragraph', text, headings: [heading], slide, locator: `slide ${slide}, text shape ${i + 1}` })
    }
    for (const [i, table] of descendants(root, 'tbl').entries()) blocks.push(...tableBlocks(table, `slide ${slide}, table ${i + 1}`, [heading], { slide }))
    const links = await relationships(zip, part)
    for (const rel of links.values()) if (rel.type.endsWith('/notesSlide')) {
      const notes = await xml(zip, rel.path)
      if (notes) for (const shape of descendants(notes, 'sp')) {
        if (descendants(shape, 'ph').some(ph => ['sldNum', 'sldImg', 'hdr', 'ftr', 'dt'].includes(attr(ph, 'type')))) continue
        const text = descendants(shape, 'p').map(officeText).filter(Boolean).join('\n')
        if (text) blocks.push({ text, kind: 'notes', headings: [heading, 'Speaker notes'], slide, locator: `slide ${slide}, speaker notes` })
      }
    }
    for (const image of descendants(root, 'pic')) {
      const description = attr(descendants(image, 'cNvPr')[0], 'descr')
      if (description) blocks.push({ text: `Author-supplied image alternative text (not OCR): ${description}`, kind: 'notes', headings: [heading], slide, locator: `slide ${slide}, image alternative text` })
    }
    if (descendants(root, 'pic').length || descendants(root, 'chart').length || descendants(root, 'graphicData').some(n => /diagram/.test(attr(n, 'uri')))) { partial = true; warnings.push(`Slide ${slide}: visual graphics/chart data require native inspection; no OCR was performed.`) }
  }
  return { title, format: 'pptx', blocks, warnings, partial }
}
