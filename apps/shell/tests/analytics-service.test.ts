import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), readFileSync: vi.fn(), authorizePath: vi.fn(), autoReady: true }))
vi.mock('electron', () => ({ app: { getPath: () => 'analytics-test' }, ipcMain: {} }))
vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }))
vi.mock('node:fs/promises', () => ({
  ...mocks,
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/main/directory-actions/file-safety', () => ({ authorizePath: mocks.authorizePath }))
vi.mock('../src/main/analytics/worker?modulePath', () => ({ default: 'analytics-worker.js' }))
vi.mock('node:worker_threads', () => ({
  Worker: class TestWorker extends EventEmitter {
    static instances: TestWorker[] = []
    job: { action: string; payload?: unknown }
    storeOptions: { readOnly: boolean; initialize: boolean }
    source: string
    eval: boolean
    constructor(source: string, options: { eval: boolean; workerData: { job: { action: string }; storeOptions: { readOnly: boolean; initialize: boolean } } }) {
      super()
      this.source = source
      this.eval = options.eval
      this.job = options.workerData.job
      this.storeOptions = options.workerData.storeOptions
      TestWorker.instances.push(this)
      if (mocks.autoReady) void Promise.resolve().then(() => this.emit('message', { ready: true }))
    }
    terminate() {
      this.emit('exit', 0)
      return Promise.resolve(0)
    }
  },
}))

import { Worker } from 'node:worker_threads'
import { AnalyticsService } from '../src/main/analytics/service'
import { DEFAULT_ANALYTICS_SETTINGS } from '../src/shared/analytics-api'

const workers = () =>
  (
    Worker as unknown as {
      instances: Array<EventEmitter & { source: string; eval: boolean; job: { action: string; payload?: unknown }; storeOptions: { readOnly: boolean; initialize: boolean } }>
    }
  ).instances
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
let service: AnalyticsService
beforeEach(() => {
  vi.useFakeTimers()
  workers().length = 0
  mocks.autoReady = true
  mocks.readFileSync.mockReset().mockReturnValue('trusted analytics worker source')
  mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.authorizePath.mockResolvedValue(undefined)
  service = new AnalyticsService({ roots: async () => [], isHomeSender: () => true })
})
afterEach(() => {
  service.stop()
  vi.useRealTimers()
})

describe('analytics worker admission', () => {
  it('requires saved consent for preparation and never admits model approval or clearing', async () => {
    const signal = new AbortController().signal
    await expect(service.selected(1, [], 'prepare', {}, signal)).rejects.toThrow('Prepare & export')
    expect(workers()).toHaveLength(0)
    await service.saveSettings({ ...DEFAULT_ANALYTICS_SETTINGS, allowAgentPreparation: true })
    const request = service.selected(1, [], 'prepare', {}, signal)
    await settle()
    expect(workers()[0].job.action).toBe('prepare')
    expect(workers()[0].storeOptions.readOnly).toBe(false)
    workers()[0].emit('message', { result: { value: { approvalRequired: true }, sources: [] } })
    await expect(request).resolves.toMatchObject({ value: { approvalRequired: true } })
    for (const action of ['review', 'import', 'clear', 'prepare-export']) {
      await expect(service.selected(1, [], action as never, {}, signal)).rejects.toThrow('user-controlled')
    }
  })
  it('admits the explicit UI batch as a cancellable writer without changing saved agent settings', async () => {
    const request = service.selected(7, [], 'export-sqlite', {}, new AbortController().signal, { folder: 'workspace', reviewedDatasets: [] })
    await settle()
    expect(workers()[0].job.action).toBe('export-sqlite')
    expect(workers()[0].storeOptions.readOnly).toBe(false)
    expect(service.progress().running).toBe(true)
    await expect(service.request(7, { action: 'import' })).rejects.toThrow('Another data import/review')
    const rejection = expect(request).rejects.toThrow('cancelled')
    service.cancel(7)
    workers()[0].emit('message', { result: { exports: [], sources: [] } })
    await rejection
    expect(service.progress().running).toBe(false)
    expect((await service.settings()).settings).toEqual(DEFAULT_ANALYTICS_SETTINGS)
  })
  it('retains the startup worker code when rebuilds remove its generated file', async () => {
    mocks.readFileSync.mockImplementation(() => { throw Object.assign(new Error('bundle removed'), { code: 'ENOENT' }) })
    const request = service.request(1, { action: 'statuses' })
    await settle()
    expect(workers()[0]).toMatchObject({ source: 'trusted analytics worker source', eval: true })
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1)
    workers()[0].emit('message', { result: [] })
    await expect(request).resolves.toEqual([])
  })

  it('retries a missing startup bundle after the build finishes', async () => {
    mocks.readFileSync.mockImplementationOnce(() => { throw Object.assign(new Error('building'), { code: 'ENOENT' }) })
    const recovering = new AnalyticsService({ roots: async () => [], isHomeSender: () => true })
    try {
      const request = recovering.request(1, { action: 'statuses' })
      await settle()
      expect(workers()[0]).toMatchObject({ source: 'trusted analytics worker source', eval: true })
      workers()[0].emit('message', { result: [] })
      await expect(request).resolves.toEqual([])
    } finally { recovering.stop() }
  })

  it('queues overlapping reads in order and keeps at most two workers running', async () => {
    const requests = [1, 2, 3, 4].map((payload) =>
      service.request(1, { action: 'statuses', payload }),
    )
    await settle()
    expect(workers().map((w) => w.job.payload)).toEqual([1, 2])
    workers()[0].emit('message', { result: 'first' })
    await expect(requests[0]).resolves.toBe('first')
    await settle()
    expect(workers().map((w) => w.job.payload)).toEqual([1, 2, 3])
    workers()[1].emit('message', { result: 'second' })
    await requests[1]
    await settle()
    expect(workers().map((w) => w.job.payload)).toEqual([1, 2, 3, 4])
    workers()[2].emit('message', { result: 'third' })
    workers()[3].emit('message', { result: 'fourth' })
    await expect(Promise.all(requests)).resolves.toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('removes a cancelled waiter without consuming the next available slot', async () => {
    const first = service.request(1, { action: 'statuses' })
    const second = service.request(1, { action: 'statuses' })
    const abort = new AbortController()
    const cancelled = service.request(1, { action: 'query', payload: 'cancelled' }, abort.signal)
    const rejection = expect(cancelled).rejects.toThrow('cancelled')
    const next = service.request(1, { action: 'query', payload: 'next' })
    await settle()
    abort.abort()
    await rejection
    workers()[0].emit('message', { result: [] })
    await first
    await settle()
    expect(workers()).toHaveLength(3)
    expect(workers()[2].job.payload).toBe('next')
    workers()[1].emit('message', { result: [] })
    workers()[2].emit('message', { result: [] })
    await Promise.all([second, next])
  })

  it('cancels queued requests when their renderer leaves', async () => {
    const sender = Object.assign(new EventEmitter(), { id: 7 }) as unknown as WebContents
    service.track(sender)
    const running = [1, 2].map(() => service.request(1, { action: 'statuses' }))
    const queued = service.request(7, { action: 'statuses' })
    const rejection = expect(queued).rejects.toThrow('cancelled')
    await settle()
    sender.emit('destroyed')
    await rejection
    for (const worker of workers()) worker.emit('message', { result: [] })
    await Promise.all(running)
    expect(workers()).toHaveLength(2)
  })

  it('releases a slot after a worker failure and still rejects concurrent writers', async () => {
    const first = service.request(1, { action: 'statuses' })
    const failure = expect(first).rejects.toThrow('database unavailable')
    const second = service.request(1, { action: 'statuses' })
    const queued = service.request(1, { action: 'statuses' })
    await settle()
    const writer = service.request(1, { action: 'import' })
    await expect(service.request(1, { action: 'clear' })).rejects.toThrow(
      'Another data import/review',
    )
    await settle()
    workers()[0].emit('message', { error: 'database unavailable' })
    await failure
    await settle()
    expect(workers()).toHaveLength(4)
    for (const worker of workers().slice(1)) worker.emit('message', { result: [] })
    await Promise.all([second, queued, writer])
  })

  it('bounds the queue and times out waiting requests without starting extra workers', async () => {
    const running = [1, 2].map(() => service.request(1, { action: 'statuses' }))
    await settle()
    const waiting = Array.from({ length: 64 }, () => service.request(1, { action: 'statuses' }))
    const failures = waiting.map((request) =>
      expect(request).rejects.toThrow('waiting for an available worker'),
    )
    await settle()
    await expect(service.request(1, { action: 'statuses' })).rejects.toThrow('Too many queued')
    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.all(failures)
    expect(workers()).toHaveLength(2)
    for (const worker of workers()) worker.emit('message', { result: [] })
    await Promise.all(running)
  })

  it('settles running and queued requests when the service stops', async () => {
    const requests = [1, 2, 3].map(() => service.request(1, { action: 'statuses' }))
    const results = Promise.allSettled(requests)
    await settle()
    service.stop()
    expect((await results).every((result) => result.status === 'rejected')).toBe(true)
    expect(workers()).toHaveLength(2)
    await expect(service.request(1, { action: 'statuses' })).rejects.toThrow('cancelled')
  })

  it('bootstraps the database alone, then opens metadata workers read-only', async () => {
    mocks.autoReady = false
    const first = service.request(1, { action: 'statuses' })
    const second = service.request(1, { action: 'catalog' })
    await settle()
    expect(workers()).toHaveLength(1)
    expect(workers()[0].storeOptions).toEqual({ readOnly: false, initialize: true })
    workers()[0].emit('message', { ready: true })
    await settle()
    expect(workers()).toHaveLength(2)
    expect(workers()[1].storeOptions).toEqual({ readOnly: true, initialize: false })
    for (const worker of workers()) worker.emit('message', { result: [] })
    await Promise.all([first, second])
  })

  it('retries bootstrap after initialization fails and releases its write slot', async () => {
    mocks.autoReady = false
    const first = service.request(1, { action: 'statuses' })
    const failure = expect(first).rejects.toThrow('initialization failed')
    const next = service.request(1, { action: 'statuses' })
    await settle()
    workers()[0].emit('message', { error: 'initialization failed' })
    await failure
    await settle()
    expect(workers()).toHaveLength(2)
    expect(workers()[1].storeOptions).toEqual({ readOnly: false, initialize: true })
    workers()[1].emit('message', { ready: true })
    workers()[1].emit('message', { result: [] })
    await next
  })

  it('serializes queries, statistical analyses and drill-down result writes', async () => {
    const requests = ['query', 'analyze', 'drill'].map(action => service.request(1, { action }))
    const metadata = service.request(1, { action: 'statuses' })
    await settle()
    expect(workers().map(w => w.job.action)).toEqual(['query', 'statuses'])
    expect(workers()[1].storeOptions.readOnly).toBe(true)
    workers()[0].emit('message', { result: 'query' })
    await requests[0]
    await settle()
    expect(workers().map(w => w.job.action)).toEqual(['query', 'statuses', 'analyze'])
    expect(workers()[2].storeOptions).toEqual({ readOnly: false, initialize: false })
    workers()[2].emit('message', { result: 'analyze' })
    await requests[1]
    await settle()
    workers()[3].emit('message', { result: 'drill' })
    workers()[1].emit('message', { result: [] })
    await Promise.all([...requests, metadata])
  })

  it('keeps status reads available during imports while receipt writers wait', async () => {
    const imported = service.request(1, { action: 'import' })
    const query = service.request(1, { action: 'query' })
    const statuses = service.request(1, { action: 'statuses' })
    await settle()
    expect(workers().map(w => w.job.action)).toEqual(['import', 'statuses'])
    expect(workers()[1].storeOptions.readOnly).toBe(true)
    workers()[1].emit('message', { result: [] })
    await statuses
    expect(workers()).toHaveLength(2)
    workers()[0].emit('message', { result: [] })
    await imported
    await settle()
    expect(workers()[2].job.action).toBe('query')
    workers()[2].emit('message', { result: [] })
    await query
  })

  it('cancels a queued user writer without releasing an active receipt writer', async () => {
    const query = service.request(1, { action: 'query' })
    await settle()
    const imported = service.request(2, { action: 'import' })
    const failure = expect(imported).rejects.toThrow('cancelled')
    await settle()
    service.cancel(2)
    await failure
    const next = service.request(2, { action: 'clear' })
    await settle()
    expect(workers()).toHaveLength(1)
    workers()[0].emit('message', { result: [] })
    await query
    await settle()
    expect(workers()[1].job.action).toBe('clear')
    workers()[1].emit('message', { result: [] })
    await next
  })
})
