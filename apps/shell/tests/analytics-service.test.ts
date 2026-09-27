import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), authorizePath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'analytics-test' }, ipcMain: {} }))
vi.mock('node:fs/promises', () => ({
  ...mocks,
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}))
vi.mock('../src/main/directory-actions/file-safety', () => ({ authorizePath: mocks.authorizePath }))
vi.mock('../src/main/analytics/worker?modulePath', () => ({ default: 'analytics-worker.js' }))
vi.mock('node:worker_threads', () => ({
  Worker: class TestWorker extends EventEmitter {
    static instances: Array<EventEmitter & { job: { action: string; payload?: unknown } }> = []
    job: { action: string; payload?: unknown }
    constructor(_path: string, options: { workerData: { job: { action: string } } }) {
      super()
      this.job = options.workerData.job
      TestWorker.instances.push(this)
    }
    terminate() {
      this.emit('exit', 0)
      return Promise.resolve(0)
    }
  },
}))

import { Worker } from 'node:worker_threads'
import { AnalyticsService } from '../src/main/analytics/service'

const workers = () =>
  (
    Worker as unknown as {
      instances: Array<EventEmitter & { job: { action: string; payload?: unknown } }>
    }
  ).instances
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
let service: AnalyticsService
beforeEach(() => {
  vi.useFakeTimers()
  workers().length = 0
  mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.authorizePath.mockResolvedValue(undefined)
  service = new AnalyticsService({ roots: async () => [], isHomeSender: () => true })
})
afterEach(() => {
  service.stop()
  vi.useRealTimers()
})

describe('analytics worker admission', () => {
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
      expect(request).rejects.toThrow('waiting for an available reader'),
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
})
