import { describe, expect, it } from 'vitest'
import { defaultAiSettings } from '../src/providers'
import { applyChatModel } from '../src/chat-models'
import { REDACTED_AI_KEY, redactAiSettings, restoreRedactedAiKeys } from '../src/credentials'

const settings = () => {
  const value = defaultAiSettings()
  value.provider = 'custom'
  value.providers.custom = {
    apiKey: 'provider-secret',
    model: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
  }
  value.chatModels = [
    {
      id: 'writer',
      name: 'Writer',
      provider: 'custom',
      config: { apiKey: 'profile-secret', model: 'writer', baseUrl: 'http://127.0.0.1:8000/v1' },
    },
  ]
  value.media!.providers.openai.apiKey = 'media-secret'
  value.search!.providers.tavily.apiKey = 'search-secret'
  return value
}

describe('renderer AI settings view', () => {
  it('hides every saved key while retaining configured-provider and profile selection', () => {
    const stored = settings()
    const view = redactAiSettings(stored)
    expect(JSON.stringify(view)).not.toMatch(
      /provider-secret|profile-secret|media-secret|search-secret/,
    )
    expect(view.providers.custom.apiKey).toBe(REDACTED_AI_KEY)
    const selected = restoreRedactedAiKeys(applyChatModel(view, 'writer'), stored)
    expect(selected.providers.custom.apiKey).toBe('profile-secret')
    expect(view.chatModels?.[0]?.config.apiKey).toBe(REDACTED_AI_KEY)
    expect(view.media?.providers.openai.apiKey).toBe(REDACTED_AI_KEY)
    expect(view.search?.providers.tavily.apiKey).toBe(REDACTED_AI_KEY)
    expect(applyChatModel(view, 'writer').selectedChatModelId).toBe('writer')
    expect(stored.providers.custom.apiKey).toBe('provider-secret')
  })

  it('preserves saved keys on save while honoring replacements and removals', () => {
    const stored = settings()
    const view = redactAiSettings(stored)
    view.providers.custom.model = 'updated'
    view.media!.providers.openai.apiKey = 'replacement'
    view.search!.providers.tavily.apiKey = ''
    const restored = restoreRedactedAiKeys(view, stored)
    expect(restored.providers.custom).toMatchObject({ apiKey: 'provider-secret', model: 'updated' })
    expect(restored.chatModels?.[0]?.config.apiKey).toBe('profile-secret')
    expect(restored.media?.providers.openai.apiKey).toBe('replacement')
    expect(restored.search?.providers.tavily.apiKey).toBe('')
    expect(view.providers.custom.apiKey).toBe(REDACTED_AI_KEY)
  })

  it('copies a provider key into a newly added profile without exposing it', () => {
    const stored = settings()
    const view = redactAiSettings(stored)
    view.chatModels!.push({
      id: 'new',
      name: 'New',
      provider: 'custom',
      config: { ...view.providers.custom },
    })
    expect(restoreRedactedAiKeys(view, stored).chatModels?.[1]?.config.apiKey).toBe(
      'provider-secret',
    )
  })
})
