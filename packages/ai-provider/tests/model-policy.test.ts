import { afterEach, expect, it, vi } from 'vitest'
import { defaultAiSettings, activeProvider } from '../src/providers'
import { applyChatModel } from '../src/chat-models'
import {
  agentPolicyOf,
  modelCapabilityIdentity,
  modelPolicyOf,
  modelSupportsVision,
  validateModelPolicy,
} from '../src/model-policy'
import {
  prepareModelRequest,
  estimatedPromptTokens,
  estimatedOpenAiPromptTokens,
  boundedToolEvidence,
} from '../src/request-budget'
import { streamForProvider } from '../src/stream'
import { chatForProvider } from '../src/chat'
import { jsonResponse } from './test-utils'
import type { AgentMessage } from '@genoffice/agent-core'

afterEach(() => vi.unstubAllGlobals())
const signal = () => new AbortController().signal
const local = { apiKey: '', model: 'local', baseUrl: 'http://127.0.0.1:8082/v1' }

it('recognizes a cloud GPT model behind localhost without changing its endpoint', () => {
  const config = { ...local, model: 'gpt-6-luna' }
  expect(modelPolicyOf('custom', config)).toMatchObject({
    local: false,
    contextTokens: 65536,
    outputTokens: 8192,
  })
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = config
  expect(agentPolicyOf(settings)).toMatchObject({ maxTurns: 60, maxHistory: 40 })
  expect(config.baseUrl).toBe(local.baseUrl)
})

it('retains explicit local/cloud choices and configured context limits', () => {
  expect(
    modelPolicyOf('custom', {
      ...local,
      model: 'gpt-6-luna',
      policy: { mode: 'local', contextTokens: 8192 },
    }),
  ).toMatchObject({ local: true, contextTokens: 8192, outputTokens: 4096 })
  expect(
    modelPolicyOf('custom', { ...local, model: 'gemma-4-e4b', policy: { mode: 'cloud' } }),
  ).toMatchObject({ local: false, contextTokens: 65536 })
  expect(modelPolicyOf('custom', { ...local, model: 'gpt-oss-20b' })).toMatchObject({
    local: true,
    contextTokens: 16384,
  })
  expect(modelPolicyOf('custom', { ...local, model: 'gemma-4-e4b' })).toMatchObject({
    local: true,
    contextTokens: 16384,
  })
})

it('allows a full cloud tool request that fits 16K despite a larger byte count', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const config = {
    ...local,
    model: 'gpt-6-luna',
    policy: { contextTokens: 16384, outputTokens: 4096 },
  }
  const system = 'Use the complete native analytical table. '.repeat(600)
  const messages: AgentMessage[] = [{ role: 'user', text: 'Count employee records.' }]
  const tools = [
    {
      name: 'query_data',
      description: 'Query the selected table',
      inputSchema: {
        type: 'object',
        properties: { datasetIds: { type: 'array', items: { type: 'string' } } },
      },
    },
  ]
  expect(estimatedPromptTokens(system, messages, tools)).toBeGreaterThan(11468)
  const prepared = await prepareModelRequest(
    'custom',
    config,
    config.baseUrl,
    system,
    messages,
    tools,
    4096,
    signal(),
  )
  expect(prepared.promptTokens).toBeLessThan(11468)
  expect(prepared.messages).toEqual(messages)
  expect(fetch).not.toHaveBeenCalled()
})

it('still rejects truly oversized cloud schemas before calling the provider', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const config = {
    ...local,
    model: 'gpt-6-luna',
    policy: { contextTokens: 16384, outputTokens: 4096 },
  }
  const tools = [
    {
      name: 'query_data',
      description: Array.from(
        { length: 6000 },
        (_, i) => `column_${i}: unique measurement ${i}`,
      ).join('\n'),
      inputSchema: {},
    },
  ]
  await expect(
    prepareModelRequest(
      'custom',
      config,
      config.baseUrl,
      '',
      [{ role: 'user', text: 'Count' }],
      tools,
      4096,
      signal(),
    ),
  ).rejects.toThrow('configured context 16384')
  expect(fetch).not.toHaveBeenCalled()
})

it('counts multilingual text and literal special-token markers without treating bytes as tokens', async () => {
  const messages: AgentMessage[] = [
    { role: 'user', text: 'عدد الموظفين 日本語の従業員数 中文员工数量 <|endoftext|>'.repeat(100) },
  ]
  const count = await estimatedOpenAiPromptTokens('gpt-4o', '', messages, [])
  expect(count).toBeGreaterThan(1000)
  expect(count).toBeLessThan(estimatedPromptTokens('', messages, []))
})

it('retains an explicit vision reserve without tokenizing base64 image bytes', async () => {
  const messages: AgentMessage[] = [
    { role: 'user', text: 'Inspect', images: [{ mime: 'image/png', base64: 'A'.repeat(100000) }] },
  ]
  const count = await estimatedOpenAiPromptTokens('gpt-4o', '', messages, [])
  expect(count).toBeGreaterThan(8192)
  expect(count).toBeLessThan(10000)
})

it('keeps independent local, LAN and cloud limits when switching profiles', () => {
  const settings = defaultAiSettings()
  settings.maxOutputTokens = 32768
  settings.chatModels = [
    {
      id: 'local',
      name: 'Local',
      provider: 'custom',
      config: { ...local, policy: { contextTokens: 16384, outputTokens: 2048 } },
    },
    {
      id: 'cloud',
      name: 'Cloud',
      provider: 'openai',
      config: {
        apiKey: 'key',
        model: 'gpt-fixture',
        policy: { contextTokens: 65536, outputTokens: 8192 },
      },
    },
    {
      id: 'lan',
      name: 'LAN',
      provider: 'custom',
      config: { ...local, baseUrl: 'http://192.168.1.10/v1', policy: { mode: 'local' } },
    },
  ]
  expect(
    modelPolicyOf('custom', applyChatModel(settings, 'local').providers.custom).outputTokens,
  ).toBe(2048)
  expect(
    modelPolicyOf('openai', applyChatModel(settings, 'cloud').providers.openai).outputTokens,
  ).toBe(8192)
  expect(agentPolicyOf(applyChatModel(settings, 'lan'))).toMatchObject({
    maxTurns: 24,
    maxHistory: 20,
    compaction: { disableLlmSummary: true },
  })
  expect(agentPolicyOf(applyChatModel(settings, 'cloud'))).toMatchObject({
    maxTurns: 60,
    maxHistory: 40,
  })
  expect(settings.maxOutputTokens).toBe(32768)
})

it('binds capability results to endpoint/model and does not assume Custom vision', () => {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = local
  expect(modelSupportsVision(settings)).toBe(false)
  const tested = {
    identity: modelCapabilityIdentity('custom', local),
    at: 1,
    tools: false,
    vision: true,
  }
  const config = { ...local, policy: { tested } }
  expect(modelPolicyOf('custom', config)).toMatchObject({ tools: false, vision: true })
  expect(modelPolicyOf('custom', { ...config, model: 'different' })).toMatchObject({
    tools: undefined,
    vision: undefined,
  })
  expect(
    modelPolicyOf('custom', { ...config, baseUrl: 'http://127.0.0.1:8083/v1' }).tools,
  ).toBeUndefined()
  expect(
    validateModelPolicy('custom', {
      ...local,
      policy: { contextTokens: 4096, outputTokens: 3000 },
    }),
  ).toContain('half')
})

it.each([
  ['minimax', 'MiniMax-M3', true],
  ['minimax', 'MiniMax-M2.7', false],
  ['atlascloud', 'minimaxai/minimax-m3', false],
  ['atlascloud', 'zai-org/glm-5.3', false],
  ['atlascloud', 'zai-org/glm-5.3-flash', true],
  ['deepseek', 'deepseek-v4-pro', false],
  ['deepseek', 'deep-seek-v4.1-flash', true],
  ['kimi', 'kimi-k3', true],
  ['ling', 'Ling-3.0-flash', false],
  ['ling', 'Ling-3.0-flash-VL', true],
  ['longcat', 'LongCat-2.0', false],
  ['longcat', 'LongCat-2.5-Preview', true],
  ['glm', 'glm-5.3', false],
  ['qwen', 'qwen3-vl', true],
  ['custom', 'MiniMax-M3', false],
] as const)('uses current vision capabilities for %s / %s', (provider, model, expected) => {
  const settings = defaultAiSettings()
  settings.provider = provider
  settings.providers[provider] = { apiKey: '', model }
  expect(modelSupportsVision(settings)).toBe(expected)
})

it('lets explicit and endpoint-bound tested vision capabilities refine registry defaults', () => {
  const settings = defaultAiSettings()
  settings.provider = 'minimax'
  const config = { apiKey: '', model: 'MiniMax-M3', policy: { vision: false } }
  settings.providers.minimax = config
  expect(modelSupportsVision(settings)).toBe(false)
  settings.providers.minimax = {
    ...config,
    policy: {
      vision: false,
      tested: {
        identity: modelCapabilityIdentity('minimax', config),
        at: 1,
        tools: true,
        vision: true,
      },
    },
  }
  expect(modelSupportsVision(settings)).toBe(true)
  settings.providers.minimax.model = 'MiniMax-M2.7'
  expect(modelSupportsVision(settings)).toBe(false)
})

it('does not silently move a half-configured local request to a cloud provider', () => {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = { ...local, model: '' }
  expect(activeProvider(settings)).toBe('custom')
})

it('counts system, schemas and opaque provider state, then rejects oversized active input', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const messages: AgentMessage[] = [{ role: 'user', text: 'small' }]
  const tools = [
    {
      name: 'inspect',
      description: Array.from(
        { length: 3000 },
        (_, i) => `field_${i}: inspect this attribute`,
      ).join('\n'),
      inputSchema: { type: 'object' },
    },
  ]
  const config = {
    apiKey: 'key',
    model: 'cloud',
    policy: { contextTokens: 4096, outputTokens: 1024 },
  }
  await expect(
    prepareModelRequest(
      'openai',
      config,
      'https://api.example/v1',
      'system',
      messages,
      tools,
      1024,
      signal(),
    ),
  ).rejects.toThrow('context budget')
  expect(fetch).not.toHaveBeenCalled()
  expect(estimatedPromptTokens('X'.repeat(1000), messages, [])).toBeGreaterThan(
    estimatedPromptTokens('', messages, []),
  )
  const signed: AgentMessage[] = [
    ...messages,
    {
      role: 'assistant',
      text: '',
      providerState: {
        protocol: 'gemini',
        endpoint: 'x',
        model: 'x',
        parts: [{ thoughtSignature: 'opaque'.repeat(500) }],
      },
    },
  ]
  expect(estimatedPromptTokens('', signed, [])).toBeGreaterThan(3000)
})

it('budgets Gemini schemas after expanding repeated references', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const tools = [
    {
      name: 'inspect',
      description: 'Inspect a record',
      inputSchema: {
        type: 'object',
        $defs: { value: { type: 'string', description: 'X'.repeat(1000) } },
        properties: Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => ['field_' + i, { $ref: '#/$defs/value' }]),
        ),
      },
    },
  ]
  const messages: AgentMessage[] = [{ role: 'user', text: 'Inspect' }]
  expect(estimatedPromptTokens('', messages, tools)).toBeLessThan(6656)
  await expect(
    prepareModelRequest(
      'gemini',
      { apiKey: 'key', model: 'gemini-test', policy: { contextTokens: 8192, outputTokens: 1024 } },
      'https://generativelanguage.googleapis.com/v1beta',
      '',
      messages,
      tools,
      1024,
      signal(),
    ),
  ).rejects.toThrow('context budget')
  expect(fetch).not.toHaveBeenCalled()
})

it('uses llama.cpp full chat token counting including every tool schema', async () => {
  const fetch = vi.fn().mockResolvedValue(jsonResponse({ input_tokens: 1200 }))
  vi.stubGlobal('fetch', fetch)
  const tools = [
    {
      name: 'native_tool',
      description: 'X'.repeat(18000),
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    },
  ]
  const prepared = await prepareModelRequest(
    'custom',
    local,
    local.baseUrl,
    'complete system',
    [{ role: 'user', text: 'task' }],
    tools,
    4096,
    signal(),
  )
  expect(prepared.promptTokens).toBe(1200)
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('http://127.0.0.1:8082/v1/chat/completions/input_tokens')
  const body = JSON.parse(init.body)
  expect(body.model).toBe('local')
  expect(body.messages[0].content).toBe('complete system')
  expect(body.tools[0].function.parameters).toEqual(tools[0].inputSchema)
})

it('preserves the current signed tool chain while dropping completed exchanges', async () => {
  const state = {
    protocol: 'gemini' as const,
    model: 'gemini-test',
    endpoint: 'x',
    parts: [{ thoughtSignature: 's', functionCall: { name: 'read', args: {} } }],
  }
  const active: AgentMessage[] = [
    { role: 'user', text: 'current task' },
    {
      role: 'assistant',
      text: '',
      providerState: state,
      toolCalls: [{ id: 'call', name: 'read', input: {} }],
    },
    { role: 'tool', results: [{ id: 'call', name: 'read', output: 'verified' }] },
  ]
  const messages: AgentMessage[] = [
    { role: 'user', text: 'old' },
    { role: 'assistant', text: 'X'.repeat(10000) },
    ...active,
  ]
  const result = await prepareModelRequest(
    'gemini',
    { apiKey: 'key', model: 'gemini-test', policy: { contextTokens: 4096, outputTokens: 1024 } },
    'x',
    '',
    messages,
    [],
    1024,
    signal(),
  )
  expect(result.messages).toEqual(active)
  expect(messages).toHaveLength(5)
})

it.each([
  'Correct the unsupported claim.',
  'The turn limit is reached; answer from the gathered evidence.',
])(
  'keeps the actual task and receipts when internal guidance follows an oversized tool result: %s',
  async (guidance) => {
    const active: AgentMessage[] = [
      { role: 'user', text: 'Count records in the selected employees.csv.' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'query', name: 'query_data', input: {} }] },
      {
        role: 'tool',
        results: [
          {
            id: 'query',
            name: 'query_data',
            output: JSON.stringify({
              id: 'analysis_123',
              rows: Array.from({ length: 1000 }, (_, index) => ({ index, value: 'record' })),
            }),
          },
        ],
      },
      { role: 'assistant', text: 'Draft answer' },
      { role: 'user', text: guidance, continuation: true },
    ]
    const result = await prepareModelRequest(
      'gemini',
      { apiKey: 'key', model: 'gemini-test', policy: { contextTokens: 4096, outputTokens: 1024 } },
      'https://example.invalid',
      '',
      [
        { role: 'user', text: 'old task' },
        { role: 'assistant', text: 'x'.repeat(10000) },
        ...active,
      ],
      [],
      1024,
      signal(),
    )
    expect(result.messages[0]).toEqual(active[0])
    expect(result.messages.at(-1)).toEqual(active.at(-1))
    const evidence = result.messages.find((message) => message.role === 'tool')
    expect(evidence?.role === 'tool' && JSON.parse(evidence.results[0]!.output)).toMatchObject({
      id: 'analysis_123',
      contextTruncated: true,
      rowsOmitted: 995,
    })
  },
)

it('rejects an oversized active instruction instead of replacing it with its correction', async () => {
  await expect(
    prepareModelRequest(
      'gemini',
      { apiKey: 'key', model: 'gemini-test', policy: { contextTokens: 4096, outputTokens: 1024 } },
      'https://example.invalid',
      '',
      [
        { role: 'user', text: 'important original instruction '.repeat(500) },
        { role: 'assistant', text: 'Draft' },
        { role: 'user', text: 'Correct it.', continuation: true },
      ],
      [],
      1024,
      signal(),
    ),
  ).rejects.toThrow('context budget')
})

it('retains an auditable receipt and labels omitted rows instead of cutting JSON', () => {
  const preview = JSON.parse(
    boundedToolEvidence(
      JSON.stringify({
        id: 'analysis_123',
        sourceHash: 'a'.repeat(64),
        totalResultRows: 490,
        displayedRows: 490,
        rows: Array.from({ length: 490 }, (_, i) => ({ product: 'product_' + i, value: i })),
      }),
      2000,
    ),
  )
  expect(preview).toMatchObject({
    id: 'analysis_123',
    totalResultRows: 490,
    contextTruncated: true,
    outputTruncated: true,
    displayedRows: 5,
    rowsOmitted: 485,
  })
  const nested = boundedToolEvidence(
    JSON.stringify({
      id: 'receipt',
      sources: Array.from({ length: 100 }, () => ({ path: 'x'.repeat(10000) })),
      rows: [],
    }),
    2000,
  )
  expect(nested.length).toBeLessThanOrEqual(2000)
  expect(JSON.parse(nested)).toMatchObject({
    id: 'receipt',
    sourceCount: 100,
    contextTruncated: true,
  })
})

it('supports Custom max_completion_tokens consistently in stream and helper calls', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
      ),
    )
  vi.stubGlobal('fetch', fetch)
  const config = {
    ...local,
    policy: { outputTokens: 2048, outputField: 'max_completion_tokens' as const },
  }
  await chatForProvider('custom', config, '', 'question')
  await streamForProvider('custom', config, '', [{ role: 'user', text: 'question' }], [], 4096, {
    signal: signal(),
    onDelta() {},
    onToolCall() {},
  })
  for (const [, init] of fetch.mock.calls) {
    expect(JSON.parse(init.body)).toMatchObject({ max_completion_tokens: 2048 })
    expect(JSON.parse(init.body)).not.toHaveProperty('max_tokens')
  }
})
