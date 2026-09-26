import type { AiProviderId, AiProviderConfig, AiSettings } from './types'

export interface AiChatModel {
  id: string
  name: string
  provider: AiProviderId
  config: AiProviderConfig
}
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
/** Settings-file migration/validation. A profile never borrows a different profile's credentials. */
export function normalizeChatModels(input: unknown, providers: readonly string[]): AiChatModel[] {
  if (!Array.isArray(input)) return []
  const ids = new Set<string>(), result: AiChatModel[] = []
  for (const value of input.slice(0, 64)) {
    if (!value || typeof value !== 'object') continue
    const id = clean(value.id, 120), name = clean(value.name, 160)
    if (!id || ids.has(id) || !name || !providers.includes(value.provider) || !value.config || typeof value.config !== 'object') continue
    const model = clean(value.config.model, 256)
    if (!model) continue
    ids.add(id)
    result.push({ id, name, provider: value.provider as AiProviderId, config: {
      model, apiKey: clean(value.config.apiKey, 16384),
      ...(typeof value.config.baseUrl === 'string' ? { baseUrl: clean(value.config.baseUrl, 4096) } : {}),
      ...(typeof value.config.cliPath === 'string' ? { cliPath: clean(value.config.cliPath, 4096) } : {}),
    } })
  }
  return result
}
/** Request-local override: never change the global provider or another chat's model. */
export function applyChatModel(settings: AiSettings, requestedId?: string | null): AiSettings {
  const id = requestedId || settings.defaultChatModelId
  if (!id) return settings
  const profile = settings.chatModels?.find(model => model.id === id)
  if (!profile) throw new Error('The selected chat model was removed. Choose another model in this chat.')
  if (!profile.config.model.trim()) throw new Error('Configure a model ID in Settings before sending.')
  return { ...settings, provider: profile.provider,
    providers: { ...settings.providers, [profile.provider]: { ...profile.config } } }
}
export function chatModelLabel(settings: AiSettings, requestedId?: string | null): string {
  const id = requestedId || settings.defaultChatModelId
  const profile = settings.chatModels?.find(model => model.id === id)
  return profile ? `${profile.name} · ${profile.config.model}` : `${settings.provider} · ${settings.providers[settings.provider]?.model || 'default'}`
}

export function validateChatModels(settings: AiSettings): string | null {
  const models = settings.chatModels ?? [], ids = new Set<string>()
  if (models.length > 64) return 'Use no more than 64 saved chat models.'
  for (const model of models) {
    if (!model.id || ids.has(model.id)) return 'Each chat model must have a unique ID.'
    ids.add(model.id)
    if (!model.name.trim() || !model.config.model.trim()) return 'Every saved chat model needs a name and model ID.'
    if (!(model.provider in settings.providers)) return 'Choose a supported provider for every saved model.'
    if (model.provider === 'custom' && !model.config.baseUrl?.trim()) return `Set a base URL for ${model.name}.`
    if (model.config.baseUrl) {
      try {
        const url = new URL(model.config.baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return `Use an HTTP(S) base URL without embedded credentials for ${model.name}.`
      } catch { return `Invalid base URL for ${model.name}.` }
    }
  }
  if (settings.defaultChatModelId && !ids.has(settings.defaultChatModelId)) return 'Choose an existing default chat model.'
  return null
}
/** One editor per WebContentsView: these values are isolated between editor tabs. */
let rendererModelId = ''
let rendererModels: Pick<AiSettings, 'chatModels' | 'defaultChatModelId'> | null = null
export function setRendererChatModel(id: string): void { rendererModelId = id }
export function getRendererChatModel(): string { return rendererModelId }
export function rememberChatModels(settings: AiSettings): AiSettings {
  rendererModels = { chatModels: settings.chatModels, defaultChatModelId: settings.defaultChatModelId }
  return settings
}
export function resolveRendererChatSettings(settings: AiSettings): AiSettings {
  return applyChatModel(rendererModels ? { ...settings, ...rendererModels } : settings, rendererModelId)
}
/** Compared only in memory; never sent as a session ID or written to logs. */
export function chatModelSessionKey(settings: AiSettings): string {
  return JSON.stringify([settings.provider, settings.providers[settings.provider]])
}
