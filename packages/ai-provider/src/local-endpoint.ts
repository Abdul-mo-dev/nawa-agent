import type { AiProviderConfig, AiProviderId, AiSettings } from './types'

/** Model families are default hints; an explicit run location always takes precedence. */
export function isOpenAiCloudModel(model: string): boolean {
  return /^(?:ft:)?(?:gpt-(?!oss(?:-|$))\d|chatgpt-|o[1-9](?:-|$))/i.test(
    model.split('/').pop() ?? '',
  )
}

export function isLocalModelConnection(provider: AiProviderId, config: AiProviderConfig): boolean {
  if (config.policy?.mode) return config.policy.mode === 'local'
  const knownCloud =
    isOpenAiCloudModel(config.model) ||
    /^(?:claude-|gemini-|grok-[2-9])/i.test(config.model.split('/').pop() ?? '')
  return provider === 'custom' && isLoopbackApiUrl(config.baseUrl) && !knownCloud
}

/** Browser-safe detection; remote and LAN endpoints keep their existing policy. */
export function isLoopbackApiUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '')
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    )
  } catch {
    return false
  }
}

export function usesLocalOpenAi(settings: Pick<AiSettings, 'provider' | 'providers'>): boolean {
  const config = settings.providers[settings.provider]
  return !!config && isLocalModelConnection(settings.provider, config)
}
