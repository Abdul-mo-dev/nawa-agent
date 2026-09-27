import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RAG_SETTINGS, type RagSettings } from '../src/shared/rag-api'
import { MyAgentRag } from '../src/main/rag/myagent'
import { credentialScope, myAgentUrl, validateSettings } from '../src/main/rag/config'
import { hashFile } from '../src/main/directory-actions/file-safety'
import { randomUUID } from 'node:crypto'

let directory: string, root: string, file: string, mapping: string, server: Server, settings: RagSettings, client: MyAgentRag
let revision: string, contentHash: string, selectedRoots: string[], running: boolean
let calls: Array<{ route: string; method: string; body: any; key?: string }>
let searchPatch: Record<string, unknown>, documentPatch: Record<string, unknown>, windowPatch: Record<string, unknown>
let onSearch: (() => Promise<void>) | undefined
let onPoll: (() => void) | undefined
let toolPatch: Record<string, unknown>, onTool: (() => Promise<void>) | undefined
const signal = () => new AbortController().signal
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-myagent-'))
  root = join(directory, 'workspace'); await mkdir(root)
  file = join(root, 'report.txt'); await writeFile(file, 'Annual refund policy')
  mapping = join(directory, 'mappings.json'); contentHash = await hashFile(file); revision = 'revision-1'
  selectedRoots = [root]; calls = []; searchPatch = {}; documentPatch = {}; windowPatch = {}; onSearch = undefined; onPoll = undefined; running = false
  toolPatch = {}; onTool = undefined
  let jobId = ''
  server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part
      const body = raw ? JSON.parse(raw) : undefined, route = req.url!.replace('/api/v1/rag/', '')
      calls.push({ route, method: req.method!, body, key: req.headers['x-myagent-key'] as string | undefined })
      let result: unknown
      const doc = () => ({ id: 'doc-1', contentHash, indexRevision: revision, chunkCount: 2, fullyEmbedded: true, updatedAt: new Date().toISOString(), ...documentPatch })
      if (route === 'roots') result = [{ id: 'docs', displayName: 'Documents', available: true, localPath: root, maxFilesPerJob: 2, maxFileSizeBytes: 50_000_000, allowedExtensions: ['.txt'] }]
      else if (route === 'jobs') { jobId = body.jobId; result = { jobId } }
      else if (route === `jobs/${jobId}/cancel`) { running = false; result = { canceled: true } }
      else if (route === `jobs/${jobId}`) { onPoll?.(); result = { status: running ? 'running' : 'completed', files: [{ relativePath: 'report.txt', status: 'indexed', documentId: 'doc-1' }] } }
      else if (route === 'documents/doc-1') result = doc()
      else if (route.startsWith('tools/')) {
        await onTool?.()
        const sources = body.scope ? [{ documentId: 'doc-1', contentHash, indexRevision: revision, datasetRevision: null }] : []
        result = route === 'tools/catalog'
          ? { sources, scopeChecked: !!body.scope, selectionFiltered: !!body.extensions, tools: body.namesOnly || body.extensions?.length === 0 ? [] : [{ name: 'text_read_lines', description: 'Read lines', inputSchema: { type: 'object' } }], names: body.namesOnly ? ['text_read_lines'] : null, total: 1, nextOffset: null, ...toolPatch }
          : { sources, tool: body.tool, succeeded: true, content: 'Annual refund policy', error: null, ...toolPatch }
      }
      else if (route.startsWith('documents/doc-1/chunks/')) result = { documentId: 'doc-1', contentHash, indexRevision: revision, chunks: [{ chunkId: 'chunk-0', chunkIndex: 0, text: 'Annual refund policy', citation: { pageNumber: 1 } }, { chunkId: 'chunk-1', chunkIndex: 1, text: 'Neighboring explanation', citation: { pageNumber: 1 } }], ...windowPatch }
      else if (route === 'search') {
        await onSearch?.()
        result = { results: [{ documentId: 'doc-1', contentHash, indexRevision: revision, chunkId: 'chunk-0', chunkIndex: 0, text: 'Annual refund policy', score: 0.5, citation: { pageNumber: 1 }, ...searchPatch }] }
      } else { res.statusCode = 404; result = { message: 'Not found' } }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result))
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ message: String(e) })) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  settings = { ...DEFAULT_RAG_SETTINGS, enabled: true, serverUrl: `http://127.0.0.1:${port}` }
  client = new MyAgentRag(mapping, async () => selectedRoots, fetch, 10)
})
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})
const index = () => client.index(settings, 'fixture-key', root, true, signal(), () => {})

describe('MyAgent shared-file adapter', () => {
  it('indexes through root-relative jobs and returns scoped, cited evidence with neighbors', async () => {
    expect(await index()).toMatchObject({ embedded: 1, failed: 0, incomplete: false })
    expect(calls.find(c => c.route === 'jobs')?.body).toMatchObject({ rootId: 'docs', selections: ['report.txt'], recursive: false })
    const result = await client.search(settings, 'fixture-key', [file], 'refunds', signal())
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ path: file, sourceHash: contentHash, chunks: [{ locator: 'page 1' }, { text: 'Neighboring explanation' }] })
    expect(calls.find(c => c.route === 'search')?.body.documentIds).toEqual(['doc-1'])
    expect(calls.every(c => c.key === 'fixture-key')).toBe(true)
    expect(await readFile(mapping, 'utf8')).not.toContain('Annual refund policy')
    expect((await index()).unchanged).toBe(1)
    expect(calls.filter(c => c.route === 'jobs')).toHaveLength(1)
  })
  it('never sends an empty or unmapped selection to unrestricted server search', async () => {
    expect((await client.search(settings, '', [], 'refunds', signal())).hits).toEqual([])
    expect((await client.search(settings, '', [file], 'refunds', signal())).hits).toEqual([])
    expect(calls).toEqual([])
  })
  it('detects edits even when file size and mtime are restored', async () => {
    await index(); const before = await stat(file)
    await writeFile(file, 'Annual cancel policy'); await utimes(file, before.atime, before.mtime)
    expect((await client.statuses(settings, [file]))[0].status).toBe('stale')
    expect((await client.search(settings, '', [file], 'refunds', signal())).hits).toEqual([])
    expect(calls.some(c => c.route === 'search')).toBe(false)
  })
  it('rejects unselected document IDs even if their fingerprints match', async () => {
    await index(); searchPatch.documentId = 'unselected'
    await expect(client.search(settings, '', [file], 'refunds', signal())).rejects.toThrow('unselected or changed')
  })
  it('rejects missing or inconsistent evidence fingerprints', async () => {
    await index(); searchPatch.contentHash = undefined
    await expect(client.search(settings, '', [file], 'refunds', signal())).rejects.toThrow('fingerprints')
    searchPatch = {}; windowPatch.indexRevision = 'revision-2'
    await expect(client.search(settings, '', [file], 'refunds', signal())).rejects.toThrow('context changed')
  })
  it('rejects source edits and permission revocation during network reads', async () => {
    await index(); onSearch = async () => { await writeFile(file, 'Replacement content') }
    await expect(client.search(settings, '', [file], 'refunds', signal())).rejects.toThrow('source changed')
    await writeFile(file, 'Annual refund policy'); onSearch = async () => { selectedRoots = [] }
    await expect(client.search(settings, '', [file], 'refunds', signal())).rejects.toThrow('outside')
  })
  it('cancels the server job when indexing is stopped', async () => {
    running = true; const abort = new AbortController(); onPoll = () => abort.abort()
    const result = await client.index(settings, 'fixture-key', root, true, abort.signal, () => {})
    expect(result.incomplete).toBe(true)
    expect(calls.some(c => c.route.endsWith('/cancel'))).toBe(true)
  })
  it('forgets mappings without deleting shared server documents', async () => {
    await index(); await client.clear(settings, root)
    const reloaded = new MyAgentRag(mapping, async () => [root])
    expect((await reloaded.statuses(settings, [file]))[0].status).toBe('not-indexed')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('Annual refund policy')
  })
  it('refuses files outside the mounted scope and enforces the server selection limit', async () => {
    selectedRoots = []
    expect((await index()).message).toContain('outside')
    expect(calls).toEqual([])
    await expect(client.search(settings, '', Array(101).fill(file), 'refunds', signal())).rejects.toThrow('100')
  })
  it('does not publish a mapping when the server indexed a different source revision', async () => {
    documentPatch.contentHash = 'f'.repeat(64)
    expect(await index()).toMatchObject({ embedded: 0, failed: 1 })
    expect((await client.statuses(settings, [file]))[0].status).toBe('failed')
  })
})

describe('MyAgent knowledge tool adapter', () => {
  const discover = () => client.tools(settings, 'fixture-key', [file], randomUUID(), 'catalog', { query: 'text', scope: 'selected' }, signal())
  it('resolves selected local paths to server IDs and returns exact schemas and provenance', async () => {
    await index()
    const catalog = await discover()
    expect(catalog).toMatchObject({ available: true, tools: [{ name: 'text_read_lines' }], sources: [], files: [{ path: file, documentId: 'doc-1', status: 'ready' }] })
    expect(calls.find(v => v.route === 'tools/catalog')?.body).toMatchObject({ extensions: ['.txt'], documentIds: ['doc-1'] })
    expect(calls.find(v => v.route === 'tools/catalog')?.body.scope).toBeUndefined()
    const result = await client.tools(settings, 'fixture-key', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: { documentId: 'doc-1' } }, signal())
    expect(result).toMatchObject({ succeeded: true, content: 'Annual refund policy', sources: [{ path: file }] })
    expect(calls.filter(v => v.route.startsWith('tools/')).every(v => v.key === 'fixture-key')).toBe(true)
  })
  it('never sends empty or unmapped tool scopes and fails closed on incomplete selection', async () => {
    expect(await client.tools(settings, '', [], randomUUID(), 'catalog', { scope: 'selected' }, signal())).toMatchObject({ tools: [], sources: [] })
    expect(await discover()).toMatchObject({ tools: [{ name: 'text_read_lines' }], sources: [], files: [{ path: file, status: 'needs-index' }] })
    expect(calls.every(call => call.route === 'tools/catalog' && !call.body.scope)).toBe(true)
    await index(); const other = join(root, 'other.txt'); await writeFile(other, 'unindexed')
    expect(await client.tools(settings, '', [file, other], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).toMatchObject({ succeeded: false, sources: [], coverage: { requested: [file, other], covered: [], completeSelection: false }, warnings: [expect.stringContaining('indexing/refresh')] })
    expect(calls.some(v => v.route === 'tools/execute')).toBe(false)
  })
  it('rejects out-of-scope provenance, oversized output and source edits during tool execution', async () => {
    await index(); toolPatch.sources = [{ documentId: 'other', contentHash, indexRevision: revision }]
    await expect(client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).rejects.toThrow('unselected or changed')
    toolPatch = { content: 'x'.repeat(64001) }
    await expect(client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).rejects.toThrow('Invalid MyAgent tool result')
    toolPatch = {}; onTool = async () => { await writeFile(file, 'Changed while reading') }
    await expect(client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).rejects.toThrow('source changed')
  })
  it('pins backend, index and dataset revisions for final-answer verification', async () => {
    await index(); const catalog = await client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal()), session = randomUUID()
    await client.tools(settings, '', [file], session, 'verify', { sources: catalog.sources }, signal())
    toolPatch.sources = [{ documentId: 'doc-1', contentHash, indexRevision: revision, datasetRevision: 'changed-dataset' }]
    await expect(client.tools(settings, '', [file], session, 'verify', { sources: catalog.sources }, signal())).rejects.toThrow('unselected or changed')
    toolPatch = {}
    await expect(client.tools(settings, '', [file], session, 'verify', { sources: catalog.sources.map(v => ({ ...v, server: 'http://localhost:9999' })) }, signal())).rejects.toThrow('mappings changed')
  })
  it('rejects responses after scope revocation and propagates cancellation', async () => {
    await index(); onTool = async () => { selectedRoots = [] }
    await expect(client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).rejects.toThrow('outside')
    selectedRoots = [root]; const cancel = new AbortController(); onTool = async () => { cancel.abort() }
    await expect(client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, cancel.signal)).rejects.toThrow()
  })
  it('lists names and schemas without mappings, mounted roots, selected files or file limits', async () => {
    selectedRoots = []
    await writeFile(mapping, 'invalid mappings that metadata must never open')
    for (const paths of [[], [file], Array(101).fill(file)]) {
      const catalog = await client.tools(settings, 'fixture-key', paths, randomUUID(), 'catalog', { namesOnly: true }, signal())
      expect(catalog).toMatchObject({ tools: [], names: ['text_read_lines'], sources: [], scopeChecked: false, available: true })
    }
    const schemas = await client.tools(settings, 'fixture-key', [file], randomUUID(), 'catalog', { query: 'text' }, signal())
    expect(schemas).toMatchObject({ tools: [{ name: 'text_read_lines' }], sources: [], scopeChecked: false })
    expect(calls.every(call => call.route === 'tools/catalog' && call.body.scope === undefined)).toBe(true)
  })
  it('metadata and selected discovery remain available with an unindexed file', async () => {
    expect(await discover()).toMatchObject({ files: [{ status: 'needs-index' }], tools: [{ name: 'text_read_lines' }] })
    const catalog = await client.tools(settings, '', [file], randomUUID(), 'catalog', { scope: 'server', namesOnly: true }, signal())
    expect(catalog).toMatchObject({ names: ['text_read_lines'], sources: [] })
    expect(await client.tools(settings, '', [file], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).toMatchObject({ succeeded: false, coverage: { covered: [], completeSelection: false } })
    expect(calls.some(c => c.route === 'tools/execute')).toBe(false)
  })
  it('rejects file data in a metadata-only response', async () => {
    toolPatch.sources = [{ documentId: 'doc-1', contentHash, indexRevision: revision }]
    await expect(client.tools(settings, '', [], randomUUID(), 'catalog', {}, signal())).rejects.toThrow('file data')
  })
  it('reads a ready target while other selected files need indexing, and reports partial coverage', async () => {
    await index(); const other = join(root, 'unindexed.xlsx'); await writeFile(other, 'not indexed')
    const catalog = await client.tools(settings, '', [file, other], randomUUID(), 'catalog', { scope: 'selected', initial: true }, signal())
    expect(catalog).toMatchObject({ sources: [], files: [{ path: file, status: 'ready' }, { path: other, status: 'needs-index' }] })
    expect(calls.find(call => call.route === 'tools/catalog')?.body.extensions).toEqual(['.txt', '.xlsx'])
    for (const target of [{ paths: [file], arguments: {} }, { arguments: { documentId: 'doc-1' } }]) {
      const result = await client.tools(settings, '', [file, other], randomUUID(), 'execute', { tool: 'text_read_lines', ...target }, signal())
      expect(result).toMatchObject({ succeeded: true, sources: [{ path: file }], coverage: { selected: 2, requested: [file], covered: [file], completeSelection: false } })
    }
    expect(calls.filter(call => call.route === 'tools/execute').every(call => call.body.scope.sources.length === 1)).toBe(true)
    for (const target of [{ paths: [] }, { paths: [join(root, 'unselected.txt')] }, { arguments: { documentId: 'unselected' } }])
      await expect(client.tools(settings, '', [file, other], randomUUID(), 'execute', { tool: 'text_read_lines', arguments: {}, ...target }, signal())).rejects.toThrow(/selected files/)
  })
})

describe('RAG backend settings', () => {
  it('uses MyAgent for new settings and migrates legacy settings to local embeddings', () => {
    expect(validateSettings(settings).backend).toBe('myagent')
    const { backend: _backend, serverUrl: _url, ...legacy } = { ...settings, model: 'embedding-model' }
    expect(validateSettings(legacy).backend).toBe('local')
    expect(credentialScope(settings)).not.toBe(credentialScope({ ...settings, backend: 'local' }))
  })
  it('restricts shared-file servers to loopback and rejects credential/path URLs', () => {
    expect(myAgentUrl('http://localhost:5187/')).toBe('http://localhost:5187')
    for (const url of ['http://192.168.1.2:5187', 'http://user:pass@localhost:5187', 'http://localhost:5187/v1', 'http://localhost:5187/?key=secret']) expect(() => myAgentUrl(url)).toThrow()
  })
})
