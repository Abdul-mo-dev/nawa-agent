import { describe, expect, it } from 'vitest'
import { defaultAiSettings } from '../src/providers'
import { applyChatModel } from '../src/chat-models'
import { resolveCustomEndpoints, selectCustomEndpoint } from '../src/custom-endpoints'
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
  it('redacts every custom endpoint and restores the selected endpoint key without borrowing another server key', () => {
    const stored = resolveCustomEndpoints({
      ...settings(),
      customEndpoint: 'first',
      customEndpoints: [
        {
          id: 'first',
          name: 'First',
          apiKey: 'first-server-secret',
          model: 'first',
          baseUrl: 'http://localhost:8001/v1',
        },
        {
          id: 'second',
          name: 'Second',
          apiKey: 'second-server-secret',
          model: 'second',
          baseUrl: 'http://localhost:8002/v1',
        },
      ],
    })
    const view = redactAiSettings(stored)
    expect(JSON.stringify(view)).not.toContain('server-secret')
    expect(view.customEndpoints?.every((endpoint) => endpoint.apiKey === REDACTED_AI_KEY)).toBe(
      true,
    )
    const selected = restoreRedactedAiKeys(selectCustomEndpoint(view, 'second'), stored)
    expect(selected.providers.custom.apiKey).toBe('second-server-secret')
    expect(selected.customEndpoints?.[0]?.apiKey).toBe('first-server-secret')
    expect(selected.customEndpoints?.[1]?.apiKey).toBe('second-server-secret')
    const profile = restoreRedactedAiKeys(
      applyChatModel(selectCustomEndpoint(view, 'second'), 'writer'),
      stored,
    )
    expect(profile.providers.custom.apiKey).toBe('profile-secret')
    view.customEndpoints![1]!.apiKey = ''
    expect(
      restoreRedactedAiKeys(selectCustomEndpoint(view, 'second'), stored).providers.custom.apiKey,
    ).toBe('')
  })

  it('restores a legacy provider key when its first endpoint list is created in the renderer', () => {
    const stored = settings()
    const view = resolveCustomEndpoints(redactAiSettings(stored))
    const restored = restoreRedactedAiKeys(view, stored)
    expect(restored.customEndpoints?.[0]?.apiKey).toBe('provider-secret')
    expect(restored.providers.custom.apiKey).toBe('provider-secret')
  })

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
