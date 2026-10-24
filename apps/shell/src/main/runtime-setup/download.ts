import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SetupAsset } from './assets'

export async function verifyAsset(
  path: string,
  asset: SetupAsset,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== asset.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal, highWaterMark: 4 * 1024 ** 2 }))
      hash.update(chunk)
    return hash.digest('hex') === asset.sha256
  } catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Keep interrupted bytes for Range retries; publish only size/hash-verified files. */
export async function downloadAsset(
  asset: SetupAsset,
  path: string,
  signal: AbortSignal,
  progress: (received: number, total: number) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (await verifyAsset(path, asset, signal)) {
    progress(asset.bytes, asset.bytes)
    return
  }
  await rm(path, { force: true })
  await mkdir(dirname(path), { recursive: true })
  const partial = `${path}.part`
  let offset = await stat(partial).then(
    (info) => info.size,
    (error) => {
      if (error.code !== 'ENOENT') throw error
      return 0
    },
  )
  if (offset === asset.bytes && (await verifyAsset(partial, asset, signal))) {
    await rename(partial, path)
    progress(asset.bytes, asset.bytes)
    return
  }
  if (offset >= asset.bytes) {
    await rm(partial, { force: true })
    offset = 0
  }
  const response = await fetcher(asset.url, {
    headers: {
      'User-Agent': 'Nawa-runtime-setup',
      ...(offset ? { Range: `bytes=${offset}-` } : {}),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]),
    redirect: 'follow',
  })
  if (!response.ok || !response.body || new URL(response.url || asset.url).protocol !== 'https:')
    throw new Error(
      `Could not download ${asset.name} (HTTP ${response.status}). Retry setup to resume.`,
    )
  if (
    response.status === 206 &&
    response.headers.get('content-range') !== `bytes ${offset}-${asset.bytes - 1}/${asset.bytes}`
  )
    throw new Error('The download server returned an unexpected byte range.')
  if (response.status !== 206) offset = 0
  const output = await open(partial, offset ? 'a' : 'w', 0o600),
    reader = response.body.getReader()
  try {
    progress(offset, asset.bytes)
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.length > asset.bytes)
        throw new Error('Download exceeds its published size.')
      let written = 0
      while (written < value.length)
        written += (await output.write(value, written, value.length - written)).bytesWritten
      offset += value.length
      progress(offset, asset.bytes)
    }
    await output.sync()
  } finally {
    await reader.cancel().catch(() => {})
    await output.close()
  }
  if (!(await verifyAsset(partial, asset, signal))) {
    if (offset === asset.bytes) await rm(partial, { force: true })
    throw new Error(`Size or SHA-256 verification failed for ${asset.name}. Retry setup.`)
  }
  signal.throwIfAborted()
  await rename(partial, path)
}
