import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, rm, readdir, statfs, stat } from 'node:fs/promises'
import { join, dirname, resolve, sep, basename } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import JSZip from 'jszip'
import { findLibreOffice } from '@genoffice/electron-utils/legacy-office'
import type { RuntimeSetupOptions, RuntimeSetupSnapshot } from '../../shared/runtime-setup-api'
import type { LocalModelProfile } from '../../shared/local-models-api'
import { localModelArguments } from '../../shared/local-model-command'
import { LocalModelsService } from '../local-models/service'
import { safeArchivePath } from '../local-models/downloads'
import {
  MODEL_ASSETS,
  engineAsset,
  engineAssets,
  officeAsset,
  vcAsset,
  type SetupAsset,
} from './assets'
import { downloadAsset } from './download'

interface Saved {
  dismissed?: boolean
  installed?: boolean
  needsActivation?: boolean
  activationKinds?: LocalModelProfile['kind'][]
  office?: string
  profileIds?: string[]
}
interface Options {
  packaged?: boolean
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  ocrAvailable(): boolean
  run?: typeof runSetupProcess
  assets?: SetupAsset[]
  engines?: typeof engineAssets
  needsVc?: () => boolean
}
export async function runSetupProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout = 600000,
): Promise<string> {
  signal.throwIfAborted()
  return new Promise((done, reject) => {
    // Windows Installer parses property assignments before ordinary argv quoting.
    // Quote the property value, rather than the entire TARGETDIR=... argument.
    const windowsInstaller =
      process.platform === 'win32' && basename(executable).toLowerCase() === 'msiexec.exe'
    const commandArgs = windowsInstaller
      ? args.map((arg) => {
          if (/["\r\n\0]/.test(arg)) throw new Error('Invalid Windows Installer argument.')
          const property = /^([A-Z_]+)=(.*)$/.exec(arg)
          return property ? `${property[1]}="${property[2]}"` : /\s/.test(arg) ? `"${arg}"` : arg
        })
      : args
    const child = spawn(executable, commandArgs, {
      windowsHide: true,
      windowsVerbatimArguments: windowsInstaller,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      finished = false
    const stop = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, stdio: 'ignore' },
        )
        killer.on('error', () => child.kill())
      } else child.kill()
    }
    const timer = setTimeout(stop, timeout)
    const abort = () => stop()
    signal.addEventListener('abort', abort, { once: true })
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (signal.aborted) reject(new Error('Setup canceled.'))
      else done(output)
    }
    child.stdout?.on('data', (data) => {
      output = (output + data.toString()).slice(-8000)
    })
    child.stderr?.on('data', (data) => {
      output = (output + data.toString()).slice(-8000)
    })
    child.once('error', finish)
    child.once('exit', (code) =>
      finish(
        code === 0 || code === 3010 || code === 1638
          ? undefined
          : new Error(`Dependency setup exited with code ${code}. ${output}`),
      ),
    )
  })
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
async function freePort(preferred: number, excluded: number[]): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (excluded.includes(port)) continue
    const available = await new Promise<boolean>((done) => {
      const server = createServer()
      server.once('error', () => done(false))
      server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
    })
    if (available) return port
  }
  throw new Error('No local model port is available. Stop unused servers and retry.')
}
async function officeIn(directory: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const name of ['soffice.com', 'soffice.exe']) {
    if (entries.some((entry) => entry.isFile() && entry.name === name)) return join(directory, name)
  }
  for (const entry of entries)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const path = await officeIn(join(directory, entry.name), depth + 1)
      if (path) return path
    }
  return null
}
export class RuntimeSetupService {
  readonly directory: string
  private saved: Saved = {}
  private initialized?: Promise<void>
  private abort?: AbortController
  private state: RuntimeSetupSnapshot['state'] = 'idle'
  private stage = ''
  private received = 0
  private total = 0
  private error?: string
  constructor(
    private userData: string,
    private models: LocalModelsService,
    private options: Options,
  ) {
    this.directory = join(userData, 'setup')
  }
  private initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      try {
        this.saved = JSON.parse(
          await readFile(join(this.directory, 'settings-v1.json'), 'utf8'),
        ) as Saved
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (this.saved.installed) this.state = 'ready'
      const office = this.saved.office
      if (
        office &&
        resolve(office).startsWith(resolve(this.userData, 'dependencies') + sep) &&
        existsSync(office)
      )
        process.env.NAWA_LIBREOFFICE_PATH ??= office
    })())
  }
  private persist() {
    return writeJson(join(this.directory, 'settings-v1.json'), this.saved)
  }
  async inspect(): Promise<RuntimeSetupSnapshot> {
    await this.initialize()
    const local = await this.models.inspect()
    const supported =
      (this.options.platform ?? process.platform) === 'win32' &&
      ['x64', 'arm64'].includes(this.options.arch ?? process.arch)
    return {
      supported,
      offer:
        supported &&
        !!this.options.packaged &&
        !this.saved.dismissed &&
        (!local.config.profiles.length || !!this.saved.needsActivation),
      state: this.state,
      stage: this.stage,
      received: this.received,
      total: this.total,
      error: this.error,
      directory: this.directory,
      ocr: this.options.ocrAvailable(),
      office: await findLibreOffice(),
      needsActivation: !!this.saved.needsActivation,
      activationKinds: this.saved.needsActivation
        ? (this.saved.activationKinds ??
          local.config.profiles
            .filter((profile) => this.saved.profileIds?.includes(profile.id))
            .map((profile) => profile.kind))
        : [],
      runtime:
        local.config.executablePath && existsSync(local.config.executablePath)
          ? local.config.executablePath
          : null,
      reuseRuntime: !!local.config.executablePath && !this.ownedEngine(local.config.executablePath),
      profiles: local.config.profiles.filter((profile) =>
        this.saved.profileIds?.includes(profile.id),
      ),
    }
  }
  async dismiss(): Promise<void> {
    await this.initialize()
    this.saved.dismissed = true
    await this.persist()
  }
  async activated(raw?: unknown): Promise<void> {
    await this.initialize()
    if (
      raw !== undefined &&
      (!Array.isArray(raw) || raw.some((kind) => !['chat', 'embedding'].includes(kind)))
    )
      throw new Error('Choose valid model roles to activate.')
    const pending = (await this.inspect()).activationKinds
    this.saved.activationKinds =
      raw === undefined ? [] : pending.filter((kind) => !(raw as string[]).includes(kind))
    this.saved.needsActivation = this.saved.activationKinds.length > 0
    this.saved.dismissed = !this.saved.needsActivation
    await this.persist()
  }
  cancel(): void {
    this.abort?.abort()
  }
  private ownedEngine(path: string): boolean {
    return resolve(path)
      .toLowerCase()
      .startsWith(
        (resolve(this.userData, 'local-models', 'engines') + sep + 'default-b11541-').toLowerCase(),
      )
  }
  private async asset(asset: SetupAsset, path: string, signal: AbortSignal): Promise<string> {
    this.stage = asset.id
    this.received = 0
    this.total = asset.bytes
    await downloadAsset(
      asset,
      path,
      signal,
      (received, total) => {
        this.received = received
        this.total = total
      },
      this.options.fetch,
    )
    return path
  }
  async install(raw: unknown): Promise<RuntimeSetupSnapshot> {
    await this.initialize()
    if (this.abort) throw new Error('Setup is already running.')
    if (!(await this.inspect()).supported)
      throw new Error('Automatic dependency setup currently supports Windows x64 and ARM64.')
    const input = raw as RuntimeSetupOptions
    if (
      !input ||
      !['cuda', 'cpu', 'vulkan'].includes(input.backend) ||
      ['chatModel', 'embeddingModel', 'runtime', 'office', 'startModels', 'useDefaults'].some(
        (key) => typeof (input as unknown as Record<string, unknown>)[key] !== 'boolean',
      ) ||
      (!input.chatModel && !input.embeddingModel && !input.runtime && !input.office)
    )
      throw new Error(
        'Choose a chat model, embedding model, llama.cpp runtime or Office conversion to install.',
      )
    if (this.abort) throw new Error('Setup is already running.')
    const controller = (this.abort = new AbortController()),
      signal = controller.signal
    const started: string[] = []
    this.state = 'installing'
    this.error = undefined
    try {
      await mkdir(this.directory, { recursive: true })
      const run = this.options.run ?? runSetupProcess,
        arch = this.options.arch ?? process.arch
      const current = await this.models.inspect()
      const selectedModels = input.chatModel || input.embeddingModel
      const selectedAssets = (this.options.assets ?? MODEL_ASSETS).filter(
        (asset) =>
          (input.chatModel && ['chat', 'template'].includes(asset.id)) ||
          (input.embeddingModel && ['embedding', 'projector'].includes(asset.id)),
      )
      let executable = current.config.executablePath
      const requestedEngine = join(
        this.userData,
        'local-models',
        'engines',
        `default-b11541-${input.backend}-${arch}`,
        'llama-server.exe',
      )
      if (input.runtime) executable = existsSync(requestedEngine) ? requestedEngine : ''
      else if (executable && !existsSync(executable)) executable = ''
      const disk = await statfs(this.directory)
      let needed =
        512 * 1024 ** 2 + (input.office && !(await findLibreOffice()) ? 2 * 1024 ** 3 : 0)
      if (input.runtime && !executable && input.backend === 'cuda') needed += 3 * 1024 ** 3
      if (selectedModels)
        for (const asset of selectedAssets) {
          const path = join(this.userData, 'local-models', 'defaults-v1', asset.name)
          const cached = Math.max(
            await stat(path).then(
              (info) => info.size,
              () => 0,
            ),
            await stat(`${path}.part`).then(
              (info) => info.size,
              () => 0,
            ),
          )
          needed += Math.max(0, asset.bytes - cached)
        }
      if (Number(disk.bavail) * Number(disk.bsize) < needed)
        throw new Error(
          'There is not enough free disk space to finish setup. Free disk space and retry.',
        )
      if (
        input.runtime ||
        input.office ||
        (selectedModels && !!executable && (input.startModels || input.useDefaults))
      ) {
        const needsVc =
          this.options.needsVc?.() ??
          !['vcruntime140.dll', 'msvcp140.dll'].every((name) =>
            existsSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', name)),
          )
        if (needsVc) {
          const file = await this.asset(
            vcAsset(arch),
            join(this.directory, vcAsset(arch).name),
            signal,
          )
          const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
          const script = `$runtimeInstall = Start-Process -FilePath ${literal(file)} -ArgumentList '/install /passive /norestart' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $runtimeInstall.ExitCode`
          await run(
            join(
              process.env.SystemRoot ?? 'C:/Windows',
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            ),
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            signal,
          )
        }
      }
      if (input.runtime) {
        if (!executable) {
          const root = join(
            this.userData,
            'local-models',
            'engines',
            `default-b11541-${input.backend}-${arch}`,
          )
          executable = join(root, 'llama-server.exe')
          if (!existsSync(executable)) {
            const staging = `${root}.stage-${randomUUID()}`
            try {
              let expanded = 0
              for (const asset of (this.options.engines ?? engineAssets)(arch, input.backend)) {
                const archive = await this.asset(asset, join(this.directory, asset.name), signal)
                const zip = await JSZip.loadAsync(await readFile(archive))
                for (const entry of Object.values(zip.files)) {
                  signal.throwIfAborted()
                  const original =
                    (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ??
                    entry.name
                  const target = safeArchivePath(staging, original)
                  if (entry.dir) {
                    await mkdir(target, { recursive: true })
                    continue
                  }
                  const data = (
                    entry as unknown as {
                      _data: {
                        uncompressedSize: number
                        compressedContent: Uint8Array
                        compression: { magic: string }
                      }
                    }
                  )._data
                  const declared = data.uncompressedSize
                  expanded += declared
                  if (
                    declared > 1024 ** 3 ||
                    expanded > 3 * 1024 ** 3 ||
                    ((Number(entry.unixPermissions) || 0) & 0xf000) === 0xa000
                  )
                    throw new Error('Unsafe engine archive.')
                  if (!['\x00\x00', '\x08\x00'].includes(data.compression.magic))
                    throw new Error('Unsupported engine archive compression.')
                  await mkdir(dirname(target), { recursive: true })
                  // JSZip supplies the pinned archive's metadata and compressed slices.
                  // Node's native inflater streams large CUDA DLLs without browser-worker delays.
                  const source = Readable.from([data.compressedContent])
                  let written = 0
                  const bounds = new Transform({
                    transform(chunk: Buffer, _encoding, done) {
                      written += chunk.length
                      done(
                        written > declared ? new Error('Unsafe engine archive size.') : null,
                        chunk,
                      )
                    },
                  })
                  const output = createWriteStream(target)
                  if (data.compression.magic === '\x08\x00')
                    await pipeline(source, createInflateRaw(), bounds, output, { signal })
                  else await pipeline(source, bounds, output, { signal })
                  if (written !== declared) throw new Error('Engine archive size mismatch.')
                }
              }
              if (!existsSync(join(staging, 'llama-server.exe')))
                throw new Error('The runtime archive has no llama-server.exe.')
              signal.throwIfAborted()
              await rm(root, { recursive: true, force: true })
              await rename(staging, root)
            } finally {
              await rm(staging, { recursive: true, force: true })
            }
          }
        }
        this.stage = 'verifyRuntime'
        await run(executable, ['--version'], signal, 30000)
        if (input.backend === 'cuda' && this.ownedEngine(executable)) {
          const devices = await run(executable, ['--list-devices'], signal, 30000)
          if (!/CUDA\d+\s*:/i.test(devices))
            throw new Error(
              'CUDA did not find a supported NVIDIA GPU. Update the NVIDIA driver or select CPU or Vulkan.',
            )
        }
      }
      if (selectedModels || input.runtime) {
        const root = join(this.userData, 'local-models', 'defaults-v1')
        for (const asset of selectedAssets) await this.asset(asset, join(root, asset.name), signal)
        this.stage = 'configure'
        const defaults = await this.defaultProfiles(
          root,
          current.config.profiles,
          input.startModels && !!executable,
          input,
        )
        const next = [...current.config.profiles]
        for (const profile of defaults)
          if (!next.some((value) => value.id === profile.id)) next.push(profile)
        await this.models.save({ executablePath: executable, profiles: next }, current.revision)
        this.saved.profileIds = [
          ...new Set([...(this.saved.profileIds ?? []), ...defaults.map((profile) => profile.id)]),
        ]
        const pending = (await this.inspect()).activationKinds
        if (input.useDefaults && executable)
          this.saved.activationKinds = [
            ...new Set([...pending, ...defaults.map((profile) => profile.kind)]),
          ]
        else this.saved.activationKinds = pending
        this.saved.needsActivation = this.saved.activationKinds.length > 0
        await this.persist()
        for (const profile of next.filter((profile) =>
          this.saved.profileIds?.includes(profile.id),
        )) {
          await writeJson(join(this.directory, `${profile.kind}.command.json`), {
            executable,
            arguments: localModelArguments(profile),
          })
          await writeFile(
            join(this.directory, `Start-${profile.kind}.ps1`),
            `$ErrorActionPreference = 'Stop'\r\n$command = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '${profile.kind}.command.json') | ConvertFrom-Json\r\nif ([string]::IsNullOrWhiteSpace($command.executable) -or -not (Test-Path -LiteralPath $command.executable)) { throw 'Configure llama-server in Nawa before starting this model.' }\r\n$runtimeArgs = @($command.arguments)\r\n& $command.executable @runtimeArgs\r\nexit $LASTEXITCODE\r\n`,
          )
        }
        if (input.startModels && executable) {
          for (const profile of defaults) {
            signal.throwIfAborted()
            this.stage = profile.kind === 'chat' ? 'startChat' : 'startEmbedding'
            if (
              !(await this.models.inspect()).runtimes.some(
                (runtime) =>
                  runtime.id === profile.id && ['starting', 'running'].includes(runtime.state),
              )
            ) {
              await this.models.start(profile.id)
              started.push(profile.id)
            }
            while (true) {
              signal.throwIfAborted()
              const runtime = (await this.models.inspect()).runtimes.find(
                (value) => value.id === profile.id,
              )
              if (runtime?.state === 'running') break
              if (!runtime || runtime.state === 'failed' || runtime.state === 'stopped')
                throw new Error(runtime?.error || 'The model server did not start.')
              await delay(250, undefined, { signal })
            }
          }
        }
      }
      if (input.office && !(await findLibreOffice())) {
        const asset = officeAsset(arch),
          installer = await this.asset(asset, join(this.directory, asset.name), signal)
        const directory = join(this.userData, 'dependencies', 'libreoffice-26.8.1')
        this.stage = 'installOffice'
        await run(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'msiexec.exe'),
          [
            '/a',
            installer,
            '/qn',
            '/norestart',
            `TARGETDIR=${directory}`,
            '/L*v',
            join(this.directory, 'office-install.log'),
          ],
          signal,
        )
        const office = await officeIn(directory)
        if (!office)
          throw new Error(
            'LibreOffice extraction did not create a conversion executable. See office-install.log.',
          )
        await run(office, ['--headless', '--version'], signal, 30000)
        this.saved.office = office
        process.env.NAWA_LIBREOFFICE_PATH = office
      }
      this.saved.installed = true
      this.saved.dismissed = !this.saved.needsActivation
      await this.persist()
      await writeJson(join(this.directory, 'third-party-sources.json'), {
        version: 1,
        models: (this.options.assets ?? MODEL_ASSETS)
          .filter((asset) =>
            existsSync(join(this.userData, 'local-models', 'defaults-v1', asset.name)),
          )
          .map((asset) => ({
            ...asset,
            license: 'Apache-2.0',
          })),
        runtime: {
          ...engineAsset(arch, input.backend),
          license: 'MIT',
          source: 'https://github.com/ggml-org/llama.cpp',
          dependencies: engineAssets(arch, input.backend)
            .slice(1)
            .map((asset) => ({
              ...asset,
              license: 'NVIDIA CUDA redistributables',
              source: 'https://docs.nvidia.com/cuda/eula/index.html',
            })),
        },
        office: {
          ...officeAsset(arch),
          license: 'MPL-2.0 / LGPL-3.0+',
          source: 'https://www.libreoffice.org/about-us/licenses/',
        },
        microsoftRuntime: {
          ...vcAsset(arch),
          source: 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist',
        },
      })
      this.state = 'ready'
      this.stage = 'complete'
    } catch (error) {
      if (signal.aborted) await Promise.allSettled(started.map((id) => this.models.stop(id)))
      this.state = signal.aborted ? 'canceled' : 'failed'
      this.error = signal.aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error)
    } finally {
      this.abort = undefined
    }
    return this.inspect()
  }
  private async defaultProfiles(
    root: string,
    existing: LocalModelProfile[],
    autoStart: boolean,
    selection: Pick<RuntimeSetupOptions, 'chatModel' | 'embeddingModel'>,
  ): Promise<LocalModelProfile[]> {
    const argument = (name: string, value = '') => ({ enabled: true, name, value })
    const chatPort =
      existing.find((profile) => profile.id === 'nawa-default-chat')?.port ??
      (selection.chatModel
        ? await freePort(
            8083,
            existing.map((profile) => profile.port),
          )
        : 8083)
    const embeddingPort =
      existing.find((profile) => profile.id === 'nawa-default-embedding')?.port ??
      (selection.embeddingModel
        ? await freePort(8086, [
            ...existing.map((profile) => profile.port),
            ...(selection.chatModel ? [chatPort] : []),
          ])
        : 8086)
    const common = { gpuLayers: 'auto' as const, threads: 0, pooling: 'model' as const, autoStart }
    const profiles: LocalModelProfile[] = []
    if (selection.chatModel)
      profiles.push(
        existing.find((profile) => profile.id === 'nawa-default-chat') ?? {
          ...common,
          id: 'nawa-default-chat',
          name: 'Gemma 4 E4B',
          alias: 'gemma-4-e4b',
          kind: 'chat',
          port: chatPort,
          contextSize: 65536,
          modelPath: join(root, 'gemma-4-E4B_q4_0-it.gguf'),
          arguments: [
            argument('-b', '512'),
            argument('-ub', '128'),
            argument('-np', '2'),
            argument('-fa', 'on'),
            argument('-ctk', 'q8_0'),
            argument('-ctv', 'q8_0'),
            argument('--jinja'),
            argument('--reasoning', 'off'),
            argument('--reasoning-budget', '0'),
            argument('--temp', '0.2'),
            argument('--top-p', '0.85'),
            argument('--top-k', '20'),
            argument('--min-p', '0.05'),
            argument('--n-predict', '1024'),
            argument('--presence-penalty', '0'),
            argument('--repeat-penalty', '1'),
            argument('--chat-template-file', join(root, 'chat_template.jinja')),
          ],
        },
      )
    if (selection.embeddingModel)
      profiles.push(
        existing.find((profile) => profile.id === 'nawa-default-embedding') ?? {
          ...common,
          id: 'nawa-default-embedding',
          name: 'EmbeddingGemma 2',
          alias: 'embeddinggemma-2',
          kind: 'embedding',
          port: embeddingPort,
          contextSize: 8192,
          modelPath: join(root, 'embeddinggemma-2-Q8_0.gguf'),
          arguments: [
            argument('-b', '2048'),
            argument('-ub', '512'),
            argument('-np', '1'),
            argument('-ctk', 'f32'),
            argument('-ctv', 'f32'),
            argument('--video-fps', '1'),
            argument('--mmproj', join(root, 'mmproj-embeddinggemma-2-Q8_0.gguf')),
          ],
        },
      )
    return profiles
  }
}
