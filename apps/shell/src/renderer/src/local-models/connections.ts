import { upsertCustomEndpoint, type AiSettings } from '@genoffice/ai-provider/browser'
import type { LocalModelProfile } from '../../../shared/local-models-api'
import type { RagSettings } from '../../../shared/rag-api'
import { localChatLimits, localModelAlias } from '../../../shared/local-model-command'
export function chatConnection(current: AiSettings, profile: LocalModelProfile): AiSettings {
  const limits = localChatLimits(profile)
  if (profile.kind !== 'chat' || limits.contextTokens < 4096)
    throw new Error('Choose a chat profile with at least 4096 context tokens.')
  const baseUrl = `http://127.0.0.1:${profile.port}/v1`,
    id = `runtime-${profile.id}`
  const config = {
    apiKey: '',
    baseUrl,
    model: localModelAlias(profile),
    policy: {
      mode: 'local' as const,
      contextTokens: limits.contextTokens,
      outputTokens: limits.outputTokens,
    },
  }
  const entry = { id, name: profile.name, provider: 'custom' as const, config }
  return {
    ...upsertCustomEndpoint(current, { id, name: profile.name, ...config }, true),
    provider: 'custom',
    defaultChatModelId: id,
    chatModels: [...(current.chatModels ?? []).filter((p) => p.id !== id), entry],
  }
}
export function embeddingConnection(
  current: RagSettings,
  profile: LocalModelProfile,
  revision: string,
): RagSettings {
  if (profile.kind !== 'embedding') throw new Error('Choose an embedding profile.')
  const embeddingGemma2 =
    /^embeddinggemma-2(?:[.-]|$)/i.test(localModelAlias(profile)) ||
    /(?:^|[\\/])embeddinggemma-2[^\\/]*\.gguf$/i.test(profile.modelPath)
  const maxInputTokens = Math.min(
    embeddingGemma2 ? 8192 : current.maxInputTokens,
    profile.contextSize,
  )
  const chunkTokens = Math.max(64, Math.min(current.chunkTokens, maxInputTokens - 1))
  return {
    ...current,
    backend: 'local',
    enabled: true,
    baseUrl: `http://127.0.0.1:${profile.port}/v1`,
    model: localModelAlias(profile),
    modelRevision: revision,
    allowRemote: false,
    dimensions: 0,
    documentPrefix: embeddingGemma2 ? 'title: none | text: ' : '',
    queryPrefix: embeddingGemma2 ? 'task: search result | query: ' : '',
    tokenizer: 'llama.cpp',
    maxInputTokens,
    chunkTokens,
    overlapTokens: Math.min(current.overlapTokens, Math.floor(chunkTokens / 4)),
  }
}
