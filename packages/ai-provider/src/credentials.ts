import type { AiSettings } from './types'

/** A renderer can show that a key exists without receiving its value. */
export const REDACTED_AI_KEY = 'nawa:stored-api-key:v1'

export function redactAiSettings(settings: AiSettings): AiSettings {
  const view = structuredClone(settings)
  const redact = (config: { apiKey: string } | undefined) => {
    if (config?.apiKey) config.apiKey = REDACTED_AI_KEY
  }
  for (const config of Object.values(view.providers)) redact(config)
  for (const profile of view.chatModels ?? []) redact(profile.config)
  for (const config of Object.values(view.media?.providers ?? {})) redact(config)
  for (const config of Object.values(view.search?.providers ?? {})) redact(config)
  return view
}

/** Replace only saved-key markers; typed replacements and explicit removals remain intact. */
export function restoreRedactedAiKeys(view: AiSettings, stored: AiSettings): AiSettings {
  const settings = structuredClone(view)
  const restore = (
    config: { apiKey: string } | undefined,
    saved: { apiKey: string } | undefined,
  ) => {
    if (config?.apiKey === REDACTED_AI_KEY) config.apiKey = saved?.apiKey ?? ''
  }
  for (const [id, config] of Object.entries(settings.providers)) {
    restore(config, stored.providers[id as keyof AiSettings['providers']])
  }
  for (const profile of settings.chatModels ?? []) {
    const saved = stored.chatModels?.find((item) => item.id === profile.id)
    restore(profile.config, saved?.config ?? stored.providers[profile.provider])
  }
  const selected = settings.chatModels?.find((item) => item.id === settings.selectedChatModelId)
  if (selected && selected.provider === settings.provider) {
    settings.providers[selected.provider] = {
      ...settings.providers[selected.provider],
      apiKey: selected.config.apiKey,
    }
  }
  for (const [id, config] of Object.entries(settings.media?.providers ?? {})) {
    restore(
      config,
      stored.media?.providers[id as keyof NonNullable<AiSettings['media']>['providers']],
    )
  }
  for (const [id, config] of Object.entries(settings.search?.providers ?? {})) {
    restore(
      config,
      stored.search?.providers[id as keyof NonNullable<AiSettings['search']>['providers']],
    )
  }
  return settings
}
