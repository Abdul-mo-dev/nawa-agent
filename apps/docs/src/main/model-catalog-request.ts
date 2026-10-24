import { REDACTED_AI_KEY, type AiSettings } from '@genoffice/ai-provider'

/** A redacted key may only resolve back to the exact server that owns it. */
export function resolveModelCatalogRequest(
  input: unknown,
  settings: AiSettings,
): { baseUrl: string; apiKey?: string } {
  if (!input || typeof input !== 'object') return { baseUrl: '' }
  const request = input as { baseUrl?: unknown; apiKey?: unknown; profileId?: unknown }
  if (typeof request.baseUrl !== 'string') return { baseUrl: '' }
  const baseUrl = request.baseUrl.trim()
  if (request.apiKey !== REDACTED_AI_KEY) {
    return { baseUrl, ...(typeof request.apiKey === 'string' ? { apiKey: request.apiKey } : {}) }
  }
  const keyForUrl = (value: string): string => {
    try {
      const url = new URL(value)
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return ''
      url.hash = ''
      return url.toString().replace(/\/+$/, '')
    } catch {
      return ''
    }
  }
  const target = keyForUrl(baseUrl)
  if (!target) return { baseUrl: '' }
  if (request.profileId !== undefined) {
    const profile = settings.chatModels?.find(
      (model) => model.id === request.profileId && model.provider === 'custom',
    )
    if (!profile || keyForUrl(profile.config.baseUrl ?? '') !== target) return { baseUrl: '' }
    const apiKey = profile.config.apiKey
    return apiKey && apiKey !== REDACTED_AI_KEY ? { baseUrl, apiKey } : { baseUrl: '' }
  }
  const candidates = [
    ...Object.values(settings.providers),
    ...(settings.customEndpoints ?? []),
    ...(settings.chatModels ?? []).map((model) => model.config),
  ]
  const keys = new Set(
    candidates
      .filter((config) => config?.baseUrl && keyForUrl(config.baseUrl) === target)
      .map((config) => config.apiKey)
      .filter((key) => key && key !== REDACTED_AI_KEY),
  )
  // Two accounts at one URL need an explicit key; choosing one could reveal the
  // wrong account's catalogue. An edited address never receives a saved key.
  if (keys.size !== 1) return { baseUrl: '' }
  return { baseUrl, apiKey: keys.values().next().value! }
}
