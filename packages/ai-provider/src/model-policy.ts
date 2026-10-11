import type { AiModelPolicy, AiProviderConfig, AiProviderId, AiSettings } from './types'
import { isLocalModelConnection } from './local-endpoint'
import { AI_PROVIDER_VISION, modelLacksVision } from './model-vision'

export function normalizeModelPolicy(raw: unknown): AiModelPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as AiModelPolicy
  const bound = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n)
      ? Math.max(min, Math.min(max, Math.floor(n)))
      : undefined
  return {
    ...(value.mode === 'local' || value.mode === 'cloud' ? { mode: value.mode } : {}),
    ...(bound(value.contextTokens, 4096, 2_000_000)
      ? { contextTokens: bound(value.contextTokens, 4096, 2_000_000) }
      : {}),
    ...(bound(value.outputTokens, 1024, 131072)
      ? { outputTokens: bound(value.outputTokens, 1024, 131072) }
      : {}),
    ...(value.outputField === 'max_tokens' || value.outputField === 'max_completion_tokens'
      ? { outputField: value.outputField }
      : {}),
    ...(typeof value.vision === 'boolean' ? { vision: value.vision } : {}),
    ...(value.tested &&
    typeof value.tested.identity === 'string' &&
    value.tested.identity.length <= 8192 &&
    Number.isFinite(value.tested.at) &&
    typeof value.tested.tools === 'boolean' &&
    (value.tested.vision === undefined || typeof value.tested.vision === 'boolean')
      ? {
          tested: {
            identity: value.tested.identity,
            at: value.tested.at,
            tools: value.tested.tools,
            ...(value.tested.vision !== undefined ? { vision: value.tested.vision } : {}),
          },
        }
      : {}),
  }
}

/** Non-secret binding prevents a result for one model/endpoint being reused for another. */
export function modelCapabilityIdentity(provider: AiProviderId, config: AiProviderConfig): string {
  return JSON.stringify([
    provider,
    config.model.trim(),
    config.baseUrl?.trim().replace(/\/$/, '') ?? '',
    config.cliPath?.trim() ?? '',
  ])
}

export function modelPolicyOf(
  provider: AiProviderId,
  config: AiProviderConfig,
  legacyOutput?: number,
) {
  const policy = normalizeModelPolicy(config.policy)
  const local = isLocalModelConnection(provider, { ...config, policy })
  const contextTokens = policy?.contextTokens ?? (local ? 16384 : 65536)
  const requested =
    policy?.outputTokens ??
    (typeof legacyOutput === 'number' && Number.isFinite(legacyOutput)
      ? legacyOutput
      : undefined) ??
    (local ? 4096 : 8192)
  const outputTokens = Math.max(
    1024,
    Math.min(Math.floor(requested), 131072, Math.floor(contextTokens / 2)),
  )
  const tested =
    policy?.tested?.identity === modelCapabilityIdentity(provider, config)
      ? policy.tested
      : undefined
  return {
    local,
    contextTokens,
    outputTokens,
    outputField: policy?.outputField,
    vision: tested?.vision ?? policy?.vision,
    tools: tested?.tools,
  }
}

/** Shared outer/child loop policy; the dispatch budget additionally covers system and schemas. */
export function agentPolicyOf(settings: AiSettings) {
  if (!settings.providers[settings.provider])
    throw new Error('Choose and configure a chat provider in Settings.')
  const policy = modelPolicyOf(
    settings.provider,
    settings.providers[settings.provider],
    settings.selectedChatModelId ? undefined : settings.maxOutputTokens,
  )
  return {
    maxTurns: policy.local ? 24 : 60,
    maxHistory: policy.local ? 20 : 40,
    compaction: {
      maxBytes: policy.local ? 24 * 1024 : 128 * 1024,
      keepRecentBytes: policy.local ? 8 * 1024 : 32 * 1024,
      disableLlmSummary: true,
    },
  }
}

export function validateModelPolicy(
  provider: AiProviderId,
  config: AiProviderConfig,
): string | null {
  if (!config) return 'Choose and configure a chat provider in Settings.'
  const policy = config.policy
  if (
    policy?.contextTokens !== undefined &&
    (!Number.isInteger(policy.contextTokens) ||
      policy.contextTokens < 4096 ||
      policy.contextTokens > 2_000_000)
  )
    return 'Use a context limit between 4,096 and 2,000,000 tokens.'
  if (
    policy?.outputTokens !== undefined &&
    (!Number.isInteger(policy.outputTokens) ||
      policy.outputTokens < 1024 ||
      policy.outputTokens > 131072 ||
      policy.outputTokens > modelPolicyOf(provider, config).contextTokens / 2)
  )
    return 'Leave at least half the context limit available for input.'
  return null
}

export function modelSupportsVision(settings: AiSettings): boolean {
  const config = settings.providers[settings.provider]
  if (!config) return false
  const policy = config && modelPolicyOf(settings.provider, config)
  if (policy?.vision !== undefined) return policy.vision
  // Custom servers require an explicit capability or successful vision test.
  if (settings.provider === 'custom') return false
  if (modelLacksVision(config.model)) return false
  return (
    AI_PROVIDER_VISION[settings.provider] ||
    /^(gpt-|o[134](?:-|$)|claude-|gemini-|grok-|deep-seek-v4\.1-flash|qwen.*vl)/i.test(config.model)
  )
}
