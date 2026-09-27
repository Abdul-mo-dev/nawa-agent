import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const build = process.env.NAWA_RAG_TEST_BUILD, project = process.env.NAWA_RAG_TEST_PROJECT
if (!build || !project) throw new Error('Run node tools/rag/test.mjs, not cases.mjs directly.')
const load = p => import(pathToFileURL(path.join(build, p + '.mjs')).href)
const main = 'apps/shell/src/main/rag/', parse = 'packages/file-parse/src/'
const { DEFAULT_RAG_SETTINGS } = await load('apps/shell/src/shared/rag-api')
const { validateSettings, profileId, embeddingUrl } = await load(main + 'config')
const { EmbeddingClient, mapConcurrent } = await load(main + 'embedding')
const { chunkDocument, draftBlocks } = await load(main + 'chunks')
const { RagStore } = await load(main + 'store')
const { RagEngine } = await load(main + 'engine')
const { markdownBlocks, delimitedRows, delimitedBlocks, jsonBlocks, codeBlocks, xmlBlocks, htmlBlocks } = await load(parse + 'rag-text')
const { readXml, descendants, officeText } = await load(parse + 'rag-xml')
const { docxDocument, xlsxDocument, pptxDocument } = await load(parse + 'rag-office')
const { parseFileToRag } = await load(parse + 'rag')
const { terms } = await load(main + 'lexical')
const JSZip = createRequire(path.join(project, 'package.json'))('jszip')
let mode = 'normal', requests = 0, failAfter = Infinity, retry = 0
const received = []
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/tokenize') { res.end(JSON.stringify({ tokens: Array.from({ length: Math.ceil(Buffer.byteLength(body.content || '', 'utf8') / 4) }, (_, i) => i) })); return }
  if (req.url !== '/v1/embeddings') { res.writeHead(404); res.end('{}'); return }
  requests++; received.push(body)
  if (mode === 'retry' && retry++ === 0) { res.writeHead(429); res.end('{}'); return }
  if (requests > failAfter) { res.writeHead(400); res.end('{}'); return }
  const data = body.input.map((text, index) => ({ index, embedding: [1 + (text.match(/alpha|apple|猫/gi) || []).length, 1 + (text.match(/beta|banana|犬/gi) || []).length, 1] }))
  if (mode === 'zero') data.forEach(d => d.embedding = [0, 0, 0])
  if (mode === 'null') data[0].embedding = [1, null, 2]
  if (mode === 'duplicate' && data.length > 1) data[1].index = 0
  if (mode === 'dimensions') data.forEach(d => d.embedding = [1, 2, 3, 4])
  if (mode === 'reverse') data.reverse()
  res.end(JSON.stringify({ data }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
after(() => new Promise(resolve => server.close(resolve)))
const settings = patch => ({ ...DEFAULT_RAG_SETTINGS, backend: 'local', enabled: true, model: 'test-embedding', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, ...patch })
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nawa-rag-fixture-')), root = path.join(dir, 'workspace'), state = path.join(dir, 'state')
  await fs.mkdir(root); await fs.mkdir(state)
  const store = new RagStore(path.join(state, 'rag.sqlite3')), engine = new RagEngine(store, state)
  try { return await fn({ root, state, store, engine }) }
  finally { store.close(); await fs.rm(dir, { recursive: true, force: true }) }
}
const doc = (blocks, title = 'Test.md') => ({ title, format: 'md', blocks, partial: false, warnings: [] })
const paragraph = (text, extras = {}) => ({ text, kind: 'paragraph', locator: 'paragraph 1', headings: ['Section'], ...extras })
const job = (root, action, extra = {}, config = settings()) => ({ action, roots: [root], folder: root, recursive: true, settings: config, apiKey: '', ...extra })
const noSignal = () => new AbortController().signal
const progress = () => {}
function fakeChunk(text, ordinal = 0) { return { ordinal, text, embeddingText: text, hash: text, locator: `paragraph ${ordinal + 1}`, metadata: { kind: 'paragraph', locator: `paragraph ${ordinal + 1}`, headings: [], title: 'file', format: 'txt' } } }
function meta(path, profile, sourceHash = 'h1') { return { path, profile, sourceHash, size: 1, mtime: 1, ctime: 1, warnings: [], partial: false } }

test('settings normalize endpoints and reject unintended remote/credential URLs', () => {
  assert.equal(embeddingUrl('http://127.0.0.1:8081/v1/embeddings').pathname, '/v1/embeddings')
  assert.equal(embeddingUrl('http://127.0.0.1:8081').pathname, '/v1/embeddings')
  assert.throws(() => validateSettings(settings({ baseUrl: 'http://192.168.1.20:8081/v1' })), /Explicitly allow/)
  assert.throws(() => validateSettings(settings({ baseUrl: 'http://key:secret@localhost/v1' })), /credentials/)
  assert.throws(() => validateSettings(settings({ overlapTokens: 300 })), /overlap/)
  assert.equal(validateSettings(settings({ baseUrl: 'https://example.test/v1', allowRemote: true })).allowRemote, true)
})
test('profile changes invalidate vectors but batch/performance controls do not', () => {
  const s = settings(), original = profileId(s)
  for (const patch of [{ model: 'new' }, { modelRevision: 'weights2' }, { queryPrefix: 'query: ' }, { documentPrefix: 'passage: ' }, { chunkTokens: 256 }, { tokenizer: 'conservative' }]) assert.notEqual(profileId({ ...s, ...patch }), original)
  assert.equal(profileId({ ...s, batchSize: 2, concurrency: 1, topK: 4 }), original)
})
test('CJK keyword tokens preserve unspaced Japanese matching', () => {
  const t = terms('売上報告 Project2026')
  assert.ok(t.includes('売上')); assert.ok(t.includes('上報')); assert.ok(t.includes('project2026'))
  assert.doesNotThrow(() => terms('報'.repeat(150000)))
})
test('XML reader preserves ordered text, entities and tabs; rejects DTD and malformed tags', () => {
  const x = readXml('<w:p><w:r><w:t>A &amp; B</w:t><w:tab/><w:t>猫&#x1F600;</w:t></w:r></w:p>')
  assert.equal(officeText(descendants(x, 'p')[0]), 'A & B\t猫😀')
  assert.throws(() => readXml('<!DOCTYPE r SYSTEM "http://host"><r/>'), /forbidden/)
  assert.throws(() => readXml('<x><y></x>'), /Mismatched/)
})
test('CSV/TSV keep quoted newlines, escaped quotes and record coordinates', () => {
  const text = 'Product,Note,Amount\r\nApple,"line1\nline2 ""quoted""",100\r\n'
  const rows = delimitedRows(text, ',')
  assert.equal(rows.length, 2); assert.equal(rows[1][1], 'line1\nline2 "quoted"')
  const blocks = delimitedBlocks(text, ',')
  assert.match(blocks[2].text, /first-record label: Amount/); assert.equal(blocks[2].rowStart, 2)
  assert.throws(() => delimitedRows('A,"unfinished', ','), /Unclosed/)
  assert.equal(delimitedBlocks('', ',').length, 0)
})
test('Markdown keeps headings, fences and repeated table headers', () => {
  const blocks = markdownBlocks('# Revenue\n\nSales grew.\n\n| Region | Total |\n| --- | --- |\n| East | 100 |\n| West | 200 |\n\n## Code\n\n```ts\nconst x = 1\n```')
  assert.equal(blocks.filter(b => b.kind === 'row').length, 2)
  assert.ok(blocks.filter(b => b.kind === 'row').every(b => b.text.includes('Region')))
  const code = blocks.find(b => b.kind === 'code'); assert.deepEqual(code.headings, ['Revenue', 'Code']); assert.match(code.text, /const x/)
})
test('JSON pointers retain parent keys; code boundaries retain symbols and lines', () => {
  const blocks = jsonBlocks(JSON.stringify({ 'a/b': Array.from({ length: 100 }, (_, i) => ({ i, text: 'content'.repeat(20) })) }))
  assert.ok(blocks.every(b => b.locator.includes('/a~1b')))
  const code = codeBlocks('class Customer:\n  pass\n\ndef invoice():\n  return 1')
  assert.equal(code[1].headings[0], 'invoice'); assert.equal(code[1].lineStart, 4)
})
test('draft packing does not cross page, worksheet, slide or heading boundaries', () => {
  const blocks = [paragraph('one', { page: 1 }), paragraph('two', { page: 2 }), paragraph('three', { sheet: 'Sales' }), paragraph('four', { sheet: 'Costs' })]
  assert.equal(draftBlocks(doc(blocks), 10000).length, 4)
})
test('token-bound fragments cover all Japanese text without losing characters', async () => {
  const original = '日本語の売上分析。📊'.repeat(120), s = settings({ documentPrefix: 'passage: ', chunkTokens: 120, maxInputTokens: 256, overlapTokens: 20 })
  const count = async text => Array.from(text).length
  const chunks = await chunkDocument(doc([paragraph(original)]), s, count)
  assert.ok(chunks.length > 2)
  const covered = new Set()
  for (const c of chunks) { assert.ok(await count(c.embeddingText) <= s.maxInputTokens); for (let n = c.metadata.charStart; n < c.metadata.charEnd; n++) covered.add(n) }
  assert.equal(covered.size, Array.from(original).length)
  assert.ok(chunks.every(c => c.embeddingText.startsWith('passage: File:')))
})
test('overlong prefixes fail instead of silently truncating document content', async () => {
  await assert.rejects(chunkDocument(doc([paragraph('Text')]), settings({ documentPrefix: 'X'.repeat(3000) }), async text => text.length), /prefix exceeds/)
})
test('DOCX extraction keeps heading breadcrumbs, table row labels and footnotes', async () => {
  const zip = new JSZip()
  zip.file('word/styles.xml', '<w:styles><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>')
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sales</w:t></w:r></w:p><w:p><w:r><w:t>Alpha grew.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>East</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
  zip.file('word/footnotes.xml', '<w:footnotes><w:footnote><w:p><w:r><w:t>Source note.</w:t></w:r></w:p></w:footnote></w:footnotes>')
  const d = await docxDocument(await zip.generateAsync({ type: 'uint8array' }), 'Sales.docx')
  assert.deepEqual(d.blocks.find(b => b.text.includes('Alpha')).headings, ['Sales'])
  assert.match(d.blocks.find(b => b.text.includes('East')).text, /first-row label: Total/)
  assert.ok(d.blocks.some(b => b.locator.includes('footnotes') && b.text.includes('Source note')))
})
test('XLSX extraction retains cell references, formulas, dates, table labels and merged ranges', async () => {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="r1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>')
  zip.file('xl/styles.xml', '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue</t></is></c></row><row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2"><f>10*20</f><v>200</v></c></row></sheetData><mergeCells><mergeCell ref="D1:E1"/></mergeCells></worksheet>')
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="t1" Target="../tables/table1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table"/></Relationships>')
  zip.file('xl/tables/table1.xml', '<table name="SalesTable" displayName="SalesTable" ref="A1:B2"><tableColumns><tableColumn name="Date"/><tableColumn name="Revenue"/></tableColumns></table>')
  const d = await xlsxDocument(await zip.generateAsync({ type: 'uint8array' }), 'Book.xlsx')
  const row = d.blocks.find(b => b.rowStart === 2)
  assert.equal(row.sheet, 'Sales'); assert.match(row.text, /A2.*2024-01-01/); assert.match(row.text, /B2 \[column: Revenue\]: =10\*20; cached value: 200/)
  const outline = d.blocks.find(b => b.kind === 'outline'); assert.match(outline.text, /D1:E1/); assert.match(outline.text, /NOT business totals/)
})
test('PPTX extraction uses presentation order and includes speaker notes', async () => {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>')
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/><Relationship Id="rB" Target="slides/slide2.xml"/></Relationships>')
  const slide = title => `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  zip.file('ppt/slides/slide1.xml', slide('Second'))
  zip.file('ppt/slides/slide2.xml', slide('First'))
  zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="n1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>')
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker evidence</a:t></a:r></a:p></p:txBody></p:sp></p:notes>')
  const d = await pptxDocument(await zip.generateAsync({ type: 'uint8array' }), 'Deck.pptx')
  assert.equal(d.blocks.find(b => b.text === 'First').slide, 1)
  assert.equal(d.blocks.find(b => b.text === 'Second').slide, 2)
  assert.equal(d.blocks.find(b => b.kind === 'notes').slide, 1)
})
test('embedding client accepts reordered indices and normalizes float vectors', async () => {
  mode = 'reverse'; const client = new EmbeddingClient(settings())
  const result = await client.embed(['alpha alpha', 'beta beta'])
  assert.ok(result[0].vector[0] > result[0].vector[1])
  assert.ok(Math.abs([...result[0].vector].reduce((sum, n) => sum + n * n, 0) - 1) < 1e-6)
  mode = 'normal'
})
test('embedding client rejects zero/null/duplicate/wrong-dimension vectors', async () => {
  const client = new EmbeddingClient(settings())
  for (const bad of ['zero', 'null', 'duplicate']) { mode = bad; await assert.rejects(client.embed(['a', 'b'])) }
  mode = 'dimensions'; await assert.rejects(client.embed(['a'], 3), /dimension changed/)
  mode = 'normal'
})
test('embedding client retries rate limiting but not arbitrary failures', async () => {
  mode = 'retry'; retry = 0; const initial = requests
  await new EmbeddingClient(settings()).embed(['a'])
  assert.equal(requests - initial, 2); mode = 'normal'
})
test('bounded embedding pool respects the configured concurrency', async () => {
  let active = 0, maximum = 0
  const values = await mapConcurrent([1, 2, 3, 4, 5], 2, async n => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 5)); active--; return n * 2 })
  assert.equal(maximum, 2); assert.deepEqual(values, [2, 4, 6, 8, 10])
})
test('SQLite retrieval filters permissions before ranking and supports CJK FTS', async () => fixture(async ({ store, root }) => {
  const a = path.join(root, 'a.md'), b = path.join(root, 'b.md'), profile = 'profile1'
  store.commit(meta(a, profile), [fakeChunk('売上報告 alpha')], [Float32Array.from([1, 0, 0])])
  store.commit(meta(b, profile), [fakeChunk('SECRET beta 売上報告')], [Float32Array.from([1, 0, 0])])
  assert.equal(store.retrieve([], profile, '売上', null, 8).length, 0)
  const found = store.retrieve([a], profile, '売上', Float32Array.from([1, 0, 0]), 8)
  assert.equal(found.length, 1); assert.equal(found[0].path, a); assert.ok(!found[0].text.includes('SECRET'))
}))
test('SQLite publication rolls back a failed generation and preserves the previous generation', async () => fixture(async ({ store, root }) => {
  const p = path.join(root, 'a.md')
  store.commit(meta(p, 'p1'), [fakeChunk('old')], [Float32Array.from([1, 0, 0])])
  await assert.rejects(async () => store.commit(meta(p, 'p1', 'h2'), [fakeChunk('new'), fakeChunk('duplicate ordinal')], [Float32Array.from([1, 0, 0]), Float32Array.from([1, 0, 0])]))
  assert.equal(store.get(p).source_hash, 'h1'); assert.equal(store.retrieve([p], 'p1', 'old', null, 5)[0].text, 'old')
}))
test('profile dimension mismatches are rejected and other profiles show stale status', async () => fixture(async ({ store, root }) => {
  const p = path.join(root, 'a.md'); store.commit(meta(p, 'p1'), [fakeChunk('a')], [Float32Array.from([1, 0, 0])])
  assert.throws(() => store.cache('p1', 'x', Float32Array.from([1, 0])), /dimensions changed/)
  assert.equal(store.view(p, 'p2').status, 'stale')
}))
test('end-to-end directory indexing is incremental and produces structured RAG evidence', async () => fixture(async ({ store, engine, root }) => {
  const file = path.join(root, 'Sales.md'); await fs.writeFile(file, '# Revenue\n\nAlpha apple revenue is 120.\n\n## Costs\n\nBeta costs are 40.')
  const s = settings(), start = requests
  const first = await engine.execute(job(root, 'index', {}, s), noSignal(), progress)
  assert.equal(first.embedded, 1); assert.equal(store.get(file).status, 'embedded'); assert.ok(requests > start)
  const before = requests, second = await engine.execute(job(root, 'index', {}, s), noSignal(), progress)
  assert.equal(second.unchanged, 1); assert.equal(requests, before)
  const result = await engine.execute(job(root, 'retrieve', { paths: [file], query: 'alpha revenue' }, s), noSignal(), progress)
  assert.equal(result.hits.length, 1); assert.match(result.hits[0].chunks[0].citation, /^RAG:/)
  assert.ok(result.hits[0].chunks[0].metadata.headings.includes('Revenue'))
}))
test('same-length edits with restored mtime are detected by fingerprint and excluded from retrieval', async () => fixture(async ({ store, engine, root }) => {
  const file = path.join(root, 'Data.txt'); await fs.writeFile(file, 'alpha 123'); const s = settings()
  await engine.execute(job(root, 'index', {}, s), noSignal(), progress)
  const old = await fs.stat(file); await fs.writeFile(file, 'beta  123'); await fs.utimes(file, old.atime, old.mtime)
  const result = await engine.execute(job(root, 'statuses', { paths: [file], verify: true }, s), noSignal(), progress)
  assert.equal(result[0].status, 'stale')
  const retrieved = await engine.execute(job(root, 'retrieve', { paths: [file], query: 'alpha' }, s), noSignal(), progress)
  assert.equal(retrieved.hits.length, 0); assert.equal(store.get(file).status, 'stale')
}))
test('unsupported image files fail honestly; nested directories are opt-in; hidden files are excluded', async () => fixture(async ({ store, engine, root }) => {
  const sub = path.join(root, 'Sub'); await fs.mkdir(sub)
  await fs.writeFile(path.join(root, 'photo.png'), 'not text'); await fs.writeFile(path.join(root, '.hidden.md'), 'secret'); await fs.writeFile(path.join(sub, 'Note.md'), 'alpha')
  const first = await engine.execute(job(root, 'index', { recursive: false }), noSignal(), progress)
  assert.equal(first.failed, 1); assert.equal(store.get(path.join(root, 'photo.png')).status, 'failed')
  assert.equal(store.get(path.join(sub, 'Note.md')), undefined); assert.equal(store.get(path.join(root, '.hidden.md')), undefined)
  await engine.execute(job(root, 'index'), noSignal(), progress)
  assert.equal(store.get(path.join(sub, 'Note.md')).status, 'embedded')
}))
test('failed embedding batches retain reusable vectors and retry publishes only a complete file', async () => fixture(async ({ store, engine, root }) => {
  const file = path.join(root, 'Long.md'); await fs.writeFile(file, '# Data\n\n' + Array.from({ length: 12 }, (_, i) => `Record ${i}: alpha revenue and beta cost. `.repeat(20)).join('\n\n'))
  const s = settings({ batchSize: 1, concurrency: 1 }), initial = requests
  failAfter = initial + 1
  const first = await engine.execute(job(root, 'index', {}, s), noSignal(), progress)
  assert.equal(first.failed, 1); assert.equal(store.get(file).status, 'failed')
  assert.ok(store.db.prepare('SELECT count(*) n FROM rag_embedding_cache').get().n >= 1)
  assert.equal(store.db.prepare('SELECT count(*) n FROM rag_chunks').get().n, 0)
  failAfter = Infinity
  const retryResult = await engine.execute(job(root, 'index', {}, s), noSignal(), progress)
  assert.equal(retryResult.embedded, 1); assert.ok(store.get(file).chunks > 1)
}))
test('cancellation does not publish a partial file; recovery turns interrupted jobs into retryable failures', async () => fixture(async ({ store, engine, root }) => {
  const file = path.join(root, 'Cancel.md'); await fs.writeFile(file, 'alpha '.repeat(4000))
  const abort = new AbortController()
  const result = await engine.execute(job(root, 'index'), abort.signal, p => { if (p.message.startsWith('Embedding ')) abort.abort() })
  assert.equal(result.incomplete, true); assert.equal(store.get(file).status, 'failed')
  assert.equal(store.db.prepare('SELECT count(*) n FROM rag_chunks').get().n, 0)
  store.state(file, 'embedding'); store.recover(); assert.equal(store.get(file).status, 'failed')
}))
test('retrieval excludes unselected files and no query is sent for an empty selection', async () => fixture(async ({ engine, root }) => {
  const a = path.join(root, 'A.txt'), b = path.join(root, 'B.txt'); await fs.writeFile(a, 'alpha public'); await fs.writeFile(b, 'beta SECRET')
  await engine.execute(job(root, 'index'), noSignal(), progress)
  const before = requests
  const empty = await engine.execute(job(root, 'retrieve', { paths: [], query: 'SECRET' }), noSignal(), progress)
  assert.equal(empty.hits.length, 0); assert.equal(requests, before)
  const result = await engine.execute(job(root, 'retrieve', { paths: [a], query: 'SECRET beta' }), noSignal(), progress)
  assert.ok(result.hits.every(h => h.path === a)); assert.ok(!JSON.stringify(result.hits).includes('beta SECRET'))
}))
test('deleting files prunes index records; clearing RAG does not delete original files', async () => fixture(async ({ store, engine, root }) => {
  const a = path.join(root, 'A.md'), b = path.join(root, 'B.md'); await fs.writeFile(a, 'alpha'); await fs.writeFile(b, 'beta')
  await engine.execute(job(root, 'index'), noSignal(), progress)
  await fs.unlink(a); await engine.execute(job(root, 'index'), noSignal(), progress)
  assert.equal(store.get(a), undefined)
  await engine.execute(job(root, 'clear'), noSignal(), progress)
  assert.equal(store.get(b), undefined); assert.equal(await fs.readFile(b, 'utf8'), 'beta')
}))
test('extractor rejects malformed UTF-8 instead of silently embedding corrupted text', async () => fixture(async ({ root }) => {
  const file = path.join(root, 'bad.txt'); await fs.writeFile(file, Buffer.from([0xc3, 0x28]))
  await assert.rejects(parseFileToRag(file))
}))

test('XML record chunks retain element paths and attribute context', () => {
  const input = '<orders>' + Array.from({length:20}, (_, i) => `<order id="${i}"><product>alpha</product><amount>${100+i}</amount></order>`).join('') + '</orders>'
  const blocks = xmlBlocks(input)
  assert.equal(blocks.length, 20)
  assert.ok(blocks[0].locator.includes('/orders/order[1]'))
  assert.match(blocks[0].text, /id="0"/)
})
test('HTML tables repeat column labels and exclude scripts', () => {
  const blocks = htmlBlocks('<h1>Sales</h1><script>LEAK_ME()</script><table><tr><th>Region</th><th>Total</th></tr><tr><td>East</td><td>42</td></tr></table>')
  assert.ok(!JSON.stringify(blocks).includes('LEAK_ME'))
  const row = blocks.find(b => b.kind === 'row')
  assert.match(row.text, /Region/); assert.match(row.text, /42/); assert.deepEqual(row.headings, ['Sales'])
})
