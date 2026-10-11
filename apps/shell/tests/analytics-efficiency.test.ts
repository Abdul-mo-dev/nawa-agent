import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLoop, type AgentSkill, type AgentStreamRequest } from '@genoffice/agent-core'
import { AnalyticsEngine } from '../src/main/analytics/engine'
import {
  DEFAULT_ANALYTICS_SETTINGS,
  type AnalyticsEnvelope,
  type AnalyticsResult,
  type SourceRef,
} from '../src/shared/analytics-api'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'
import { selectedTableTaskContext } from '../src/renderer/src/analytics/task-context'
import { directoryRoute, routedDirectorySkill } from '../src/renderer/src/directory-actions/routing'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      resolve(dirname(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('nawa-analysis-efficiency-')
    )
      throw new Error('Unexpected test cleanup path.')
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nawa-analysis-efficiency-'))
  directories.push(directory)
  const paths = [join(directory, 'first.csv'), join(directory, 'second.csv')]
  writeFileSync(paths[0], 'id,amount\nA,0.10\nB,0.20\n')
  writeFileSync(paths[1], 'id,amount\nC,0.30\nD,0.40\nE,0.50\n')
  const engine = new AnalyticsEngine(
    join(directory, 'analytics.sqlite3'),
    [directory],
    {
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    },
    () => {},
  )
  try {
    await engine.execute({ action: 'prepare', paths, payload: {} })
    return { engine, paths, directory }
  } catch (error) {
    engine.close()
    throw error
  }
}

async function runAnalysis(
  engine: AnalyticsEngine,
  paths: string[],
  directory: string,
  prefetch: boolean,
  changed = false,
) {
  const sources: SourceRef[] = []
  const saved: AnalyticsResult[] = []
  const analytics = vi.fn(async (action: string, payload: unknown) => {
    const envelope = (await engine.execute({ action, paths, payload })) as AnalyticsEnvelope
    sources.push(...envelope.sources)
    if (action === 'query') saved.push(envelope.value as AnalyticsResult)
    return envelope.value
  })
  const metadata = prefetch ? await selectedTableTaskContext({ analytics }, paths) : ''
  const nativeRead = vi.fn(() => ({ output: '{}', summary: 'Native read' }))
  const part = (names: string[]): AgentSkill => ({
    id: names[0],
    systemPrompt: '',
    tools: names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: nativeRead,
  })
  const question = 'count records and calculate totals in all selected files'
  const routed = routedDirectorySkill(
    directoryRoute(question, { opened: directory, files: paths, directories: [] }),
    {
      reader: part(['list_files']),
      inspection: part(['inspect_file', 'query_file']),
      analytics: analyticsSkill({ analytics, cancel() {} }),
      knowledge: part(['discover_knowledge_tools']),
      mutation: part(['update_file']),
    },
  )
  const requests: AgentStreamRequest[] = []
  const finished = vi.fn(),
    failed = vi.fn()
  const loop = new AgentLoop({
    skill: {
      ...routed,
      get tools() {
        return routed.tools
      },
      get systemPrompt() {
        return routed.systemPrompt
      },
      buildContext: () => (metadata ? `Source-checked schemas:\n${metadata}` : ''),
    },
    transport: {
      stream(request, callbacks) {
        requests.push(structuredClone(request))
        queueMicrotask(() => {
          const results = request.messages.flatMap((message) =>
            message.role === 'tool' ? message.results : [],
          )
          const calculations = results
            .filter((result) => result.name === 'query_data')
            .map((result) => JSON.parse(result.output))
          if (calculations.length) {
            if (changed) writeFileSync(paths[0], 'id,amount\nA,99.00\n')
            callbacks.onDelta(
              calculations
                .map(
                  (result) =>
                    `${basename(result.sources[0].path)}: ${result.rows[0].records} records, total ${result.rows[0].total}. Receipt ${result.id}.`,
                )
                .join('\n'),
            )
          } else {
            const catalog = metadata
              ? JSON.parse(metadata)
              : results.length
                ? JSON.parse(results.at(-1)!.output)
                : null
            if (!catalog)
              callbacks.onToolCall({ id: 'catalog', name: 'discover_datasets', input: {} })
            else
              for (const dataset of catalog.datasets)
                callbacks.onToolCall({
                  id: `query-${dataset.id}`,
                  name: 'query_data',
                  input: {
                    datasetIds: [dataset.id],
                    metrics: [
                      { op: 'count', as: 'records' },
                      { op: 'sum', column: 'c1', as: 'total' },
                    ],
                  },
                })
          }
          callbacks.onDone()
        })
        return { cancel() {} }
      },
    },
    validateResponse: async (text) => {
      const correction = routed.verifyEvidence(text)
      if (correction) throw new Error(correction)
      await engine.verify(sources, paths)
    },
    events: { onDone: finished, onError: failed },
  })
  loop.run(question)
  await vi.waitFor(() => expect(finished.mock.calls.length + failed.mock.calls.length).toBe(1))
  return { requests, finished, failed, saved, analytics, nativeRead }
}

it('answers two-file counts and exact decimal totals in two model requests using the real SQLite engine', async () => {
  const { engine, paths, directory } = await fixture()
  try {
    const baseline = await runAnalysis(engine, paths, directory, false)
    const optimized = await runAnalysis(engine, paths, directory, true)
    expect(baseline.failed).not.toHaveBeenCalled()
    expect(optimized.failed).not.toHaveBeenCalled()
    expect(baseline.requests).toHaveLength(3)
    expect(optimized.requests).toHaveLength(2)
    expect(optimized.analytics.mock.calls.map(([action]) => action)).toEqual([
      'discover',
      'query',
      'query',
    ])
    expect(optimized.nativeRead).not.toHaveBeenCalled()
    expect(optimized.saved.map((result) => result.rows)).toEqual(
      baseline.saved.map((result) => result.rows),
    )
    expect(optimized.saved.map((result) => result.rows[0].records).sort()).toEqual(['2', '3'])
    expect(optimized.saved.map((result) => result.rows[0].total).sort()).toEqual(['0.3', '1.2'])
    expect(
      optimized.saved.every((result) => result.inputSampled === false && result.sql.length > 0),
    ).toBe(true)
    const traffic = (requests: AgentStreamRequest[]) =>
      requests.reduce(
        (bytes, request) => bytes + new TextEncoder().encode(JSON.stringify(request)).length,
        0,
      )
    expect(traffic(optimized.requests)).toBeLessThan(traffic(baseline.requests))
  } finally {
    engine.close()
  }
})

it('still rejects a source change before the final answer on the shorter path', async () => {
  const { engine, paths, directory } = await fixture()
  try {
    const result = await runAnalysis(engine, paths, directory, true, true)
    expect(result.requests).toHaveLength(2)
    expect(result.finished).not.toHaveBeenCalled()
    expect(result.failed).toHaveBeenCalledOnce()
    expect(String(result.failed.mock.calls[0][0])).toContain('source file changed')
  } finally {
    engine.close()
  }
})
