import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RagSettings } from '../../shared/rag-api'
import { NATIVE_MODEL, NATIVE_MODEL_REVISION } from './config'
import { EmbeddingClient, type EmbeddingProvider, type EmbeddingVector } from './embedding'

interface FeatureExtractor {
  tokenizer: { encode(text: string): number[] }
  (
    text: string,
    options: { pooling: 'mean'; normalize: true },
  ): Promise<{ data: ArrayLike<number> }>
}
interface TextRuntime {
  env: { cacheDir: string }
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: 'q8'; revision: string },
  ): Promise<FeatureExtractor>
}
let loaded: Promise<FeatureExtractor> | null = null
let queue: Promise<unknown> = Promise.resolve()

async function model(stateDirectory: string): Promise<FeatureExtractor> {
  if (!loaded) {
    loaded = (async () => {
      const path = [
        process.resourcesPath ? join(process.resourcesPath, 'embedding', 'runtime.mjs') : '',
        join(__dirname, '../embedding/runtime.mjs'),
        resolve(__dirname, '../../../out/embedding/runtime.mjs'),
      ].find((candidate) => candidate && existsSync(candidate))
      if (!path)
        throw new Error(
          'Native text runtime is missing. Rebuild the shell before using local knowledge.',
        )
      const runtime = (await import(pathToFileURL(path).href)) as TextRuntime
      const { env, pipeline } = runtime
      env.cacheDir = join(stateDirectory, 'models')
      await mkdir(env.cacheDir, { recursive: true })
      return pipeline('feature-extraction', NATIVE_MODEL, {
        dtype: 'q8',
        revision: NATIVE_MODEL_REVISION,
      })
    })().catch((error) => {
      loaded = null
      throw error
    })
  }
  return loaded
}

export class NativeEmbeddingClient implements EmbeddingProvider {
  constructor(
    private stateDirectory: string,
    private signal?: AbortSignal,
  ) {}
  async countTokens(text: string): Promise<number> {
    this.signal?.throwIfAborted()
    const extractor = await model(this.stateDirectory)
    this.signal?.throwIfAborted()
    return extractor.tokenizer.encode(text).length
  }
  async embed(inputs: string[], expectedDimensions = 384): Promise<EmbeddingVector[]> {
    if (!inputs.length) return []
    const run = async (): Promise<EmbeddingVector[]> => {
      this.signal?.throwIfAborted()
      const extractor = await model(this.stateDirectory)
      const vectors: EmbeddingVector[] = []
      for (const input of inputs) {
        this.signal?.throwIfAborted()
        if (extractor.tokenizer.encode(input).length > 512)
          throw new Error('Native embedding input exceeds the model’s 512-token limit.')
        const output = await extractor(input, { pooling: 'mean', normalize: true })
        const values = Float32Array.from(output.data)
        if (values.length !== expectedDimensions || values.some((value) => !Number.isFinite(value)))
          throw new Error('Native embedding model returned invalid dimensions or values.')
        const norm = Math.hypot(...values)
        if (norm < 0.99 || norm > 1.01)
          throw new Error('Native embedding model returned an unnormalized vector.')
        vectors.push({ vector: values, dimensions: values.length })
      }
      return vectors
    }
    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
  }
}

export function embeddingProvider(
  settings: RagSettings,
  key: string,
  signal: AbortSignal,
  stateDirectory: string,
): EmbeddingProvider {
  return settings.backend === 'native'
    ? new NativeEmbeddingClient(stateDirectory, signal)
    : new EmbeddingClient(settings, key, signal)
}
