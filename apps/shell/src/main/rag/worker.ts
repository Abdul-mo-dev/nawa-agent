import { parentPort, workerData } from 'node:worker_threads'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RagStore } from './store'
import { RagEngine, type RagJob } from './engine'
import { validateSettings } from './config'
let queue: Promise<unknown> = Promise.resolve()
let active: { id: string; abort: AbortController } | null = null
let engine: RagEngine | undefined
async function getEngine(): Promise<RagEngine> {
  if (!engine) {
    const dir = dirname(workerData.databasePath)
    await mkdir(dir, { recursive: true })
    const store = new RagStore(workerData.databasePath)
    if (workerData.indexer) { store.recover(); await rm(join(dir, 'staging'), { recursive: true, force: true }).catch(() => undefined) }
    engine = new RagEngine(store, dir)
  }
  return engine
}
parentPort!.on('message', (raw: { id: string; cancel?: boolean; job?: RagJob }) => {
  if (raw.cancel) { if (active?.id === raw.id) active.abort.abort(); return }
  const run = async () => {
    const abort = new AbortController(); active = { id: raw.id, abort }
    try {
      if (!raw.job) throw new Error('Missing RAG job.')
      raw.job.settings = validateSettings(raw.job.settings)
      const result = await (await getEngine()).execute(raw.job, abort.signal, progress => parentPort!.postMessage({ id: raw.id, progress }))
      parentPort!.postMessage({ id: raw.id, result })
    } catch (e) { parentPort!.postMessage({ id: raw.id, error: e instanceof Error ? e.message : String(e) }) }
    finally { if (active?.id === raw.id) active = null }
  }
  queue = queue.then(run, run)
})
