import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { myAgentUrl } from '../rag/config'
import { MYAGENT_SETTINGS_CHANNEL, type MyAgentConfiguration, type MyAgentDiagnostics, type MyAgentReadiness, type MyAgentHealth, type MyAgentProfile, type MyAgentRuntime, type MyAgentSnapshot, type MyAgentSaveResult, type MyAgentLocalView, type MyAgentLaunchSettings } from '../../shared/myagent-settings-api'
import { launchSettings, object, revision, sanitize, updateConfiguration } from './configuration'
import type { MyAgentDocumentTools } from '../../shared/myagent-settings-api'
import type { MyAgentToolCatalog } from '../../shared/myagent-tools-api'

interface Connection { serverUrl: string; apiKey: string; timeoutMs: number }
interface Options { connection(): Promise<Connection>; isHomeSender(sender: WebContents): boolean }
const execute = promisify(execFile)
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export class MyAgentSettingsService {
  private launch: MyAgentLaunchSettings | undefined
  private child: ChildProcess | undefined
  private busy = false
  private path = join(app.getPath('userData'), 'myagent', 'launch-v1.json')
  constructor(private options: Options, private fetcher: typeof fetch = fetch) {}
  private async connection(): Promise<Connection> {
    const value = await this.options.connection()
    return { ...value, serverUrl: myAgentUrl(value.serverUrl) }
  }
  private async request<T>(connection: Connection, route: string, method = 'GET', body?: unknown, timeout = 30000): Promise<T> {
    const secrets = [connection.apiKey, (body as { provider?: { apiKey?: string }; rag?: { embeddingApiKey?: string } })?.provider?.apiKey ?? '', (body as { rag?: { embeddingApiKey?: string } })?.rag?.embeddingApiKey ?? '']
    try {
      const response = await this.fetcher(connection.serverUrl + '/api/v1/' + route, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeout), cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-MyAgent-Client-Id': 'nawa-settings', ...(connection.apiKey ? { 'X-MyAgent-Key': connection.apiKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0
      if (reader) try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw new Error('MyAgent settings response exceeds 1 MiB.'); parts.push(value) }
      } catch (e) { await reader.cancel().catch(() => {}); throw e } finally { reader.releaseLock() }
      const raw = Buffer.concat(parts).toString('utf8')
      if (response.status === 401) throw new Error('MyAgent authentication failed. Save its administrator service API key in Connection.')
      if (response.status === 403) throw new Error('MyAgent administrator access is required. Use the service API key; configuration access must allow localhost.')
      if (response.status === 404) throw new Error(`MyAgent does not expose /api/v1/${route}. Update and restart MyAgent.`)
      let value: unknown
      try { value = raw ? JSON.parse(raw) : undefined } catch { throw new Error(`MyAgent returned invalid JSON (HTTP ${response.status}).`) }
      if (!response.ok) throw new Error(`MyAgent HTTP ${response.status}: ${String((value as { message?: string })?.message ?? 'Request failed').slice(0, 1000)}`)
      return sanitize(value, secrets) as T
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('MyAgent request timed out. Check server status and retry.')
      if (error instanceof TypeError && error.message === 'fetch failed') throw new Error(`Could not reach MyAgent at ${connection.serverUrl}. Start the server or check Connection.`)
      throw new Error(sanitize(error instanceof Error ? error.message : String(error), secrets))
    }
  }
  private configuration(value: unknown): MyAgentConfiguration {
    const r = object(value)
    if (!r.provider || !r.rag || !r.llama || !Array.isArray(object(r.rag).roots)) throw new Error('MyAgent returned an unsupported configuration. Update the server.')
    return value as MyAgentConfiguration
  }
  private async inspectConnection(connection: Connection): Promise<MyAgentSnapshot> {
    const health = await this.request<MyAgentHealth>(connection, 'health')
    if (!health || typeof health.status !== 'string' || !Array.isArray(health.capabilities)) throw new Error('MyAgent health response is invalid.')
    const results = await Promise.allSettled([
      this.request<MyAgentConfiguration>(connection, 'config').then(value => this.configuration(value)),
      this.request<MyAgentProfile[]>(connection, 'llama/profiles'),
      this.request<MyAgentRuntime[]>(connection, 'llama/status'),
    ])
    const [config, profiles, runtimes] = results
    const configuration = config.status === 'fulfilled' ? config.value : null
    return { serverUrl: connection.serverUrl, health, configuration, revision: configuration ? revision(configuration) : '',
      profiles: profiles.status === 'fulfilled' && Array.isArray(profiles.value) ? profiles.value : [],
      runtimes: runtimes.status === 'fulfilled' && Array.isArray(runtimes.value) ? runtimes.value.map(r => ({ profileId: r.profileId, state: r.state, displayName: r.displayName, error: r.error })) : [],
      warnings: results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message),
    }
  }
  async inspect(): Promise<MyAgentSnapshot> { return this.inspectConnection(await this.connection()) }
  /** Tool definitions only: no manifests, document IDs, or file content are requested. */
  async documentTools(raw: unknown): Promise<MyAgentDocumentTools> {
    const input = object(raw)
    if (typeof input.query !== 'string' || input.query.length > 256 || !Number.isInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > 10000)
      throw new Error('Use a tool query of at most 256 characters and an offset between 0 and 10000.')
    if (input.extensions !== undefined && (!Array.isArray(input.extensions) || input.extensions.length > 100 || input.extensions.some(extension => typeof extension !== 'string' || !/^\.[a-zA-Z0-9]{1,31}$/.test(extension))))
      throw new Error('Supply at most 100 file extensions such as .xlsx or .pdf.')
    const extensions = input.extensions === undefined ? undefined : [...new Set((input.extensions as string[]).map(extension => extension.toLowerCase()))]
    const connection = await this.connection()
    const result = await this.request<MyAgentToolCatalog>(connection, 'rag/tools/catalog', 'POST', {
      query: input.query.trim(), offset: input.offset, limit: 20, namesOnly: false, ...(extensions ? { extensions } : {}),
    }, Math.min(connection.timeoutMs, 10000))
    if (!result || result.scopeChecked !== false || !Array.isArray(result.sources) || result.sources.length ||
        extensions !== undefined && result.selectionFiltered !== true || !Array.isArray(result.tools) || result.tools.length > 20 ||
        !Number.isInteger(result.total) || result.total < result.tools.length || result.total > 10000 ||
        result.nextOffset != null && (!Number.isInteger(result.nextOffset) || result.nextOffset <= (input.offset as number) || result.nextOffset > result.total) ||
        result.tools.some(tool => !tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(tool.name) || typeof tool.description !== 'string' || tool.description.length > 16000 || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)))
      throw new Error('MyAgent returned an invalid metadata-only tool catalog. Update the server and retry.')
    return { serverUrl: connection.serverUrl, checkedAt: new Date().toISOString(), tools: result.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), total: result.total, nextOffset: result.nextOffset ?? null, filtered: extensions !== undefined }
  }
  /** A live provider probe runs only when the user requests diagnostics. It never starts a model. */
  async diagnostics(): Promise<MyAgentDiagnostics> {
    const connection = await this.connection(), timeout = Math.min(connection.timeoutMs, 10000)
    const results = await Promise.allSettled([
      this.request<MyAgentHealth>(connection, 'health', 'GET', undefined, timeout).then(value => {
        if (!value || typeof value.status !== 'string' || !Array.isArray(value.capabilities)) throw new Error('MyAgent health response is invalid.')
        return value
      }),
      this.request<MyAgentReadiness>(connection, 'readiness', 'GET', undefined, timeout).then(value => {
        if (!value || typeof value.ready !== 'boolean' || typeof value.status !== 'string') throw new Error('MyAgent readiness response is invalid.')
        return value
      }),
    ])
    return { serverUrl: connection.serverUrl, checkedAt: new Date().toISOString(),
      health: results[0].status === 'fulfilled' ? results[0].value : null,
      readiness: results[1].status === 'fulfilled' ? results[1].value : null,
      warnings: results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message),
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Another MyAgent settings action is running. Wait for it to finish.')
    this.busy = true
    try { return await action() } finally { this.busy = false }
  }
  async saveConfiguration(serverUrl: unknown, expected: unknown, raw: unknown): Promise<MyAgentSaveResult> {
    return this.exclusive(async () => {
      const connection = await this.connection()
      if (serverUrl !== connection.serverUrl) throw new Error('The MyAgent connection changed. Refresh server settings before saving.')
      const current = this.configuration(await this.request(connection, 'config'))
      if (typeof expected !== 'string' || expected !== revision(current)) throw new Error('MyAgent settings changed elsewhere. Refresh before saving; your draft has been retained.')
      if (Buffer.byteLength(JSON.stringify(raw)) > 256000) throw new Error('MyAgent settings are too large.')
      const body = updateConfiguration(current, raw)
      const result = await this.request<{ configuration: MyAgentConfiguration; restartRequired: boolean; restartRequiredSettings: string[] }>(connection, 'config', 'PUT', body)
      if (typeof result?.restartRequired !== 'boolean' || !Array.isArray(result.restartRequiredSettings)) throw new Error('MyAgent saved settings but returned an unsupported result. Refresh server settings.')
      let applied = false, warning: string | undefined
      if (!result.restartRequired) {
        try {
          const live = await this.request<{ applied: boolean; error?: string }>(connection, 'server/reload-configuration', 'POST')
          applied = live.applied === true
          if (!applied) warning = live.error || 'Settings were saved but could not be applied. Restart MyAgent.'
        } catch (e) { warning = `Settings were saved. Live application failed: ${(e as Error).message}` }
      }
      // A saved configuration remains reviewable even if optional runtime status refresh fails.
      const snapshot = await this.inspectConnection(connection).catch(() => ({ serverUrl: connection.serverUrl, health: { status: 'unknown', version: '', providerConfigured: false, capabilities: [] }, configuration: this.configuration(result.configuration), revision: revision(result.configuration), profiles: [], runtimes: [], warnings: ['Settings were saved. Refresh server status.'] }))
      return { snapshot, restartRequired: result.restartRequired, restartRequiredSettings: result.restartRequiredSettings, applied, warning }
    })
  }
  private async loadLaunch(): Promise<MyAgentLaunchSettings> {
    if (this.launch) return this.launch
    try { return this.launch = launchSettings(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return this.launch = { mode: process.platform === 'win32' ? 'service' : 'process', serverPath: '', configurationDirectory: join(app.getPath('appData'), 'MyAgent', 'server') }
  }
  private async serviceState(): Promise<MyAgentLocalView['serviceState']> {
    if (process.platform !== 'win32') return 'not-installed'
    try {
      const { stdout } = await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'), ['query', 'MyAgentServer'], { windowsHide: true, timeout: 5000, maxBuffer: 64000 })
      const state = stdout.match(/STATE\s*:\s*(\d+)/)?.[1]
      return state === '4' ? 'running' : state === '1' ? 'stopped' : 'pending'
    } catch (e) { if ((e as { code?: number }).code === 1060) return 'not-installed'; return 'unavailable' }
  }
  async local(): Promise<MyAgentLocalView> {
    return { settings: await this.loadLaunch(), serviceState: await this.serviceState(), processId: this.child?.pid ?? null }
  }
  async saveLaunch(raw: unknown): Promise<MyAgentLocalView> {
    return this.exclusive(async () => {
      const next = launchSettings(raw)
      if (this.child && JSON.stringify(next) !== JSON.stringify(await this.loadLaunch())) throw new Error('Stop the Nawa-managed server before changing its launch paths.')
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = join(dirname(this.path), `launch-${randomUUID()}.tmp`)
      try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path); this.launch = next }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
      return this.local()
    })
  }
  private async wait(connection: Connection, running: boolean): Promise<void> {
    const until = Date.now() + 20000
    while (Date.now() < until) {
      let online = false
      try { const health = await this.request<MyAgentHealth>(connection, 'health', 'GET', undefined, 2000); online = typeof health?.status === 'string' } catch {}
      if (online === running) return
      await delay(300)
    }
    throw new Error(running ? 'MyAgent has not become ready yet. Refresh status; check its configuration and server logs.' : 'MyAgent is still responding. Refresh status before starting another server.')
  }
  private async waitServiceStopped(): Promise<void> {
    const until = Date.now() + 20000
    while (Date.now() < until) {
      const state = await this.serviceState()
      if (state === 'stopped') return
      if (state === 'unavailable' || state === 'not-installed') throw new Error('Cannot confirm MyAgentServer stopped. Refresh Windows service status before restarting.')
      await delay(300)
    }
    throw new Error('MyAgentServer is still shutting down. Refresh status before restarting it.')
  }
  private async start(connection: Connection, local: MyAgentLocalView): Promise<void> {
    try { const health = await this.request<MyAgentHealth>(connection, 'health', 'GET', undefined, 2000); if (health?.status) return } catch {}
    if (local.settings.mode === 'service') {
      if (local.serviceState === 'not-installed') throw new Error('MyAgentServer is not installed as a Windows service. Choose Server process and select its executable, or install it using MyAgent setup.')
      if (local.serviceState === 'unavailable') throw new Error('Cannot inspect MyAgentServer. Check Windows service permissions.')
      if (local.serviceState !== 'running' && local.serviceState !== 'pending') await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'), ['start', 'MyAgentServer'], { windowsHide: true, timeout: 10000, maxBuffer: 64000 }).catch(() => { throw new Error('Could not start MyAgentServer. Check Windows service permissions in MyAgent setup.') })
    } else {
      if (this.child) throw new Error('The Nawa-managed MyAgent process is still starting. Refresh status before starting it again.')
      const { serverPath, configurationDirectory } = local.settings
      if (!serverPath) throw new Error('Select and save MyAgent.Server.exe or MyAgent.Server.dll first.')
      const file = await lstat(serverPath)
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Select an ordinary MyAgent server executable.')
      await mkdir(configurationDirectory, { recursive: true })
      const configurationPath = join(configurationDirectory, 'appsettings.json')
      try {
        const config = await lstat(configurationPath)
        if (!config.isFile() || config.isSymbolicLink()) throw new Error('The MyAgent configuration must be an ordinary appsettings.json file.')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        if (!connection.apiKey) throw new Error('Enter or generate and save a service API key before creating a new server configuration.')
        await writeFile(configurationPath, JSON.stringify({ Urls: connection.serverUrl, MyAgent: { ApiKey: connection.apiKey, AllowUnauthenticatedLoopback: false, MigrateLegacyData: false, Provider: {}, Rag: { Roots: [] } } }, null, 2), { flag: 'wx', mode: 0o600 })
      }
      const assembly = basename(serverPath).toLowerCase().endsWith('.dll')
      const args = [...(assembly ? [serverPath] : []), '--contentRoot', configurationDirectory, '--MyAgentDataRoot', configurationDirectory]
      const child = spawn(assembly ? 'dotnet' : serverPath, args, { cwd: dirname(serverPath), windowsHide: true, detached: true, stdio: 'ignore', shell: false })
      this.child = child
      child.once('exit', () => { if (this.child === child) this.child = undefined })
      child.once('error', () => { if (this.child === child) this.child = undefined })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Could not launch MyAgent. Check its installation and .NET runtime.'))) })
      child.unref()
    }
    await this.wait(connection, true)
  }
  private async stop(connection: Connection, local: MyAgentLocalView): Promise<void> {
    if (local.settings.mode === 'service' && local.serviceState !== 'not-installed') {
      if (local.serviceState === 'unavailable') throw new Error('Cannot inspect MyAgentServer. Check Windows service permissions.')
      if (local.serviceState !== 'stopped') await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'), ['stop', 'MyAgentServer'], { windowsHide: true, timeout: 10000, maxBuffer: 64000 }).catch(() => { throw new Error('Could not stop MyAgentServer. Check Windows service permissions in MyAgent setup.') })
      await this.waitServiceStopped()
    } else {
      try { await this.request(connection, 'server/shutdown', 'POST') }
      catch (error) { if (this.child) this.child.kill(); else throw error }
    }
    await this.wait(connection, false)
    // The listener can stop before the process finishes releasing its databases/models.
    const until = Date.now() + 10000
    while (this.child && Date.now() < until) await delay(100)
    if (this.child) throw new Error('The Nawa-managed process is still shutting down. Refresh status before restarting it.')
  }
  async control(action: unknown): Promise<{ message: string }> {
    if (!['start', 'stop', 'restart'].includes(action as string)) throw new Error('Unknown MyAgent service action.')
    return this.exclusive(async () => {
      const connection = await this.connection(), local = await this.local()
      if (action === 'restart' && local.settings.mode === 'process' && !local.settings.serverPath) throw new Error('Save the server executable and configuration directory before restarting an externally started process.')
      if (action === 'stop' || action === 'restart') await this.stop(connection, local)
      if (action === 'start' || action === 'restart') await this.start(connection, await this.local())
      return { message: action === 'stop' ? 'MyAgent stopped.' : action === 'restart' ? 'MyAgent restarted.' : 'MyAgent is running.' }
    })
  }
  async model(action: unknown, profileId: unknown): Promise<MyAgentRuntime> {
    if ((action !== 'start' && action !== 'stop') || typeof profileId !== 'string' || profileId.length > 256) throw new Error('Invalid MyAgent model action.')
    return this.exclusive(async () => {
      const connection = await this.connection(), profiles = await this.request<MyAgentProfile[]>(connection, 'llama/profiles')
      if (!Array.isArray(profiles) || !profiles.some(p => p.id === profileId)) throw new Error('Model runtime is no longer available. Refresh the server.')
      const runtime = await this.request<MyAgentRuntime>(connection, `llama/${encodeURIComponent(profileId)}/${action}`, 'POST', undefined, 180000)
      return { profileId: runtime.profileId, state: runtime.state, displayName: runtime.displayName, error: runtime.error }
    })
  }
}
export function registerMyAgentSettingsIpc(options: Options): MyAgentSettingsService {
  const service = new MyAgentSettingsService(options)
  ipcMain.handle(MYAGENT_SETTINGS_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) throw new Error('MyAgent settings are available only from the Nawa workspace.')
    switch (action) {
      case 'inspect': return service.inspect()
      case 'diagnostics': return service.diagnostics()
      case 'documentTools': return service.documentTools(args[0])
      case 'saveConfiguration': return service.saveConfiguration(args[0], args[1], args[2])
      case 'local': return service.local()
      case 'saveLaunch': return service.saveLaunch(args[0])
      case 'generateKey': return randomBytes(32).toString('hex')
      case 'control': return service.control(args[0])
      case 'model': return service.model(args[0], args[1])
      case 'choosePath': {
        if (args[0] !== 'server' && args[0] !== 'directory') throw new Error('Choose a server executable or configuration directory.')
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) throw new Error('The Nawa workspace has closed.')
        const result = await dialog.showOpenDialog(win, { title: args[0] === 'server' ? 'Choose MyAgent server' : 'Choose MyAgent configuration directory', properties: args[0] === 'server' ? ['openFile'] : ['openDirectory', 'createDirectory'], ...(args[0] === 'server' ? { filters: [{ name: 'MyAgent server', extensions: ['exe', 'dll'] }] } : {}) })
        return result.canceled ? null : result.filePaths[0] ?? null
      }
      default: throw new Error('Unknown MyAgent settings action.')
    }
  })
  return service
}
