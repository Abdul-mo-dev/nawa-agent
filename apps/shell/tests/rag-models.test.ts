import { afterEach, expect, it, vi } from 'vitest'
import { EmbeddingClient } from '../src/main/rag/embedding'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

afterEach(() => vi.unstubAllGlobals())
it('reads served model IDs through the configured endpoint without sending document content', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'embed.gguf' }, { id: 'embed.gguf' }] })))
  vi.stubGlobal('fetch', fetcher)
  expect(await new EmbeddingClient(DEFAULT_RAG_SETTINGS, 'protected-key').models()).toEqual(['embed.gguf'])
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.toString()).toBe('http://127.0.0.1:8081/v1/models')
  expect(options.method).toBe('GET'); expect(options.body).toBeUndefined(); expect(options.redirect).toBe('error')
  expect(options.headers).toMatchObject({ Authorization: 'Bearer protected-key' })
})
it.each([{ data: [] }, { data: [{ id: '' }] }, { data: 'not-models' }])('rejects an empty or malformed served model list: %j', async body => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
  await expect(new EmbeddingClient(DEFAULT_RAG_SETTINGS).models()).rejects.toThrow()
})
it('reports an HTTP error without exposing the server response body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-debug-key', { status: 401 })))
  await expect(new EmbeddingClient(DEFAULT_RAG_SETTINGS).models()).rejects.toThrow('HTTP 401')
})
