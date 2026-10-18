import type { LocalModelProfile, LocalModelsConfig } from './local-models-api'

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label}: ${min}–${max}`)
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value))
    throw new Error('Invalid model setting text.')
  return value.trim()
}
// A profile owns these switches. Extra arguments cannot change its endpoint or model.
const reserved = new Set([
  '--host',
  '--port',
  '-m',
  '--model',
  '-a',
  '--alias',
  '--embedding',
  '--embeddings',
  '--pooling',
  '-c',
  '--ctx-size',
  '-ngl',
  '--gpu-layers',
  '--n-gpu-layers',
  '-t',
  '--threads',
  '--models-dir',
  '--models-preset',
  '--models-max',
  '-hf',
  '--hf-repo',
  '--hf-file',
  '--model-url',
  '-mu',
])
export function validateLocalModels(raw: unknown): LocalModelsConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid local model settings.')
  const r = raw as LocalModelsConfig
  if (!Array.isArray(r.profiles) || r.profiles.length > 64)
    throw new Error('At most 64 profiles are supported.')
  const ids = new Set<string>(),
    ports = new Set<number>()
  const profiles = r.profiles.map((p) => {
    if (!p || typeof p !== 'object') throw new Error('Invalid model profile.')
    const id = text(p.id, 80),
      name = text(p.name, 120),
      modelPath = text(p.modelPath, 4096)
    const alias = p.alias === undefined ? undefined : text(p.alias, 256)
    if (!/^[a-zA-Z0-9-]+$/.test(id) || ids.has(id) || !name)
      throw new Error('Use unique profile IDs and a display name.')
    ids.add(id)
    if (p.kind !== 'chat' && p.kind !== 'embedding') throw new Error('Invalid model kind.')
    const port = integer(p.port, 1024, 65535, 'Port')
    if (ports.has(port)) throw new Error('Choose a different port for each profile.')
    ports.add(port)
    if (!['model', 'mean', 'cls', 'last'].includes(p.pooling) || typeof p.autoStart !== 'boolean')
      throw new Error('Invalid model options.')
    if (!Array.isArray(p.arguments) || p.arguments.length > 80)
      throw new Error('Too many launch arguments.')
    const args = p.arguments.map((a) => {
      if (!a || typeof a.enabled !== 'boolean') throw new Error('Invalid launch argument.')
      const name = text(a.name, 100),
        value = text(a.value, 4096)
      if (!/^--?[a-zA-Z][a-zA-Z0-9-]*$/.test(name) || reserved.has(name))
        throw new Error(`Argument is managed by the profile or invalid: ${name}`)
      return { enabled: a.enabled, name, value }
    })
    return {
      id,
      name,
      ...(alias !== undefined ? { alias } : {}),
      kind: p.kind,
      modelPath,
      port,
      pooling: p.pooling,
      autoStart: p.autoStart,
      contextSize: integer(p.contextSize, 128, 1048576, 'Context size'),
      gpuLayers:
        p.gpuLayers === 'auto' ? ('auto' as const) : integer(p.gpuLayers, -1, 999, 'GPU layers'),
      threads: integer(p.threads, 0, 1024, 'CPU threads'),
      arguments: args,
    }
  })
  return { executablePath: text(r.executablePath, 4096), profiles }
}
export function localModelArguments(p: LocalModelProfile): string[] {
  const extra = p.arguments
    .filter((a) => a.enabled)
    .flatMap((a) => (a.value ? [a.name, a.value] : [a.name]))
  return [
    ...extra,
    '--model',
    p.modelPath,
    '--alias',
    localModelAlias(p),
    '--host',
    '127.0.0.1',
    '--port',
    String(p.port),
    '--ctx-size',
    String(p.contextSize),
    '--gpu-layers',
    String(p.gpuLayers),
    ...(p.threads ? ['--threads', String(p.threads)] : []),
    ...(p.kind === 'embedding'
      ? ['--embedding', ...(p.pooling === 'model' ? [] : ['--pooling', p.pooling])]
      : []),
  ]
}
export function localModelAlias(p: LocalModelProfile): string {
  return p.alias?.trim() || p.id
}
/** llama.cpp divides the configured total context between parallel slots. */
export function localChatLimits(p: LocalModelProfile): {
  contextTokens: number
  outputTokens: number
} {
  const value = (names: string[], fallback: number) => {
    const arg = [...p.arguments].reverse().find((a) => a.enabled && names.includes(a.name))
    const n = arg ? Number(arg.value) : fallback
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  const parallel = value(['-np', '--parallel'], 1)
  const contextTokens = Math.floor(p.contextSize / parallel)
  const outputTokens = value(
    ['-n', '--predict', '--n-predict'],
    Math.min(4096, Math.floor(contextTokens / 4)),
  )
  return {
    contextTokens,
    outputTokens: Math.max(1024, Math.min(outputTokens, 131072, Math.floor(contextTokens / 2))),
  }
}
export function localModelCommand(executable: string, p: LocalModelProfile): string {
  return [executable || 'llama-server', ...localModelArguments(p)]
    .map((value) => JSON.stringify(value))
    .join(' ')
}
export function newLocalProfile(
  kind: LocalModelProfile['kind'],
  profiles: LocalModelProfile[],
): LocalModelProfile {
  let port = kind === 'chat' ? 8080 : 8081
  while (profiles.some((p) => p.port === port)) port++
  return {
    id: `local-${crypto.randomUUID()}`,
    name: kind === 'chat' ? 'Chat' : 'Embeddings',
    kind,
    modelPath: '',
    port,
    contextSize: kind === 'chat' ? 8192 : 2048,
    gpuLayers: -1,
    threads: 0,
    pooling: 'mean',
    autoStart: false,
    arguments: kind === 'chat' ? [{ enabled: true, name: '--jinja', value: '' }] : [],
  }
}
