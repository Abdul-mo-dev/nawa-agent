/** Real HTTP integration against an isolated MyAgent build. Never uses the live server or user documents.
 * NAWA_MYAGENT_SERVER_DLL must point to a built MyAgent.Server.dll with its runtime/dependency files.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'

const dll = process.env.NAWA_MYAGENT_SERVER_DLL
assert.ok(dll, 'Set NAWA_MYAGENT_SERVER_DLL to the isolated MyAgent.Server.dll build.')
await fs.access(dll)
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'nawa-myagent-integration-'))
const docs = path.join(state, 'documents'), data = path.join(state, 'data')
await fs.mkdir(docs); await fs.mkdir(data)
const file = path.join(docs, 'refunds.txt')
await fs.writeFile(file, 'Annual refund policy\nCustomers may request a refund within thirty days of purchase.\nRefunds are processed within five business days.')
const spreadsheet = path.join(docs, 'tickets.csv'), longText = path.join(docs, 'long.txt')
await fs.writeFile(spreadsheet, 'region,amount,feedback\nEast,10.25,refund requested\nWest,20.50,refund approved\nEast,5.25,refund completed\n')
await fs.writeFile(longText, Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: ` + 'Detailed source evidence. '.repeat(16)).join('\n'))
let classifications = 0
const embedding = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw || '{}')
  res.setHeader('Content-Type', 'application/json')
  if (req.url.endsWith('/chat/completions')) {
    const payload = JSON.parse(body.messages.findLast(m => m.role === 'user').content)
    assert.ok(Array.isArray(payload.rows), 'Fixture expects supplied categories and actual row classification')
    classifications += payload.rows.length
    const content = JSON.stringify({ rows: payload.rows.map(row => ({ rowId: row.rowId, labels: [{ categoryId: 'refund', quote: row.text }], uncertain: false, reason: null })) })
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }))
    return
  }
  res.end(JSON.stringify({ data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ index, embedding: [1, 0.5, 0.25] })) }))
})
await new Promise(resolve => embedding.listen(0, '127.0.0.1', resolve))
const portReservation = createServer()
await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve))
const port = portReservation.address().port
await new Promise(resolve => portReservation.close(resolve))
const url = `http://127.0.0.1:${port}`, apiKey = 'isolated-nawa-integration-key'
await fs.writeFile(path.join(state, 'appsettings.json'), JSON.stringify({
  MyAgentDataRoot: data,
  MyAgent: {
    ApiKey: apiKey, MigrateLegacyData: false, WorkspacesRoot: path.join(state, 'workspaces'), Authentication: { Enabled: true },
    AgentTools: { EnableWebSearch: false, Codex: { Enabled: false }, OpenCode: { Enabled: false } },
    Provider: { BaseUrl: `http://127.0.0.1:${embedding.address().port}/v1`, Model: 'fixture' },
    Rag: { EmbeddingBaseUrl: `http://127.0.0.1:${embedding.address().port}/v1`, EmbeddingModel: 'fixture',
      Roots: [{ Id: 'nawa-test', DisplayName: 'Nawa integration', Path: docs }], RenderVisualPages: false, ExtractEmbeddedImages: false },
  },
}))
await build({ entryPoints: ['apps/shell/src/main/rag/myagent.ts'], outfile: path.join(state, 'adapter.mjs'), bundle: true, platform: 'node', format: 'esm' })
await build({ entryPoints: ['apps/shell/src/shared/rag-api.ts'], outfile: path.join(state, 'settings.mjs'), bundle: true, platform: 'node', format: 'esm' })
const child = spawn('dotnet', [dll, '--contentRoot', state, '--urls', url], { cwd: state, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`MyAgent exited: ${log}`)
    if (await fetch(url + '/api/v1/health').then(r => r.ok).catch(() => false)) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, `MyAgent did not start: ${log}`)
  assert.equal((await fetch(url + '/api/v1/rag/roots')).status, 401)
  const { MyAgentRag } = await import(pathToFileURL(path.join(state, 'adapter.mjs')).href)
  const { DEFAULT_RAG_SETTINGS } = await import(pathToFileURL(path.join(state, 'settings.mjs')).href)
  const settings = { ...DEFAULT_RAG_SETTINGS, enabled: true, serverUrl: url }
  const adapter = new MyAgentRag(path.join(state, 'nawa-mappings.json'), async () => [docs], fetch, 100)
  assert.match((await adapter.test(settings, apiKey)).message, /Nawa integration/)
  const signal = new AbortController().signal
  // Tool metadata must work before any selected file has been indexed, and with no selection.
  const metadataSession = randomUUID()
  for (const paths of [[], [file, spreadsheet]]) {
    const names = await adapter.tools(settings, apiKey, paths, metadataSession, 'catalog', { namesOnly: true }, signal)
    assert.equal(names.scopeChecked, false); assert.deepEqual(names.sources, []); assert.deepEqual(names.tools, [])
    assert.ok(names.names.includes('pdf_read_pages') && names.names.includes('spreadsheet_query_sql'))
    assert.equal(names.names.length, names.total); assert.equal(names.nextOffset, null)
  }
  const beforeIndex = await adapter.tools(settings, apiKey, [spreadsheet], metadataSession, 'catalog', { scope: 'selected', initial: true }, signal)
  assert.equal(beforeIndex.files[0].status, 'needs-index'); assert.deepEqual(beforeIndex.sources, [])
  assert.ok(beforeIndex.initialTools.some(t => t.name === 'spreadsheet_query_sql'))
  assert.ok(beforeIndex.initialTools.length <= 6)
  assert.ok(beforeIndex.tools.every(t => !t.name.startsWith('pdf_')))
  const metadataSchemas = await adapter.tools(settings, apiKey, [file], metadataSession, 'catalog', { query: 'pdf_read_pages' }, signal)
  assert.ok(metadataSchemas.tools.some(t => t.name === 'pdf_read_pages')); assert.deepEqual(metadataSchemas.sources, [])
  const indexed = await adapter.index(settings, apiKey, docs, true, signal, () => {})
  assert.equal(indexed.embedded, 3, JSON.stringify(indexed))
  assert.equal(indexed.failed, 0, JSON.stringify(indexed))
  const found = await adapter.search(settings, apiKey, [file], 'refund policy', signal)
  assert.equal(found.hits.length, 1, JSON.stringify(found))
  assert.equal(found.hits[0].path, file)
  assert.match(JSON.stringify(found.hits[0]), /thirty days/)
  const firstHash = found.hits[0].sourceHash
  const session = randomUUID(), headers = { 'X-MyAgent-Key': apiKey, 'Content-Type': 'application/json' }
  const discover = (paths, query, offset = 0) => adapter.tools(settings, apiKey, paths, session, 'catalog', { query, offset, scope: 'selected' }, signal)
  const invoke = (paths, tool, args, sessionId = session) => adapter.tools(settings, apiKey, paths, sessionId, 'execute', { tool, arguments: args }, signal)
  const contents = result => { assert.equal(result.succeeded, true, JSON.stringify(result)); return JSON.parse(result.content) }
  const field = (obj, name) => obj[Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase())]
  const readers = await discover([file], 'text')
  assert.ok(readers.tools.some(t => t.name === 'text_read_lines'))
  assert.ok(!readers.tools.some(t => t.name.startsWith('spreadsheet_')))
  const documentId = readers.files[0].documentId
  const lineResult = await invoke([file], 'text_read_lines', { documentId, startLine: 2, endLine: 3 })
  const lines = contents(lineResult)
  assert.match(JSON.stringify(lines), /thirty days/)
  const scope = { sessionId: session, sources: lineResult.sources }
  for (const [route, body, status] of [
    ['catalog', { scope: { ...scope, sources: [] } }, 400],
    ['execute', { scope: null, tool: 'text_read_lines', arguments: { documentId, startLine: 1 } }, 400],
    ['execute', { scope, tool: 'shell_execute', arguments: {} }, 400],
    ['execute', { scope, tool: 'text_read_lines', arguments: { documentId: 'unselected', startLine: 1 } }, 400],
    ['catalog', { scope: { ...scope, sources: lineResult.sources.map(s => ({ ...s, indexRevision: 'stale' })) } }, 409],
  ]) {
    assert.equal((await fetch(url + '/api/v1/rag/tools/' + route, { method: 'POST', headers, body: JSON.stringify(body) })).status, status)
  }
  assert.equal((await fetch(url + '/api/v1/rag/tools/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) })).status, 401)
  const longCatalog = await discover([longText], 'text_read_lines')
  const retained = contents(await invoke([longText], 'text_read_lines', { documentId: longCatalog.files[0].documentId, startLine: 1, endLine: 80 }))
  assert.ok(retained.resultId, JSON.stringify(retained).slice(0, 1000))
  const page = contents(await invoke([longText], 'tools.read_result', { resultId: retained.resultId, path: '/lines', offset: 0, limit: 2 }))
  assert.match(JSON.stringify(page), /Detailed source evidence/)
  assert.equal((await invoke([longText], 'tools.read_result', { resultId: retained.resultId, path: '/lines' }, randomUUID())).succeeded, false, 'Result handles must not cross Nawa requests')
  const unindexed = path.join(docs, 'unindexed.xlsx')
  await fs.writeFile(unindexed, 'not indexed')
  const mixed = await discover([file, unindexed], '')
  assert.deepEqual(mixed.files.map(f => f.status), ['ready', 'needs-index'])
  const narrow = await invoke([file, unindexed], 'text_read_lines', { documentId, startLine: 1 })
  assert.equal(narrow.succeeded, true); assert.equal(narrow.coverage.completeSelection, false)
  assert.deepEqual(narrow.coverage.covered, [file])
  const broad = await invoke([file, unindexed], 'knowledge_list_documents', {})
  assert.equal(broad.succeeded, false); assert.deepEqual(broad.coverage.covered, [])
  assert.match(broad.warnings.join(' '), /unindexed.xlsx/)
  const subsetPage = await adapter.tools(settings, apiKey, [longText, unindexed], session, 'execute', {
    tool: 'tools.read_result', arguments: { resultId: retained.resultId, path: '/lines', offset: 2, limit: 2 }, paths: [longText],
  }, signal)
  assert.match(JSON.stringify(contents(subsetPage)), /Detailed source evidence/)
  await fs.rm(unindexed)
  const sqlTools = await discover([spreadsheet], 'spreadsheet')
  assert.ok(sqlTools.nextOffset != null, 'Discovery must paginate')
  const nextTools = await discover([spreadsheet], 'spreadsheet', sqlTools.nextOffset)
  assert.ok([...sqlTools.tools, ...nextTools.tools].some(t => t.name === 'spreadsheet_query_sql'))
  const datasets = field(contents(await invoke([spreadsheet], 'spreadsheet_catalog_search', { query: '' })), 'datasets')
  assert.ok(datasets.length)
  const dataset = datasets[0], datasetId = field(dataset, 'id'), sqlObject = field(dataset, 'sqlObjectName')
  const description = field(contents(await invoke([spreadsheet], 'spreadsheet_describe_dataset', { datasetId })), 'description')
  const textColumn = field(description, 'columns').find(c => field(c, 'sourceName') === 'feedback')
  const sqlResult = await invoke([spreadsheet], 'spreadsheet_query_sql', { sql: `SELECT COUNT(*) AS total FROM "${sqlObject}"` })
  const sql = contents(sqlResult)
  assert.equal(field(field(sql, 'result'), 'rows')[0].total, 3)
  assert.equal((await invoke([spreadsheet], 'spreadsheet_query_sql', { sql: `DELETE FROM "${sqlObject}"` })).succeeded, false)
  const analysis = contents(await invoke([spreadsheet], 'spreadsheet_analyze_text', { datasetId, textColumn: field(textColumn, 'sqlName'), instructions: 'Classify refund-related feedback', categories: [{ id: 'refund', label: 'Refund', definition: 'Feedback explicitly mentioning a refund.' }] }))
  assert.ok(analysis.analysisId); assert.equal(classifications, 3)
  assert.match(JSON.stringify(contents(await invoke([spreadsheet], 'spreadsheet_analysis_query', { analysisId: analysis.analysisId }))), /Refund/)
  assert.match(JSON.stringify(contents(await invoke([spreadsheet], 'spreadsheet_analysis_list', {}))), new RegExp(analysis.analysisId))
  await adapter.tools(settings, apiKey, [spreadsheet], session, 'verify', { sources: sqlResult.sources }, signal)
  await fs.writeFile(file, 'Annual refund policy\nCustomers may request a refund within sixty days of purchase.')
  assert.ok((await adapter.tools(settings, apiKey, [file], session, 'catalog', { namesOnly: true }, signal)).names.includes('text_read_lines'))
  const stale = await invoke([file], 'text_read_lines', { documentId, startLine: 1 })
  assert.equal(stale.succeeded, false); assert.match(stale.warnings.join(' '), /indexing\/refresh/)
  assert.equal((await adapter.search(settings, apiKey, [file], 'refund policy', signal)).hits.length, 0)
  assert.equal((await adapter.index(settings, apiKey, docs, true, signal, () => {})).embedded, 1)
  const refreshed = await adapter.search(settings, apiKey, [file], 'refund policy', signal)
  assert.notEqual(refreshed.hits[0].sourceHash, firstHash)
  assert.match(JSON.stringify(refreshed.hits[0]), /sixty days/)
  await adapter.clear(settings, docs)
  assert.equal((await adapter.search(settings, apiKey, [file], 'refund policy', signal)).hits.length, 0)
  const catalog = await fetch(url + '/api/v1/rag/documents', { headers: { 'X-MyAgent-Key': apiKey } }).then(r => r.json())
  assert.equal(catalog.length, 3, 'Forgetting mappings must preserve server documents')
  console.log('PASS real MyAgent HTTP: automatic filtered tools before indexing, mixed readiness and target coverage, names metadata, authentication, scoped readers/SQL/classification, saved results, subset paging/isolation, stale-source rejection, refresh, and non-destructive clearing.')
} catch (error) {
  console.error(log.slice(-12000)); throw error
} finally {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  embedding.closeAllConnections(); await new Promise(resolve => embedding.close(resolve))
  // This path is a newly created temp directory owned exclusively by this test.
  assert.ok(path.basename(state).startsWith('nawa-myagent-integration-'))
  await fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
