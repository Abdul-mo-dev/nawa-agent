import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration, patch, snapshot } from './fixtures/myagent-settings'
import { MYAGENT_SETTINGS_CHANNEL } from '../src/shared/myagent-settings-api'

const mocks = vi.hoisted(() => ({ directory: '', handlers: new Map<string, (...args: any[]) => Promise<any>>(), execute: vi.fn(), spawn: vi.fn(), picker: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory }, ipcMain: { handle: (name: string, action: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, action) }, BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showOpenDialog: mocks.picker } }))
vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute })
  return { execFile, spawn: mocks.spawn }
})
import { MyAgentSettingsService, registerMyAgentSettingsIpc } from '../src/main/myagent/service'
import { launchSettings, revision, sanitize, updateConfiguration } from '../src/main/myagent/configuration'

let fetcher: ReturnType<typeof vi.fn<typeof fetch>>, service: MyAgentSettingsService, current: typeof configuration
const connection = { serverUrl: 'http://127.0.0.1:5187', apiKey: 'service-secret', timeoutMs: 1000 }
const response = (value: unknown, status = 200) => new Response(value === undefined ? undefined : JSON.stringify(value), { status })
beforeEach(async () => {
  vi.clearAllMocks(); mocks.handlers.clear()
  mocks.directory = await mkdtemp(join(tmpdir(), 'nawa-myagent-settings-'))
  mocks.execute.mockRejectedValue(Object.assign(new Error('not installed'), { code: 1060 }))
  current = structuredClone(configuration)
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    const route = String(url).split('/api/v1/')[1]
    if (route === 'health') return response(snapshot.health)
    if (route === 'readiness') return response({ ready: true, status: 'Managed provider starts on demand.', providerAvailable: false, startsOnDemand: true })
    if (route === 'config' && options?.method === 'PUT') {
      const body = JSON.parse(String(options.body))
      current = { ...current, ...body, provider: { ...current.provider, ...body.provider }, rag: { ...current.rag, ...body.rag } }
      return response({ configuration: current, restartRequired: false, restartRequiredSettings: [] })
    }
    if (route === 'config') return response(current)
    if (route === 'llama/profiles') return response(snapshot.profiles)
    if (route === 'llama/status') return response(snapshot.runtimes)
    if (route === 'llama/embedding/start') return response({ ...snapshot.runtimes[1], recentLogs: ['runtime internal log'] })
    if (route === 'server/reload-configuration') return response({ applied: true })
    return response(undefined, 202)
  })
  service = new MyAgentSettingsService({ connection: async () => connection, isHomeSender: () => true }, fetcher)
})
afterEach(async () => { await rm(mocks.directory, { recursive: true, force: true }); vi.useRealTimers() })

describe('MyAgent server configuration', () => {
  it('lists bounded tool metadata with protected authentication and file-type hints without any document scope', async () => {
    fetcher.mockResolvedValue(response({ tools: [{ name: 'spreadsheet_query_sql', description: 'Query indexed rows.', inputSchema: { type: 'object' } }], total: 2, nextOffset: 1, sources: [], scopeChecked: false, selectionFiltered: true }))
    const result = await service.documentTools({ query: 'sql', offset: 0, extensions: ['.XLSX', '.xlsx'], scope: { sources: ['must-not-send'] }, documentIds: ['must-not-send'] })
    expect(result).toMatchObject({ filtered: true, total: 2, nextOffset: 1, tools: [{ name: 'spreadsheet_query_sql' }] })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe(connection.serverUrl + '/api/v1/rag/tools/catalog')
    expect(options?.headers).toMatchObject({ 'X-MyAgent-Key': 'service-secret' })
    expect(JSON.parse(String(options?.body))).toEqual({ query: 'sql', offset: 0, limit: 20, namesOnly: false, extensions: ['.xlsx'] })
    expect(JSON.stringify(result)).not.toContain('service-secret')
  })
  it('rejects invalid catalog requests before HTTP and refuses file evidence or unsupported filtering in metadata responses', async () => {
    for (const input of [{ query: '', offset: -1 }, { query: 'x'.repeat(257), offset: 0 }, { query: '', offset: 0, extensions: ['C:\\Docs\\file.xlsx'] }])
      await expect(service.documentTools(input)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    const catalog = { tools: [], total: 0, nextOffset: null, sources: [], scopeChecked: false, selectionFiltered: false }
    fetcher.mockResolvedValue(response({ ...catalog, sources: [{ documentId: 'private' }] }))
    await expect(service.documentTools({ query: '', offset: 0 })).rejects.toThrow('metadata-only')
    fetcher.mockResolvedValue(response(catalog))
    await expect(service.documentTools({ query: '', offset: 0, extensions: ['.xlsx'] })).rejects.toThrow('metadata-only')
    fetcher.mockResolvedValue(response({ ...catalog, total: 1, nextOffset: 0 }))
    await expect(service.documentTools({ query: '', offset: 0 })).rejects.toThrow('metadata-only')
  })
  it('runs read-only provider diagnostics on demand and retains partial failures', async () => {
    await service.inspect()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/readiness'))).toBe(false)
    fetcher.mockClear()
    const result = await service.diagnostics()
    expect(result.readiness).toMatchObject({ ready: true, startsOnDemand: true, providerAvailable: false })
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/api/v1/')[1]).sort()).toEqual(['health', 'readiness'])
    expect(mocks.spawn).not.toHaveBeenCalled()
    fetcher.mockImplementation(async url => String(url).endsWith('/health') ? response(snapshot.health) : response({ message: 'offline service-secret' }, 500))
    const partial = await service.diagnostics()
    expect(partial.health?.status).toBe('ok'); expect(partial.readiness).toBeNull()
    expect(JSON.stringify(partial)).not.toContain('service-secret')
  })
  it('saves extraction controls while preserving storage and validates the server limits', async () => {
    const edited = patch()
    Object.assign(edited.rag, { maxPages: 100, maxImagesPerFile: 12, visualExtractionTimeoutSeconds: 45, visualExtractionRetryCount: 2, tesseractPath: '', libreOfficePath: '', renderVisualPages: false, extractEmbeddedImages: false })
    const result = await service.saveConfiguration(connection.serverUrl, revision(configuration), edited)
    expect(result.snapshot.configuration?.rag).toMatchObject({ maxPages: 100, maxImagesPerFile: 12, visualExtractionTimeoutSeconds: 45, visualExtractionRetryCount: 2, tesseractPath: '', libreOfficePath: '', renderVisualPages: false, extractEmbeddedImages: false, databasePath: configuration.rag.databasePath })
    edited.rag.visualExtractionRetryCount = 21
    expect(() => updateConfiguration(configuration, edited)).toThrow('retries')
    edited.rag.visualExtractionRetryCount = 2; edited.rag.maxPages = -1
    expect(() => updateConfiguration(configuration, edited)).toThrow('page limit')
  })
  it('reads the server APIs with the protected key and strips returned secrets', async () => {
    const result = await service.inspect()
    expect(result.configuration).toEqual(configuration)
    expect(JSON.stringify(result)).not.toContain('service-secret')
    expect(fetcher).toHaveBeenCalledWith(connection.serverUrl + '/api/v1/config', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ 'X-MyAgent-Key': 'service-secret' }) }))
    expect(sanitize({ apiKey: 'hidden', password: 'hidden', apiKeyConfigured: true, detail: 'key service-secret' }, ['service-secret'])).toEqual({ apiKeyConfigured: true, detail: 'key [redacted]' })
  })
  it('preserves storage, indexing, runtime, and existing provider credentials on unrelated saves', async () => {
    const edited = patch(); edited.provider.model = 'updated-chat'
    const result = await service.saveConfiguration(connection.serverUrl, revision(configuration), edited)
    const call = fetcher.mock.calls.find(([, options]) => options?.method === 'PUT')!
    const body = JSON.parse(String(call[1]?.body))
    expect(body.rag).toMatchObject({ databasePath: 'Data/knowledge.sqlite3', chunkMaxChars: 1800, tesseractPath: 'C:\\Tools\\tesseract.exe' })
    expect(body.runtime).toEqual(configuration.runtime)
    expect(body.provider).not.toHaveProperty('apiKey')
    expect(body.rag).not.toHaveProperty('embeddingApiKey')
    expect(result.applied).toBe(true)
    expect(result.snapshot.configuration?.provider.model).toBe('updated-chat')
  })
  it('rejects stale drafts and changed connections before writing', async () => {
    await expect(service.saveConfiguration(connection.serverUrl, 'old-revision', patch())).rejects.toThrow('changed elsewhere')
    await expect(service.saveConfiguration('http://127.0.0.1:9999', revision(configuration), patch())).rejects.toThrow('connection changed')
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })
  it('returns partial status and actionable authentication errors when administration is unavailable', async () => {
    fetcher.mockImplementation(async url => String(url).endsWith('/health') ? response(snapshot.health) : response({ message: 'denied' }, 401))
    const result = await service.inspect()
    expect(result.health.status).toBe('ok'); expect(result.configuration).toBeNull()
    expect(result.warnings[0]).toContain('service API key')
  })
  it('keeps saved settings visible when live application fails', async () => {
    fetcher.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/config') && options?.method === 'PUT') return response({ configuration, restartRequired: false, restartRequiredSettings: [] })
      if (String(url).endsWith('/config')) return response(configuration)
      if (String(url).endsWith('/health')) return response(snapshot.health)
      return response({ message: 'failed service-secret' }, 500)
    })
    const result = await service.saveConfiguration(connection.serverUrl, revision(configuration), patch())
    expect(result.applied).toBe(false); expect(result.warning).toContain('Settings were saved')
    expect(JSON.stringify(result)).not.toContain('service-secret')
  })
  it('reports restart requirements without restarting the server automatically', async () => {
    fetcher.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/config') && options?.method === 'PUT') return response({ configuration, restartRequired: true, restartRequiredSettings: ['MyAgent.Rag.Roots/WorkspacesRoot'] })
      if (String(url).endsWith('/config')) return response(configuration)
      if (String(url).endsWith('/health')) return response(snapshot.health)
      return response([])
    })
    expect((await service.saveConfiguration(connection.serverUrl, revision(configuration), patch())).restartRequired).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('shutdown') || String(url).includes('reload-configuration'))).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('rejects redirects, remote server URLs, and oversized responses', async () => {
    const remote = new MyAgentSettingsService({ connection: async () => ({ ...connection, serverUrl: 'https://example.com' }), isHomeSender: () => true }, fetcher)
    await expect(remote.inspect()).rejects.toThrow('localhost')
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)))
    await expect(service.inspect()).rejects.toThrow('exceeds 1 MiB')
  })
  it('accepts the server visual modes and validates roots and token limits', () => {
    for (const mode of ['None', 'AssetsOnly', 'OcrOnly', 'VlmCaption', 'VlmDetailed', 'OcrAndVlm']) { const edited = patch(); edited.rag.visualMode = mode; expect(updateConfiguration(configuration, edited)).toHaveProperty('rag.visualMode', mode) }
    const edited = patch(); edited.rag.roots.push({ ...edited.rag.roots[0] })
    expect(() => updateConfiguration(configuration, edited)).toThrow('unique ID')
    edited.rag.roots.pop(); edited.provider.contextWindowTokens = 8192
    expect(() => updateConfiguration(configuration, edited)).toThrow('both token limits')
  })
  it('requires a current advertised runtime ID before starting a model', async () => {
    await expect(service.model('start', 'not-a-runtime')).rejects.toThrow('no longer available')
    const runtime = await service.model('start', 'embedding')
    expect(runtime).not.toHaveProperty('recentLogs')
    expect(fetcher).toHaveBeenCalledWith(connection.serverUrl + '/api/v1/llama/embedding/start', expect.objectContaining({ method: 'POST' }))
  })
})

describe('local launch and IPC', () => {
  it('persists only local launch preferences, with fixed MyAgent executable names', async () => {
    const launch = { mode: 'process' as const, serverPath: join(mocks.directory, 'MyAgent.Server.dll'), configurationDirectory: join(mocks.directory, 'server') }
    await service.saveLaunch(launch)
    const saved = await readFile(join(mocks.directory, 'myagent', 'launch-v1.json'), 'utf8')
    expect(JSON.parse(saved)).toEqual(launch); expect(saved).not.toContain('service-secret')
    expect(() => launchSettings({ ...launch, serverPath: join(mocks.directory, 'arbitrary.exe') })).toThrow('MyAgent.Server')
  })
  it('starts a hidden process with fixed arguments and creates only a missing configuration', async () => {
    const serverPath = join(mocks.directory, 'MyAgent.Server.exe'), configurationDirectory = join(mocks.directory, 'server')
    await writeFile(serverPath, '')
    await service.saveLaunch({ mode: 'process', serverPath, configurationDirectory })
    let online = false
    fetcher.mockImplementation(async url => { if (String(url).endsWith('/health') && !online) throw new Error('offline'); return response(snapshot.health) })
    mocks.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { pid: 321, unref: vi.fn(), kill: vi.fn() }); online = true; void Promise.resolve().then(() => child.emit('spawn')); return child })
    await service.control('start')
    expect(mocks.spawn).toHaveBeenCalledWith(serverPath, ['--contentRoot', configurationDirectory, '--MyAgentDataRoot', configurationDirectory], expect.objectContaining({ windowsHide: true, shell: false }))
    const saved = JSON.parse(await readFile(join(configurationDirectory, 'appsettings.json'), 'utf8'))
    expect(saved.MyAgent.ApiKey).toBe('service-secret')
    expect(saved.MyAgent.MigrateLegacyData).toBe(false)
  })
  it('preserves an existing server configuration byte for byte on start', async () => {
    const serverPath = join(mocks.directory, 'MyAgent.Server.exe'), configurationDirectory = join(mocks.directory, 'server')
    await writeFile(serverPath, ''); await mkdir(configurationDirectory)
    const original = '{"Urls":"http://127.0.0.1:5187","Existing":true}\n'
    await writeFile(join(configurationDirectory, 'appsettings.json'), original)
    await service.saveLaunch({ mode: 'process', serverPath, configurationDirectory })
    let online = false
    fetcher.mockImplementation(async () => { if (!online) throw new Error('offline'); return response(snapshot.health) })
    mocks.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { pid: 322, unref: vi.fn() }); online = true; void Promise.resolve().then(() => child.emit('spawn')); return child })
    await service.control('start')
    expect(await readFile(join(configurationDirectory, 'appsettings.json'), 'utf8')).toBe(original)
  })
  it('waits for its old process to exit before restarting', async () => {
    const serverPath = join(mocks.directory, 'MyAgent.Server.exe'), configurationDirectory = join(mocks.directory, 'server')
    await writeFile(serverPath, '')
    await service.saveLaunch({ mode: 'process', serverPath, configurationDirectory })
    let online = false, child: EventEmitter
    fetcher.mockImplementation(async url => {
      if (String(url).endsWith('/server/shutdown')) { online = false; setTimeout(() => child.emit('exit', 0), 10); return response(undefined, 202) }
      if (!online) throw new Error('offline')
      return response(snapshot.health)
    })
    mocks.spawn.mockImplementation(() => { child = Object.assign(new EventEmitter(), { pid: 323, unref: vi.fn() }); online = true; void Promise.resolve().then(() => child.emit('spawn')); return child })
    await service.control('start'); await service.control('restart')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })
  it.skipIf(process.platform !== 'win32')('waits for the Windows service to stop before restarting, even if its listener is already offline', async () => {
    let state = 'running', stopChecks = 0
    mocks.execute.mockImplementation(async (_file, args) => {
      if (args[0] === 'query') {
        if (state === 'stopping' && ++stopChecks >= 2) state = 'stopped'
        return { stdout: `STATE : ${state === 'running' ? 4 : state === 'stopped' ? 1 : 3}` }
      }
      if (args[0] === 'stop') state = 'stopping'
      if (args[0] === 'start') { expect(state).toBe('stopped'); state = 'running' }
      return { stdout: '' }
    })
    fetcher.mockImplementation(async () => { if (state !== 'running') throw new Error('offline'); return response(snapshot.health) })
    await service.control('restart')
    expect(stopChecks).toBeGreaterThanOrEqual(2)
    expect(mocks.execute.mock.calls.filter(([, args]) => args[0] !== 'query').map(([, args]) => args[0])).toEqual(['stop', 'start'])
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('does not launch a duplicate or shut down an external process it cannot restart', async () => {
    await service.control('start')
    expect(mocks.spawn).not.toHaveBeenCalled()
    await service.saveLaunch({ mode: 'process', serverPath: '', configurationDirectory: join(mocks.directory, 'server') })
    await expect(service.control('restart')).rejects.toThrow('executable')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/shutdown'))).toBe(false)
  })
  it('denies foreign frames, non-workspace callers, and unknown administration actions', async () => {
    const sender = { mainFrame: {} }, handlerOptions = { connection: async () => connection, isHomeSender: () => true }
    registerMyAgentSettingsIpc(handlerOptions)
    const handler = mocks.handlers.get(MYAGENT_SETTINGS_CHANNEL)!
    await expect(handler({ sender, senderFrame: {} }, 'generateKey')).rejects.toThrow('workspace')
    await expect(handler({ sender, senderFrame: sender.mainFrame }, 'execute')).rejects.toThrow('Unknown')
    const generated = await handler({ sender, senderFrame: sender.mainFrame }, 'generateKey')
    expect(generated).toMatch(/^[a-f0-9]{64}$/)
    registerMyAgentSettingsIpc({ ...handlerOptions, isHomeSender: () => false })
    await expect(mocks.handlers.get(MYAGENT_SETTINGS_CHANNEL)!({ sender, senderFrame: sender.mainFrame }, 'generateKey')).rejects.toThrow('workspace')
  })
})
