import { describe, expect, it } from 'vitest'
import { defaultAiSettings, REDACTED_AI_KEY } from '@genoffice/ai-provider'
import { resolveModelCatalogRequest } from '../src/main/model-catalog-request'

describe('saved credentials for model discovery', () => {
  it('uses a saved key for its exact server without sending it to an edited address', () => {
    const settings = defaultAiSettings()
    settings.providers.custom = {
      baseUrl: 'https://models.example/v1',
      apiKey: 'saved',
      model: 'a',
    }
    expect(
      resolveModelCatalogRequest(
        { baseUrl: 'https://models.example/v1/', apiKey: REDACTED_AI_KEY },
        settings,
      ),
    ).toEqual({ baseUrl: 'https://models.example/v1/', apiKey: 'saved' })
    expect(
      resolveModelCatalogRequest(
        { baseUrl: 'https://other.example/v1', apiKey: REDACTED_AI_KEY },
        settings,
      ),
    ).toEqual({ baseUrl: '' })
  })

  it('declines ambiguous account keys at the same endpoint', () => {
    const settings = defaultAiSettings()
    settings.customEndpoints = [
      {
        id: 'first',
        name: 'First',
        baseUrl: 'https://models.example/v1',
        apiKey: 'first-key',
        model: 'a',
      },
      {
        id: 'second',
        name: 'Second',
        baseUrl: 'https://models.example/v1',
        apiKey: 'second-key',
        model: 'b',
      },
    ]
    expect(
      resolveModelCatalogRequest(
        { baseUrl: 'https://models.example/v1', apiKey: REDACTED_AI_KEY },
        settings,
      ),
    ).toEqual({ baseUrl: '' })
    expect(
      resolveModelCatalogRequest(
        { baseUrl: 'https://models.example/v1', apiKey: 'explicit-key' },
        settings,
      ),
    ).toEqual({ baseUrl: 'https://models.example/v1', apiKey: 'explicit-key' })
  })
})
