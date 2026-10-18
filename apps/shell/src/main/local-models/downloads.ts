import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import type {
  LocalEngineRelease,
  LocalModelDownload,
  LocalModelFile,
  RemoteModelFile,
} from '../../shared/local-models-api'

const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/
const digestPattern = /^[a-f0-9]{64}$/i
function repository(value: unknown): string {
  if (typeof value !== 'string' || !repoPattern.test(value) || value.includes('..'))
    throw new Error('Use a Hugging Face owner/repository ID.')
  return value
}
export function safeArchivePath(root: string, name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    name.startsWith('/') ||
    name.split('/').some((p) => p === '..' || p === '.')
  )
    throw new Error('Unsafe archive path.')
  const path = resolve(root, name)
  if (!path.startsWith(resolve(root) + sep)) throw new Error('Unsafe archive path.')
  return path
}
export class ModelDownloads {
  progress: LocalModelDownload = { state: 'idle', name: '', received: 0, total: 0 }
  private controller?: AbortController
  private release?: LocalEngineRelease
  private files = new Map<string, RemoteModelFile[]>()
  constructor(
    readonly directory: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async json(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': 'Nawa-local-models', Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok)
      throw new Error(
        `Model catalog request failed (HTTP ${response.status}). Public repositories are supported; check rate limits or repository access.`,
      )
    if (!response.body) throw new Error('Empty catalog response.')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 8 * 1024 * 1024) throw new Error('Model catalog response is too large.')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async releases(): Promise<LocalEngineRelease> {
    const releases = (await this.json(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10',
    )) as {
      tag_name: string
      prerelease?: boolean
      draft?: boolean
      assets: {
        id: number
        name: string
        size: number
        digest?: string
        browser_download_url: string
      }[]
    }[]
    const data = Array.isArray(releases)
      ? releases.find(
          (release) =>
            !release.draft &&
            Array.isArray(release.assets) &&
            release.assets.some((a) => /^llama-.*-bin-win.*\.zip$/i.test(a.name)),
        )
      : undefined
    if (!data || typeof data.tag_name !== 'string')
      throw new Error('Invalid llama.cpp release response.')
    this.release = {
      tag: data.tag_name,
      prerelease: data.prerelease === true,
      assets: data.assets
        .filter(
          (a) =>
            /^llama-.*-bin-win.*\.zip$/i.test(a.name) &&
            a.digest?.startsWith('sha256:') &&
            digestPattern.test(a.digest.slice(7)) &&
            a.browser_download_url.startsWith(
              'https://github.com/ggml-org/llama.cpp/releases/download/',
            ),
        )
        .map((a) => ({
          id: a.id,
          name: a.name,
          bytes: a.size,
          digest: a.digest!.slice(7),
          url: a.browser_download_url,
        }))
        .sort((a, b) => {
          const rank = (name: string) =>
            (name.includes(process.arch === 'arm64' ? 'arm64' : 'x64') ? 0 : 10) +
            (/bin-win-cpu/.test(name) ? 0 : 1)
          return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)
        }),
    }
    return this.release
  }
  async search(query: unknown): Promise<string[]> {
    if (typeof query !== 'string' || !query.trim() || query.length > 160)
      throw new Error('Enter a model search query.')
    const value = await this.json(
      'https://huggingface.co/api/models?filter=gguf&limit=20&search=' +
        encodeURIComponent(query.trim()),
    )
    if (!Array.isArray(value)) throw new Error('Invalid model search response.')
    return value.filter((v) => typeof v.id === 'string' && repoPattern.test(v.id)).map((v) => v.id)
  }
  async modelFiles(raw: unknown): Promise<RemoteModelFile[]> {
    const repo = repository(raw)
    const data = (await this.json(`https://huggingface.co/api/models/${repo}?blobs=true`)) as {
      sha: string
      siblings: { rfilename: string; size?: number; lfs?: { sha256: string; size: number } }[]
    }
    if (!/^[a-f0-9]{40}$/i.test(data.sha) || !Array.isArray(data.siblings))
      throw new Error('Invalid model file catalog.')
    const files = data.siblings
      .filter(
        (f) =>
          typeof f.rfilename === 'string' &&
          /\.gguf$/i.test(f.rfilename) &&
          f.lfs &&
          digestPattern.test(f.lfs.sha256),
      )
      .map((f) => ({
        repository: repo,
        revision: data.sha,
        name: f.rfilename,
        bytes: f.lfs!.size,
        sha256: f.lfs!.sha256,
      }))
    for (const f of files) {
      safeArchivePath(join(this.directory, 'models'), f.name)
      if (!Number.isSafeInteger(f.bytes) || f.bytes < 8 || f.bytes > 128 * 1024 ** 3)
        throw new Error('Invalid model size.')
    }
    if (!files.length)
      throw new Error('No GGUF files with SHA-256 metadata were found in this public repository.')
    if (this.files.size > 40) this.files.clear()
    this.files.set(repo, files)
    return files
  }
  cancel(): void {
    this.controller?.abort()
  }
  private async job(
    name: string,
    total: number,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.controller) throw new Error('Wait for the current download or cancel it first.')
    const controller = (this.controller = new AbortController())
    this.progress = { state: 'downloading', name, received: 0, total }
    try {
      await work(controller.signal)
      controller.signal.throwIfAborted()
      this.progress.state = 'completed'
    } catch (error) {
      this.progress.state = controller.signal.aborted ? 'canceled' : 'failed'
      this.progress.error = controller.signal.aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error)
      throw error
    } finally {
      this.controller = undefined
    }
  }
  private async transfer(
    url: string,
    target: string,
    bytes: number,
    expectedHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Download redirects are required for GitHub assets and Hugging Face's CDN.
    const response = await this.fetcher(url, {
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]),
      headers: { 'User-Agent': 'Nawa-local-models' },
    })
    if (!response.ok || !response.body || new URL(response.url || url).protocol !== 'https:')
      throw new Error(`Download failed (HTTP ${response.status}).`)
    await mkdir(dirname(target), { recursive: true })
    const output = await open(target, 'wx', 0o600),
      hash = createHash('sha256'),
      reader = response.body.getReader()
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > bytes) throw new Error('Download exceeds its published size.')
        hash.update(value)
        let offset = 0
        while (offset < value.length)
          offset += (await output.write(value, offset, value.length - offset)).bytesWritten
        this.progress.received += value.length
      }
      if (size !== bytes || hash.digest('hex').toLowerCase() !== expectedHash.toLowerCase())
        throw new Error('Download size or SHA-256 verification failed.')
      await output.sync()
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await output.close()
    }
  }
  async downloadModel(rawRepo: unknown, revision: unknown, name: unknown): Promise<void> {
    const repo = repository(rawRepo)
    const files = this.files.get(repo) ?? (await this.modelFiles(repo))
    const selected = files.find((f) => f.name === name && f.revision === revision)
    if (!selected) throw new Error('Refresh the file list before downloading.')
    const split = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(selected.name)
    const chosen = split
      ? files
          .filter((f) =>
            new RegExp(
              '^' +
                split[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                '-\\d{5}-of-' +
                split[2] +
                '\\.gguf$',
              'i',
            ).test(f.name),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      : [selected]
    if (
      split &&
      (chosen.length !== Number(split[2]) ||
        !chosen.every((f, i) =>
          f.name.endsWith(`-${String(i + 1).padStart(5, '0')}-of-${split[2]}.gguf`),
        ))
    )
      throw new Error('The repository is missing one or more GGUF shards.')
    const id = randomUUID(),
      stage = join(this.directory, 'staging', id),
      destination = join(this.directory, 'models', id)
    await this.job(
      selected.name,
      chosen.reduce((sum, f) => sum + f.bytes, 0),
      async (signal) => {
        try {
          for (const f of chosen) {
            const target = safeArchivePath(stage, f.name)
            await this.transfer(
              `https://huggingface.co/${repo}/resolve/${f.revision}/${f.name.split('/').map(encodeURIComponent).join('/')}?download=true`,
              target,
              f.bytes,
              f.sha256,
              signal,
            )
            const file = await open(target, 'r')
            try {
              const header = Buffer.alloc(8)
              await file.read(header, 0, 8, 0)
              if (
                header.toString('ascii', 0, 4) !== 'GGUF' ||
                ![2, 3].includes(header.readUInt32LE(4))
              )
                throw new Error('Downloaded file is not a supported GGUF model.')
            } finally {
              await file.close()
            }
          }
          signal.throwIfAborted()
          await writeFile(
            join(stage, 'manifest.json'),
            JSON.stringify({ repository: repo, revision, files: chosen }, null, 2),
          )
          await mkdir(dirname(destination), { recursive: true })
          await rename(stage, destination)
        } finally {
          await rm(stage, { recursive: true, force: true }).catch(() => {})
        }
      },
    )
  }
  async installEngine(id: unknown): Promise<void> {
    const asset = this.release?.assets.find((a) => a.id === id)
    if (!asset || asset.bytes <= 0 || asset.bytes > 1024 ** 3)
      throw new Error('Refresh releases and choose a verified ZIP asset (up to 1 GiB).')
    const jobId = randomUUID(),
      stage = join(this.directory, 'staging', jobId),
      archive = join(stage, 'engine.zip'),
      extracted = join(stage, 'engine')
    await this.job(asset.name, asset.bytes, async (signal) => {
      try {
        await this.transfer(asset.url, archive, asset.bytes, asset.digest, signal)
        const zip = await JSZip.loadAsync(await readFile(archive)),
          entries = Object.values(zip.files)
        if (entries.length > 10000) throw new Error('Engine archive has too many files.')
        let total = 0
        for (const entry of entries) {
          signal.throwIfAborted()
          const original =
            (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ??
            entry.name
          const target = safeArchivePath(extracted, original)
          if (entry.dir) {
            await mkdir(target, { recursive: true })
            continue
          }
          const unixMode =
            typeof entry.unixPermissions === 'string'
              ? parseInt(entry.unixPermissions, 8)
              : (entry.unixPermissions ?? 0)
          if ((unixMode & 0xf000) === 0xa000)
            throw new Error('Engine archive links are not supported.')
          // Check ZIP metadata before allocating decompression buffers.
          const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
            ?.uncompressedSize
          if (
            typeof declared !== 'number' ||
            declared > 512 * 1024 ** 2 ||
            total + declared > 4 * 1024 ** 3
          )
            throw new Error('Engine archive is too large.')
          const content = await entry.async('nodebuffer')
          total += content.length
          if (content.length !== declared) throw new Error('Invalid engine archive size.')
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content, { flag: 'wx' })
        }
        const executables = await this.walk(
          extracted,
          (path) => basename(path).toLowerCase() === 'llama-server.exe',
        )
        if (!executables.length)
          throw new Error(
            'This archive does not contain llama-server.exe. Choose a server binary package.',
          )
        signal.throwIfAborted()
        const destination = join(this.directory, 'engines', jobId)
        await mkdir(dirname(destination), { recursive: true })
        await rename(extracted, destination)
        await writeFile(
          join(destination, 'nawa-release.json'),
          JSON.stringify({ tag: this.release?.tag, asset }, null, 2),
        )
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => {})
      }
    })
  }
  private async walk(
    root: string,
    accept: (path: string) => boolean,
    depth = 0,
  ): Promise<string[]> {
    if (depth > 8) return []
    const result: string[] = []
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    for (const entry of entries) {
      if (result.length >= 10000) break
      const path = join(root, entry.name)
      if (entry.isDirectory()) result.push(...(await this.walk(path, accept, depth + 1)))
      else if (entry.isFile() && accept(path)) result.push(path)
    }
    return result
  }
  async models(): Promise<LocalModelFile[]> {
    const paths = await this.walk(
      join(this.directory, 'models'),
      (path) =>
        /\.gguf$/i.test(path) &&
        (!/-\d{5}-of-\d{5}\.gguf$/i.test(path) || /-00001-of-\d{5}\.gguf$/i.test(path)),
    )
    return Promise.all(
      paths.map(async (path) => ({ path, name: basename(path), bytes: (await stat(path)).size })),
    )
  }
  async engines(): Promise<string[]> {
    return this.walk(join(this.directory, 'engines'), (path) =>
      ['llama-server.exe', 'llama-server'].includes(basename(path)),
    )
  }
}
