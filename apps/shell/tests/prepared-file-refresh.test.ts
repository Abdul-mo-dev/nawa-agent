import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PreparedFileRefresh } from '../src/main/prepared-files/refresh'
import { confirmedMissing } from '../src/main/prepared-files/source'
import { hashFile } from '../src/main/directory-actions/file-safety'
import { AnalyticsEngine } from '../src/main/analytics/engine'
import {
  DEFAULT_ANALYTICS_SETTINGS,
  type AnalyticsEnvelope,
  type AnalyticsResult,
} from '../src/shared/analytics-api'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nawa-prepared-refresh-'))
  const folder = join(directory, 'documents'),
    state = join(directory, 'state')
  await mkdir(folder)
  const file = join(folder, 'sales.csv'),
    other = join(folder, 'unselected.csv')
  await writeFile(file, 'id,amount\nA,0.10\nB,0.20\n')
  await writeFile(other, 'id,amount\nX,99.00\n')
  let time = 1000,
    roots = [folder]
  const refresh = vi.fn(
    async (
      _kind: 'analysis' | 'search',
      _folder: string,
      _path: string,
      _profile: string,
      _signal: AbortSignal,
    ) => {},
  )
  const remove = vi.fn(
      async (_kind: 'analysis' | 'search', _path: string, _signal: AbortSignal) => {},
    ),
    changed = vi.fn()
  const watchers: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = []
  const options = {
    stateDirectory: state,
    roots: async () => roots,
    refresh,
    remove,
    changed,
    now: () => time,
    stableMs: 10,
    missingMs: 50,
    watchDirectory: vi.fn(() => {
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
      watchers.push(watcher)
      return watcher
    }) as unknown as typeof import('node:fs').watch,
  }
  const service = new PreparedFileRefresh(options)
  cleanups.push(async () => {
    service.stop()
    if (
      resolve(dirname(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('nawa-prepared-refresh-')
    )
      throw new Error('Unexpected test cleanup path.')
    await rm(directory, { recursive: true, force: true })
  })
  const remember = async (kind: 'analysis' | 'search' = 'analysis') =>
    service.remember(
      kind,
      folder,
      [{ path: file, hash: await hashFile(file) }],
      kind === 'search' ? 'authorized-profile' : '',
    )
  const settle = async () => {
    await service.check()
    time += 11
    await service.check()
  }
  return {
    directory,
    folder,
    file,
    other,
    state,
    options,
    service,
    remember,
    settle,
    refresh,
    remove,
    changed,
    watchers,
    advance: (ms: number) => {
      time += ms
    },
    revoke: () => {
      roots = []
    },
  }
}

it('refreshes a saved file once, reuses unchanged data, and never adds neighboring files', async () => {
  const f = await fixture()
  await f.remember()
  await f.settle()
  expect(f.refresh).not.toHaveBeenCalled()
  await writeFile(f.other, 'unselected replacement')
  await f.settle()
  expect(f.refresh).not.toHaveBeenCalled()
  await writeFile(f.file, 'id,amount\nA,1.10\nB,2.20\n')
  await f.service.check()
  expect(f.refresh).not.toHaveBeenCalled()
  f.advance(11)
  await f.service.check()
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith(
    'analysis',
    f.folder,
    f.file,
    '',
    expect.any(AbortSignal),
  )
  await f.settle()
  expect(f.refresh).toHaveBeenCalledOnce()
  expect(
    JSON.parse(await readFile(join(f.state, 'prepared-files-v1.json'), 'utf8')).files,
  ).toHaveLength(1)
})

it('waits for repeated saves to settle and handles editor atomic replacement', async () => {
  const f = await fixture()
  await f.remember()
  await f.settle()
  await writeFile(f.file, 'intermediate')
  await f.service.check()
  f.advance(5)
  const replacement = join(f.folder, 'temporary.csv')
  await writeFile(replacement, 'id,amount\nA,4.10\n')
  await rename(replacement, f.file)
  await f.service.check()
  f.advance(5)
  await f.service.check()
  expect(f.refresh).not.toHaveBeenCalled()
  f.advance(6)
  await f.service.check()
  expect(f.refresh).toHaveBeenCalledOnce()
})

it('runs every table refresh while embeddings are stalled and backs off embedding failures', async () => {
  const f = await fixture()
  await f.remember('analysis')
  await f.remember('search')
  await f.service.remember('analysis', f.folder, [{ path: f.other, hash: await hashFile(f.other) }])
  await f.settle()
  let reject!: (error: Error) => void
  f.refresh.mockImplementation(async (kind: string) => {
    if (kind === 'search')
      await new Promise<void>((_, no) => {
        reject = no
      })
  })
  await writeFile(f.file, 'saved new values')
  await writeFile(f.other, 'also changed')
  await f.service.check()
  f.advance(11)
  const running = f.service.check()
  await vi.waitFor(() =>
    expect(f.refresh.mock.calls.filter((call) => call[0] === 'analysis')).toHaveLength(2),
  )
  expect(reject).toBeTypeOf('function')
  reject(new Error('embedding endpoint unavailable'))
  await running
  await f.settle()
  expect(f.refresh).toHaveBeenCalledTimes(3)
})

it('confirms deletion before purging and refreshes a recreated file at the same authorized path', async () => {
  const f = await fixture()
  await f.remember()
  await f.settle()
  await rm(f.file)
  await f.service.check()
  f.advance(20)
  await f.service.check()
  expect(f.remove).not.toHaveBeenCalled()
  f.advance(31)
  await f.service.check()
  expect(f.remove).toHaveBeenCalledExactlyOnceWith('analysis', f.file, expect.any(AbortSignal))
  await f.service.check()
  expect(f.remove).toHaveBeenCalledOnce()
  await writeFile(f.file, 'id,amount\nA,5.00\n')
  await f.settle()
  expect(f.refresh).toHaveBeenCalledOnce()
})

it('does not purge a disconnected root or rebuild outside revoked workspace scope', async () => {
  const f = await fixture()
  await f.remember()
  await f.settle()
  const detached = f.folder + '-offline'
  await rename(f.folder, detached)
  await f.service.check()
  f.advance(100)
  await f.service.check()
  expect(f.remove).not.toHaveBeenCalled()
  await rename(detached, f.folder)
  await f.settle()
  expect(f.refresh).not.toHaveBeenCalled()
  f.revoke()
  await writeFile(f.file, 'changed after root revocation')
  await f.settle()
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.watchers.every((watcher) => watcher.close.mock.calls.length === 1)).toBe(true)
})

it('Stop pauses an engine until explicit indexing and Clear prevents future recreation', async () => {
  const f = await fixture()
  await f.remember()
  await f.settle()
  f.service.pause('analysis')
  await writeFile(f.file, 'changed while paused')
  await f.settle()
  expect(f.refresh).not.toHaveBeenCalled()
  await f.remember()
  await writeFile(f.file, 'changed after explicit preparation')
  await f.settle()
  expect(f.refresh).toHaveBeenCalledOnce()
  await f.service.forget('analysis', f.folder)
  await writeFile(f.file, 'changed after Clear')
  await f.settle()
  expect(f.refresh).toHaveBeenCalledOnce()
})

it('reloads the exact prepared scope after restart and retains the authorized embedding profile', async () => {
  const f = await fixture()
  await f.remember('search')
  f.service.stop()
  await writeFile(f.file, 'changed while app was closed')
  const restarted = new PreparedFileRefresh(f.options)
  cleanups.push(async () => {
    restarted.stop()
  })
  await restarted.check()
  f.advance(11)
  await restarted.check()
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith(
    'search',
    f.folder,
    f.file,
    'authorized-profile',
    expect.any(AbortSignal),
  )
})

it('requires an accessible authorized ancestor to confirm missing sources', async () => {
  const f = await fixture()
  expect(await confirmedMissing([f.folder], f.file)).toBe(false)
  expect(await confirmedMissing([f.folder], join(f.folder, 'absent', 'nested.csv'))).toBe(true)
  expect(await confirmedMissing([], f.file)).toBe(false)
})

it('rebuilds real SQLite data with exact totals and rejects receipts from previous generations', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    },
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  // The context-menu refresh path also handles first-time imports.
  await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
  const dataset = engine.store.datasets([f.file])[0]!.data
  const query = async () =>
    (
      (await engine.execute({
        action: 'query',
        paths: [f.file],
        payload: {
          datasetIds: [dataset.id],
          metrics: [{ as: 'total', column: 'c1', op: 'sum' }],
        },
      })) as AnalyticsEnvelope
    ).value as AnalyticsResult
  const before = await query()
  expect(before.rows).toEqual([{ total: '0.3' }])
  f.refresh.mockImplementation(async () => {
    await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
  })
  f.remove.mockImplementation(async () => {
    await engine.execute({ action: 'prune', paths: [f.file] })
  })
  await f.remember()
  await f.settle()
  await writeFile(f.file, 'id,amount\nA,9007199254740993.01\nB,0.09\n')
  await expect(query()).rejects.toThrow('source file changed')
  await f.settle()
  expect((await query()).rows).toEqual([{ total: '9007199254740993.10' }])
  expect(engine.store.datasets([f.file])[0]!.data.generation).not.toBe(dataset.generation)
  await expect(engine.verify(before.sources, [f.file])).rejects.toThrow('generation changed')
  await rm(f.file)
  await f.service.check()
  f.advance(51)
  await f.service.check()
  expect(engine.store.datasets([f.file])).toEqual([])
  expect(engine.store.result(before.id)).toBeUndefined()
})

it('reports a missing analytical source before it has any imported table generation', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    DEFAULT_ANALYTICS_SETTINGS,
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  await rm(f.file)
  expect((await engine.statuses([f.file], true))[0]).toMatchObject({
    state: 'unavailable',
    message: expect.stringContaining('ENOENT'),
  })
  expect(engine.store.datasets([f.file])).toEqual([])
})

it('leaves refreshed tables needing review when automatic approval is disabled', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
    },
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  await engine.execute({ action: 'prepare', paths: [f.file] })
  f.refresh.mockImplementation(async () => {
    await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
  })
  await f.remember()
  await f.settle()
  await writeFile(f.file, 'id,amount\nA,4.20\n')
  await f.settle()
  expect(engine.store.datasets([f.file])[0]!.data.status).toBe('needs-review')
  expect((await engine.statuses([f.file], true))[0]!.message).toContain(
    'previous table policy still needed review',
  )
  expect(engine.store.datasets([f.file])[0]!.data.preparedPolicy).toBeDefined()
  await expect(engine.execute({ action: 'prune', paths: [f.file] })).rejects.toThrow(
    'not confirmed',
  )
  expect(engine.store.datasets([f.file])).toHaveLength(1)
})

it('retains reviewed business units, row meaning and keys, and validates every refreshed key', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    },
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  await engine.execute({ action: 'prepare', paths: [f.file] })
  const before = engine.store.datasets([f.file])[0]!.data
  await engine.execute({
    action: 'review',
    paths: [f.file],
    payload: {
      datasetId: before.id,
      expectedGeneration: before.generation,
      policy: {
        ...before.policy,
        confirmed: true,
        grain: 'One product sale',
        key: ['c0'],
        columns: before.policy.columns.map((column) => ({
          ...column,
          unit: column.id === 'c1' ? 'USD' : column.unit,
        })),
      },
    },
  })
  f.refresh.mockImplementation(async () => {
    await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
  })
  await f.remember()
  await f.settle()
  await writeFile(f.file, 'id,amount\nA,2.20\nB,3.30\n')
  await f.settle()
  const refreshed = engine.store.datasets([f.file])[0]!.data
  expect(refreshed.status).toBe('ready')
  expect(refreshed.policy).toMatchObject({ grain: 'One product sale', key: ['c0'] })
  expect(refreshed.policy.columns[1].unit).toBe('USD')
  await writeFile(f.file, 'id,amount\nA,2.20\nA,3.30\n')
  await f.settle()
  const blocked = engine.store.datasets([f.file])[0]!.data
  expect(blocked.status).toBe('needs-review')
  expect(blocked.preparationError).toContain('not unique')
})

it('requires a decision after source headers change instead of automatically approving a new meaning', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    },
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  await engine.execute({ action: 'prepare', paths: [f.file] })
  f.refresh.mockImplementation(async () => {
    await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
  })
  await f.remember()
  await f.settle()
  await writeFile(f.file, 'id,quantity\nA,20\nB,30\n')
  await f.settle()
  const refreshed = engine.store.datasets([f.file])[0]!.data
  expect(refreshed.status).toBe('needs-review')
  expect(refreshed.preparedPolicy?.notes?.join(' ')).toContain('structure changed')
  expect(refreshed.preparedPolicy?.policy.columns[1].name).toBe('quantity')
})

it('automatically refreshes and prunes real SQLite data through filesystem notifications', async () => {
  const f = await fixture()
  const engine = new AnalyticsEngine(
    join(f.directory, 'analytics.sqlite3'),
    [f.folder],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    },
    () => {},
  )
  cleanups.push(async () => {
    engine.close()
  })
  await engine.execute({ action: 'prepare', paths: [f.file] })
  const automatic = new PreparedFileRefresh({
    ...f.options,
    now: Date.now,
    stableMs: 40,
    missingMs: 100,
    watchDirectory: undefined,
    refresh: async () => {
      await engine.execute({ action: 'prepare', paths: [f.file], backgroundRefresh: true })
    },
    remove: async () => {
      await engine.execute({ action: 'prune', paths: [f.file] })
    },
  })
  cleanups.push(async () => {
    automatic.stop()
  })
  await automatic.remember('analysis', f.folder, [{ path: f.file, hash: await hashFile(f.file) }])
  await automatic.check() // Attach the real watcher; subsequent changes run without check().
  await writeFile(f.file, 'id,amount\nA,5.00\n')
  const hash = await hashFile(f.file)
  await vi.waitFor(
    () =>
      expect(engine.store.datasets([f.file])[0]?.data).toMatchObject({
        sourceHash: hash,
        status: 'ready',
      }),
    { timeout: 5000 },
  )
  const dataset = engine.store.datasets([f.file])[0]!.data
  const result = (await engine.execute({
    action: 'query',
    paths: [f.file],
    payload: {
      datasetIds: [dataset.id],
      metrics: [{ as: 'total', column: 'c1', op: 'sum' }],
    },
  })) as AnalyticsEnvelope
  expect((result.value as AnalyticsResult).rows).toEqual([{ total: '5.0' }])
  await rm(f.file)
  await vi.waitFor(() => expect(engine.store.datasets([f.file])).toEqual([]), { timeout: 5000 })
})

it('does not let late enrollment undo Stop or Clear', async () => {
  const f = await fixture()
  const sources = [{ path: f.file, hash: await hashFile(f.file) }]
  let allow!: (roots: string[]) => void
  const delayed = new PreparedFileRefresh({
    ...f.options,
    // Keep notification timers outside this deliberately delayed enrollment scenario.
    stableMs: 60000,
    roots: () =>
      new Promise((resolve) => {
        allow = resolve
      }),
  })
  cleanups.push(async () => {
    delayed.stop()
  })
  const pending = delayed.remember('analysis', f.folder, sources)
  await vi.waitFor(() => expect(allow).toBeTypeOf('function'))
  delayed.pause('analysis')
  allow([f.folder])
  await pending
  expect(
    JSON.parse(await readFile(join(f.state, 'prepared-files-v1.json'), 'utf8')).paused,
  ).toEqual(['analysis'])
  allow = undefined!
  const clearing = delayed.remember('analysis', f.folder, sources)
  await vi.waitFor(() => expect(allow).toBeTypeOf('function'))
  await delayed.forget('analysis', f.folder)
  allow([f.folder])
  await clearing
  expect(JSON.parse(await readFile(join(f.state, 'prepared-files-v1.json'), 'utf8')).files).toEqual(
    [],
  )
})
