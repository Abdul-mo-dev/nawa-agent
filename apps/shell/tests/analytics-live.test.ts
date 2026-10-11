import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentLoop,
  type AgentRunResult,
  type AgentSkill,
  type AgentToolCall,
} from '@genoffice/agent-core'
import { streamForProvider } from '@genoffice/ai-provider'
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

// Opt-in: ordinary tests do not contact a model or depend on its answers.
const baseUrl = process.env.NAWA_LLAMA_TEST_URL
const model = process.env.NAWA_LLAMA_TEST_MODEL || 'Agent-A1-4B'
const contextTokens = Number(process.env.NAWA_LLAMA_TEST_CONTEXT || 16384)
const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) {
    if (
      resolve(dirname(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('nawa-analysis-live-')
    )
      throw new Error('Unexpected test cleanup path.')
    rmSync(directory, { recursive: true, force: true })
  }
})

interface Measurement {
  requestBytes: number
  promptTokens?: number
  completionTokens?: number
  elapsedMs?: number
  error?: string
}

async function runLive(
  engine: AnalyticsEngine,
  paths: string[],
  directory: string,
  prefetch: boolean,
) {
  const sources: SourceRef[] = []
  const saved: AnalyticsResult[] = []
  const actions: string[] = []
  const calls: AgentToolCall[] = []
  const modelCalls: AgentToolCall[] = []
  const measurements: Measurement[] = []
  const observations: Promise<void>[] = []
  const budgetProbes: { route: string; status: number; inputTokens?: number; error?: unknown }[] =
    []
  const client = {
    async analytics(action: string, payload: unknown) {
      actions.push(action)
      const envelope = (await engine.execute({ action, paths, payload })) as AnalyticsEnvelope
      sources.push(...envelope.sources)
      if (['query', 'sql', 'analyze'].includes(action))
        saved.push(envelope.value as AnalyticsResult)
      return envelope.value
    },
    cancel() {},
  }
  const metadata = prefetch ? await selectedTableTaskContext(client, paths) : ''
  const unsupported = (names: string[]): AgentSkill => ({
    id: names[0],
    systemPrompt: '',
    tools: names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: () => ({
      output: 'This benchmark covers prepared-table analysis; native editor reads are unavailable.',
      summary: 'Native read unavailable in benchmark',
      isError: true,
    }),
  })
  const question =
    'For each selected file separately, count all included records and calculate the sum of amount. Keep decimal totals exact, including values larger than the safe integer limit. Cite the result receipts and keep the answer brief.'
  const routed = routedDirectorySkill(
    directoryRoute(question, { opened: directory, files: paths, directories: [] }),
    {
      reader: unsupported(['list_files']),
      inspection: unsupported(['inspect_file', 'query_file']),
      analytics: analyticsSkill(client),
      knowledge: unsupported(['discover_knowledge_tools']),
      mutation: unsupported(['update_file']),
    },
  )
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (new URL(url).origin !== new URL(baseUrl!).origin)
      throw new Error('The live benchmark may contact only the selected local model endpoint.')
    if (!url.endsWith('/chat/completions')) {
      const response = await originalFetch(input, init)
      if (url.endsWith('/input_tokens')) {
        const counted = await response.clone().json()
        budgetProbes.push({
          route: new URL(url).pathname,
          status: response.status,
          inputTokens: counted.input_tokens,
          error: counted.error,
        })
      }
      return response
    }
    const body = JSON.parse(String(init?.body))
    // Telemetry and a fixed seed; the app's prompt, tools and streaming parser are unchanged.
    body.stream_options = { include_usage: true }
    body.seed = 42
    const encoded = JSON.stringify(body)
    const measurement: Measurement = { requestBytes: Buffer.byteLength(encoded) }
    measurements.push(measurement)
    const started = performance.now()
    const response = await originalFetch(input, { ...init, body: encoded })
    observations.push(
      response
        .clone()
        .text()
        .then((text) => {
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue
            const event = JSON.parse(line.slice(6))
            if (event.usage) {
              measurement.promptTokens = event.usage.prompt_tokens
              measurement.completionTokens = event.usage.completion_tokens
            }
          }
          measurement.elapsedMs = Math.round(performance.now() - started)
        })
        .catch((failure) => {
          measurement.error = String(failure)
          measurement.elapsedMs = Math.round(performance.now() - started)
        }),
    )
    return response
  })
  const started = performance.now()
  let loop: AgentLoop | undefined
  let error: string | undefined
  let result: AgentRunResult | undefined
  try {
    await new Promise<void>((finish) => {
      const timeout = setTimeout(() => {
        error = 'Live analysis exceeded three minutes.'
        loop?.cancel()
        finish()
      }, 180_000)
      const done = () => {
        clearTimeout(timeout)
        finish()
      }
      loop = new AgentLoop({
        maxTurns: 8,
        compaction: false,
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
            const abort = new AbortController()
            void streamForProvider(
              'custom',
              {
                apiKey: '',
                baseUrl,
                model,
                policy: { mode: 'local', contextTokens, outputTokens: 1024 },
              },
              request.system,
              request.messages,
              request.tools,
              1024,
              {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
                onDelta: callbacks.onDelta,
                onToolCall: (call) => {
                  modelCalls.push(structuredClone(call))
                  callbacks.onToolCall(call)
                },
                onReasoningDelta: callbacks.onReasoning,
                onStopReason: callbacks.onStopReason,
              },
            ).then(
              () => callbacks.onDone(),
              (failure) => callbacks.onError(String(failure)),
            )
            return { cancel: () => abort.abort() }
          },
        },
        validateResponse: async (text) => {
          const correction = routed.verifyEvidence(text)
          if (correction) throw new Error(correction)
          await engine.verify(sources, paths)
        },
        events: {
          onToolStart: (call) => calls.push(call),
          onDone: (value) => {
            result = value
            done()
          },
          onError: (message) => {
            error = message
            done()
          },
        },
      })
      loop.run(question)
    })
    await Promise.all(observations)
  } finally {
    vi.unstubAllGlobals()
  }
  return {
    prefetch,
    error,
    result,
    actions,
    calls,
    modelCalls,
    rounds: measurements.length,
    promptTokens: measurements.reduce((sum, value) => sum + (value.promptTokens ?? 0), 0),
    completionTokens: measurements.reduce((sum, value) => sum + (value.completionTokens ?? 0), 0),
    elapsedMs: Math.round(performance.now() - started),
    measurements,
    budgetProbes,
    receipts: saved.map(({ sources, rows, inputSampled, id }) => ({
      id,
      files: sources.map((source) => basename(source.path)),
      rows,
      inputSampled,
    })),
  }
}

it.skipIf(!baseUrl)(
  'benchmarks real model table analysis with and without schema prefetch',
  async () => {
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseUrl!).hostname)
    const report: Record<string, unknown> = {
      model,
      endpoint: baseUrl,
      contextTokens,
      comparison:
        process.env.NAWA_ANALYTICS_TEST_OPTIMIZED_ONLY === '1'
          ? 'Optimized workflow acceptance only; no comparative baseline.'
          : 'Same current workflow, with schema prefetch disabled versus enabled.',
      note: 'Prepared CSV tables and a fixed seed; no UI or native editor execution. Token counts come from model-server usage, including cached prompt tokens. Wall time is affected by prompt caching and run order.',
      scenarios: [],
    }
    const scenarios = report.scenarios as Record<string, unknown>[]
    const reportPath = process.env.NAWA_ANALYTICS_BENCHMARK_REPORT
    const saveReport = () => {
      if (!reportPath) return
      mkdirSync(dirname(resolve(reportPath)), { recursive: true })
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    }
    for (const scenario of [
      {
        name: 'decimal-totals',
        files: ['id,amount\nA,0.10\nB,0.20\n', 'id,amount\nC,0.30\nD,0.40\nE,0.50\n'],
        counts: ['2', '3'],
        totals: ['0.3', '1.2'],
      },
      {
        name: 'beyond-safe-integer',
        files: ['id,amount\nA,9007199254740993.01\nB,0.09\n'],
        counts: ['2'],
        totals: ['9007199254740993.1'],
      },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'nawa-analysis-live-'))
      directories.push(directory)
      const paths = scenario.files.map((content, index) => {
        const path = join(directory, `table-${index + 1}.csv`)
        writeFileSync(path, content)
        return path
      })
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
        const baseline =
          process.env.NAWA_ANALYTICS_TEST_OPTIMIZED_ONLY === '1'
            ? undefined
            : await runLive(engine, paths, directory, false)
        const optimized = await runLive(engine, paths, directory, true)
        scenarios.push({ name: scenario.name, baseline, optimized })
        saveReport()
        // The optimized path must pass. A failed observational baseline is retained
        // in the report and cannot establish a successful-answer savings percentage.
        for (const run of !baseline || baseline.error ? [optimized] : [baseline, optimized]) {
          expect(run.error, JSON.stringify(run)).toBeUndefined()
          expect(run.result).toMatchObject({ cancelled: false, turnLimit: false })
          expect(run.result?.truncated).not.toBe(true)
          expect(run.measurements.every((measurement) => measurement.promptTokens! > 0)).toBe(true)
          for (let index = 0; index < paths.length; index++) {
            const values = run.receipts
              .filter(
                (receipt) =>
                  receipt.files.length === 1 && receipt.files[0] === basename(paths[index]),
              )
              .flatMap((receipt) => receipt.rows.flatMap((row) => Object.values(row)))
            expect(values).toContain(scenario.counts[index])
            // Compare decimal strings without floating-point conversion. Both
            // .10 and .1 carry the same exact value, including large integers.
            const exactValues = values.map((value) =>
              typeof value === 'string' && /^-?\d+\.\d+$/.test(value)
                ? value.replace(/0+$/, '').replace(/\.$/, '')
                : value,
            )
            expect(exactValues).toContain(scenario.totals[index])
            expect(run.result!.text.replaceAll(',', '')).toContain(scenario.totals[index])
          }
          expect(run.receipts.every((receipt) => receipt.inputSampled === false)).toBe(true)
        }
      } finally {
        engine.close()
      }
    }
  },
  780_000,
)
