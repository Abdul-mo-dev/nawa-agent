/** Integration check: the packaged text-only build must preserve tokenization
 * and normalized vectors from the pinned upstream model in all shipped languages. */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import * as textRuntime from '../apps/shell/out/embedding/runtime.mjs'

const model = 'Xenova/multilingual-e5-small'
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const cache = resolve('.task/embedding-parity-cache')
await mkdir(cache, { recursive: true })
env.cacheDir = textRuntime.env.cacheDir = cache
if (process.argv.includes('--offline'))
  env.allowRemoteModels = textRuntime.env.allowRemoteModels = false
const texts = [
  'query: local document search',
  'query: البحث في المستندات المحلية',
  'query: ローカル文書の検索',
]
async function results(create) {
  const extractor = await create('feature-extraction', model, { dtype: 'q8', revision })
  try {
    const output = []
    for (const text of texts) {
      const tokens = extractor.tokenizer.encode(text)
      const vector = await extractor(text, { pooling: 'mean', normalize: true })
      output.push({ tokens, values: Array.from(vector.data) })
    }
    return output
  } finally {
    await extractor.dispose()
  }
}
const baseline = await results(pipeline)
const actual = await results(textRuntime.pipeline)
for (let index = 0; index < texts.length; index++) {
  if (JSON.stringify(baseline[index].tokens) !== JSON.stringify(actual[index].tokens))
    throw new Error(`Tokenizer drift for language ${index}`)
  const expected = baseline[index].values,
    received = actual[index].values
  if (
    expected.length !== 384 ||
    received.length !== 384 ||
    received.some((value, i) => !Number.isFinite(value) || Math.abs(value - expected[i]) > 1e-5)
  )
    throw new Error(`Embedding vector drift for language ${index}`)
}
console.log(
  'English, Arabic and Japanese token IDs and normalized 384-dimensional embeddings match upstream.',
)
