import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises'
import { isAbsolute, join, dirname, extname, relative, sep } from 'node:path'
import { createServer } from 'node:net'
import type {
  LocalModelsConfig,
  LocalModelsSnapshot,
  LocalModelRuntime,
  LocalModelProfile,
} from '../../shared/local-models-api'
import { validateLocalModels, localModelArguments } from '../../shared/local-model-command'
import { ModelDownloads } from './downloads'

interface Runtime {
  view: LocalModelRuntime
  child?: ChildProcess
  abort: AbortController
}
interface Options {
  spawn?: typeof spawn
  fetch?: typeof fetch
  readyTimeoutMs?: number
  pollMs?: number
}
const revision = (config: LocalModelsConfig) =>
  createHash('sha256').update(JSON.stringify(config)).digest('hex')
export async function checkGguf(path: string): Promise<void> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.gguf')
    throw new Error('Choose an absolute GGUF model path.')
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('Choose a regular GGUF file.')
    const header = Buffer.alloc(8)
    const { bytesRead } = await file.read(header, 0, 8, 0)
    if (
      bytesRead !== 8 ||
      header.toString('ascii', 0, 4) !== 'GGUF' ||
      ![2, 3].includes(header.readUInt32LE(4))
    )
      throw new Error('The file is not a supported GGUF model.')
  } finally {
    await file.close()
  }
}
async function availablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', () =>
      reject(new Error(`Port ${port} is already in use. Choose another port.`)),
    )
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
}
export class LocalModelsService {
  private config?: LocalModelsConfig
  private queue: Promise<unknown> = Promise.resolve()
  private runtimes = new Map<string, Runtime>()
  private closed = false
  readonly downloads: ModelDownloads
  constructor(
    readonly directory: string,
    private options: Options = {},
  ) {
    this.downloads = new ModelDownloads(directory, options.fetch)
  }
  private async load(): Promise<LocalModelsConfig> {
    if (this.config) return this.config
    try {
      this.config = validateLocalModels(
        JSON.parse(await readFile(join(this.directory, 'settings-v1.json'), 'utf8')),
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Local model settings could not be read. Restore settings-v1.json before saving.',
          { cause: e },
        )
      this.config = { executablePath: '', profiles: [] }
    }
    return this.config
  }
  async inspect(): Promise<LocalModelsSnapshot> {
    const config = await this.load()
    const models = await this.downloads.models()
    return {
      config: structuredClone(config),
      revision: revision(config),
      runtimes: config.profiles.map((p) =>
        structuredClone(this.runtimes.get(p.id)?.view ?? { id: p.id, state: 'stopped', logs: '' }),
      ),
      models,
      engines: await this.downloads.engines(),
      directory: this.directory,
      download: { ...this.downloads.progress },
    }
  }
  save(raw: unknown, expected: unknown): Promise<LocalModelsSnapshot> {
    const run = async () => {
      if (this.closed) throw new Error('Nawa is shutting down.')
      const current = await this.load(),
        next = validateLocalModels(raw)
      if (expected !== revision(current))
        throw new Error('Local model settings changed. Refresh before saving.')
      for (const p of current.profiles) {
        if (
          ['starting', 'running', 'stopping'].includes(this.runtimes.get(p.id)?.view.state ?? '') &&
          (current.executablePath !== next.executablePath ||
            JSON.stringify(p) !== JSON.stringify(next.profiles.find((n) => n.id === p.id)))
        )
          throw new Error('Stop the affected runtime before changing or deleting its profile.')
      }
      if (
        next.executablePath &&
        (!isAbsolute(next.executablePath) ||
          !(await stat(next.executablePath)).isFile() ||
          (process.platform === 'win32' && extname(next.executablePath).toLowerCase() !== '.exe'))
      )
        throw new Error('Choose a llama-server executable.')
      for (const p of next.profiles) if (p.modelPath) await checkGguf(p.modelPath)
      await mkdir(this.directory, { recursive: true })
      const temp = join(this.directory, `settings-${randomUUID()}.tmp`)
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 })
        await rename(temp, join(this.directory, 'settings-v1.json'))
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
      this.config = next
      return this.inspect()
    }
    const task = this.queue.then(run, run)
    this.queue = task.catch(() => {})
    return task
  }
  async start(id: string): Promise<void> {
    await this.queue
    const config = await this.load(),
      profile = config.profiles.find((p) => p.id === id)
    if (this.closed) throw new Error('Nawa is shutting down.')
    if (!profile) throw new Error('Save the model profile first.')
    if (['starting', 'running', 'stopping'].includes(this.runtimes.get(id)?.view.state ?? ''))
      throw new Error('This runtime is already active.')
    const runtime: Runtime = {
      view: { id, state: 'starting', logs: '' },
      abort: new AbortController(),
    }
    this.runtimes.set(id, runtime)
    try {
      if (!isAbsolute(config.executablePath) || !(await stat(config.executablePath)).isFile())
        throw new Error('Choose and save llama-server first.')
      await checkGguf(profile.modelPath)
      await availablePort(profile.port)
      if (this.closed || runtime.abort.signal.aborted) throw new Error('Runtime start canceled.')
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('LLAMA_ARG_') && key !== 'ELECTRON_RUN_AS_NODE',
        ),
      )
      const child = (this.options.spawn ?? spawn)(
        config.executablePath,
        localModelArguments(profile),
        {
          cwd: dirname(config.executablePath),
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      )
      runtime.child = child
      runtime.view.pid = child.pid
      const log = (chunk: Buffer) => {
        runtime.view.logs =
          // eslint-disable-next-line no-control-regex -- Strip terminal color sequences from subprocess logs.
          (runtime.view.logs + chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(
            -32000,
          )
      }
      child.stdout?.on('data', log)
      child.stderr?.on('data', log)
      child.once('error', (error) => {
        runtime.view.state = 'failed'
        runtime.view.error = error.message
        runtime.abort.abort()
      })
      child.once('exit', (code, signal) => {
        const stopping = runtime.view.state === 'stopping'
        runtime.abort.abort()
        runtime.child = undefined
        delete runtime.view.pid
        if (stopping) runtime.view.state = 'stopped'
        else {
          runtime.view.state = 'failed'
          runtime.view.error ??= `llama-server exited (${code ?? signal ?? 'unknown'}). See runtime logs.`
        }
      })
      void this.waitForReady(profile, runtime)
    } catch (error) {
      runtime.view.state = runtime.abort.signal.aborted ? 'stopped' : 'failed'
      runtime.view.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
  private async waitForReady(profile: LocalModelProfile, runtime: Runtime): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 180000)
    while (!runtime.abort.signal.aborted && Date.now() < deadline) {
      try {
        const response = await (this.options.fetch ?? fetch)(
          `http://127.0.0.1:${profile.port}/health`,
          {
            redirect: 'error',
            signal: AbortSignal.any([runtime.abort.signal, AbortSignal.timeout(2000)]),
          },
        )
        const value = (await response.json()) as { status?: string }
        if (
          response.ok &&
          value.status === 'ok' &&
          runtime.child &&
          !runtime.abort.signal.aborted
        ) {
          runtime.view.state = 'running'
          return
        }
      } catch {
        /* Loading or the process has not bound its port yet. */
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          runtime.abort.signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, this.options.pollMs ?? 500)
        runtime.abort.signal.addEventListener('abort', finish, { once: true })
        if (runtime.abort.signal.aborted) finish()
      })
    }
    if (!runtime.abort.signal.aborted) {
      runtime.view.error =
        'Model loading timed out. Check runtime logs and available RAM / GPU memory.'
      await this.stop(profile.id)
      runtime.view.state = 'failed'
    }
  }
  async stop(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.view.state = 'stopping'
    runtime.abort.abort()
    const child = runtime.child
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.once('error', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill()
      })
    runtime.view.state = 'stopped'
    delete runtime.view.pid
  }
  async autoStart(): Promise<void> {
    const config = await this.load()
    for (const profile of config.profiles.filter((p) => p.autoStart)) {
      if (this.closed) break
      await this.start(profile.id).catch(() => {})
    }
  }
  dispose(): void {
    this.closed = true
    this.downloads.cancel()
    for (const runtime of this.runtimes.values()) {
      runtime.abort.abort()
      runtime.child?.kill('SIGKILL')
    }
  }
  removeModel(path: unknown): Promise<LocalModelsSnapshot> {
    const run = async () => {
      const config = await this.load(),
        root = join(this.directory, 'models')
      const files = await this.downloads.models()
      if (typeof path !== 'string' || !files.some((file) => file.path === path))
        throw new Error('Only models downloaded by Nawa can be deleted here.')
      const packageId = relative(root, path).split(sep)[0]
      if (!/^[a-f0-9-]{36}$/.test(packageId)) throw new Error('Invalid managed model directory.')
      const packagePath = join(root, packageId)
      if (
        config.profiles.some((p) =>
          p.modelPath.toLowerCase().startsWith((packagePath + sep).toLowerCase()),
        )
      )
        throw new Error('Remove this model from its saved profiles first.')
      await rm(packagePath, { recursive: true })
      return this.inspect()
    }
    const task = this.queue.then(run, run)
    this.queue = task.catch(() => {})
    return task
  }
}
