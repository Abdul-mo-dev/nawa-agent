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
import { DirectoryActionManager } from '../src/main/directory-actions/manager'

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
  it('assigns separate citation IDs to identical files and retains each source path', async () => {
    await index()
    const copy = join(root, 'report-copy.txt'); await writeFile(copy, 'Annual refund policy')
    const mappings = JSON.parse(await readFile(mapping, 'utf8'))
    mappings.entries.push({ ...mappings.entries[0], path: copy, documentId: 'doc-2' })
    await writeFile(mapping, JSON.stringify(mappings))
    const fake: typeof fetch = async input => {
      const url = String(input)
      const documentId = url.includes('/doc-2') ? 'doc-2' : 'doc-1'
      const chunk = { documentId, contentHash, indexRevision: revision, chunkId: 'chunk-0', chunkIndex: 0, text: 'Annual refund policy', score: 1, citation: { pageNumber: 1 } }
      const result = url.endsWith('/search') ? { results: [chunk, { ...chunk, documentId: 'doc-2' }] }
        : url.includes('/chunks/') ? { documentId, contentHash, indexRevision: revision, chunks: [chunk] }
        : { id: documentId, contentHash, indexRevision: revision, fullyEmbedded: true, chunkCount: 1, updatedAt: new Date().toISOString() }
      return new Response(JSON.stringify(result))
    }
    const duplicateClient = new MyAgentRag(mapping, async () => selectedRoots, fake)
    const found = await duplicateClient.search(settings, '', [file, copy], 'refund policy', signal())
    expect(found.hits.map(hit => hit.path)).toEqual([file, copy])
    expect(found.hits[0].sourceHash).toBe(found.hits[1].sourceHash)
    const citations = found.hits.map(hit => hit.excerpt?.match(/\[(RAG:[^\]]+)\]/)?.[1])
    expect(citations.every(Boolean)).toBe(true)
    expect(new Set(citations).size).toBe(2)
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
  it('prepares metadata without document probes and makes one attempt during an outage', async () => {
    await index(); await writeFile(file, 'Changed since indexing'); calls = []
    expect(await client.tools(settings, '', [file], 'session', 'catalog', { scope: 'selected' }, signal())).toMatchObject({
      files: [{ status: 'unchecked' }], diagnostics: { httpRequests: 1 }, sources: [],
    })
    expect(calls.map(call => call.route)).toEqual(['tools/catalog'])
    let attempts = 0
    const offline = new MyAgentRag(mapping, async () => selectedRoots, async () => { attempts++; throw new Error('offline') })
    await expect(offline.tools(settings, '', [file, ...Array.from({ length: 100 }, (_, i) => join(root, `missing-${i}.txt`))], 'session', 'catalog', { scope: 'selected' }, signal())).rejects.toThrow('offline')
    expect(attempts).toBe(1)
  })
  it('allows one target within 101 selected paths and rejects an unbatched full-scope execution', async () => {
    await index(); calls = []
    const selection = [file, ...Array.from({ length: 100 }, (_, i) => join(root, `unindexed-${i}.txt`))]
    const catalog = await client.tools(settings, '', selection, 'session', 'catalog', { scope: 'selected' }, signal())
    expect('files' in catalog && catalog.files?.length).toBe(101)
    expect(await client.tools(settings, '', selection, 'session', 'execute', { tool: 'text_read_lines', paths: [file], arguments: {} }, signal()))
      .toMatchObject({ succeeded: true, coverage: { selected: 101, requested: [file], covered: [file], completeSelection: false } })
    await expect(client.tools(settings, '', selection, 'session', 'execute', { tool: 'text_read_lines', arguments: {} }, signal())).rejects.toThrow('Target at most 100')
  })
  it('uses four HTTP requests for discovery, two tools and final validation through the manager', async () => {
    await index(); calls = []
    const manager = new DirectoryActionManager({ stateDirectory: directory, roots: async () => selectedRoots,
      myAgentTools: (paths, session, action, payload, signal) => client.tools(settings, '', paths, session, action, payload, signal),
      extract: async () => '', blank: async () => {}, open: async () => { throw new Error('unused') }, assertClosed: async () => {}, trash: async () => {}, changed: () => {},
    })
    const session = await manager.begin(1, { opened: root, files: [file], directories: [] })
    try {
      await manager.myAgentTools(1, session, 'catalog', { scope: 'selected' })
      for (let i = 0; i < 2; i++) await manager.myAgentTools(1, session, 'execute', { tool: 'text_read_lines', paths: [file], arguments: { startLine: i } })
      expect(await manager.validateEvidence(1, session)).toMatchObject({ sourceCount: 1, httpRequests: 1 })
      expect(calls.map(call => call.route)).toEqual(['tools/catalog', 'tools/execute', 'tools/execute', 'tools/catalog'])
    } finally { await manager.cancel(1, session) }
  })
  it('reports a missing tools endpoint clearly and checks it during connection testing', async () => {
    const oldServer: typeof fetch = async (input, init) => String(input).includes('/tools/')
      ? new Response(null, { status: 404 }) : fetch(input, init)
    const oldClient = new MyAgentRag(mapping, async () => selectedRoots, oldServer)
    await expect(oldClient.test(settings, 'fixture-key')).rejects.toThrow('Rebuild and restart the MyAgent server')
    expect(calls.map(call => call.route)).toEqual(['roots'])
    await expect(oldClient.tools(settings, 'fixture-key', [], 'session', 'catalog', { scope: 'server' }, signal()))
      .rejects.toThrow('HTTP 404 at /api/v1/rag/tools/catalog')
  })
  it('does not mistake a structured missing-source response for a missing endpoint', async () => {
    const missingSource = new MyAgentRag(mapping, async () => selectedRoots, async () =>
      new Response(JSON.stringify({ code: 'rag_tool_source_missing', message: 'Source no longer exists' }), { status: 404 }))
    await expect(missingSource.tools(settings, '', [], 'session', 'catalog', { scope: 'server' }, signal()))
      .rejects.toThrow('MyAgent HTTP 404: Source no longer exists')
  })
  it('checks document-tool metadata without reading files in connection tests', async () => {
    expect(await client.test(settings, 'fixture-key')).toMatchObject({ message: expect.stringContaining('RAG and document tools') })
    expect(calls.map(call => call.route)).toEqual(['roots', 'tools/catalog'])
    expect(calls[1].body).toMatchObject({ namesOnly: true })
    expect(calls[1].body.scope).toBeUndefined()
  })
  const discover = () => client.tools(settings, 'fixture-key', [file], randomUUID(), 'catalog', { query: 'text', scope: 'selected' }, signal())
  it('resolves selected local paths to server IDs and returns exact schemas and provenance', async () => {
    await index()
    const catalog = await discover()
    expect(catalog).toMatchObject({ available: true, tools: [{ name: 'text_read_lines' }], sources: [], files: [{ path: file, documentId: 'doc-1', status: 'unchecked' }] })
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
    expect(catalog).toMatchObject({ sources: [], files: [{ path: file, status: 'unchecked' }, { path: other, status: 'needs-index' }] })
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
