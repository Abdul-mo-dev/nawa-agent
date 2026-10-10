import { normalizeChatModels } from './chat-models'
import { defaultAiMediaSettings, resolveAiMediaSettings } from './media'
import { defaultAiSearchSettings, resolveAiSearchSettings } from './search-settings'
import type { AiProviderId, AiProviderMeta, AiSettings, LegacyAiSettings } from './types'
import { modelPolicyOf, normalizeModelPolicy } from './model-policy'
import { isLoopbackApiUrl } from './local-endpoint'

/**
 * Genspark server-side LLM proxy endpoints. All three protocols share the
 * api_key from the gsk login; model ids follow the proxy's own naming scheme,
 * which differs from the official vendor ids.
 */
export const GENSPARK_LLM_BASE_URLS = {
  anthropic: 'https://www.genspark.ai/api/anthropic',
  openai: 'https://www.genspark.ai/api/llm_proxy/v1',
} as const

/**
 * Splits Nawa usage out of the proxy's default "Claw" billing bucket
 * (the backend attributes gsk-key traffic by X-Agent-Type). Only sent to the
 * Genspark proxy — never to direct vendor APIs.
 */
export const GENSPARK_AGENT_TYPE = 'genoffice'

export function gensparkAttributionHeaders(baseUrl?: string): Record<string, string> {
  return baseUrl?.startsWith('https://www.genspark.ai')
    ? { 'X-Agent-Type': GENSPARK_AGENT_TYPE }
    : {}
}

/**
 * OpenCode Zen / Go route and cache per conversation and answer 400
 * MissingSessionID without this header (Nawa#331). The renderer's
 * transport id is stable for a chat; a one-shot call is its own conversation.
 */
export function opencodeSessionHeaders(
  baseUrl: string | undefined,
  sessionId?: string,
): Record<string, string> {
  return baseUrl?.startsWith('https://opencode.ai/')
    ? { 'x-opencode-session': sessionId || crypto.randomUUID() }
    : {}
}

/** DeepSeek V4.1 Flash under the Genspark pool spelling, shared by the direct provider so the two lists read alike */
export const DEEPSEEK_V41_FLASH = 'deep-seek-v4.1-flash'

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'genspark',
    label: 'Cloud',
    // must stay within the proxy's served set (GET /api/llm_proxy/v1/models);
    // bare gpt-5.6 and the gemini family dropped off it (verified 2026-08-31).
    // DeepSeek goes by the proxy's hyphenated pool id; V4.1 Flash takes images
    // (live-verified 2026-09-15). gpt-6-astra: chat, tool call and image
    // input all live-verified through the proxy 2026-09-17
    models: [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'gpt-6-astra',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      DEEPSEEK_V41_FLASH,
    ],
    defaultModel: 'claude-opus-4-7',
    keyPlaceholder: 'Not required - sign in',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    // Populated at runtime from codex app-server model/list. Empty also lets
    // the CLI select the account's current default without a stale hardcode.
    models: [],
    defaultModel: '',
    keyPlaceholder: '',
    needsCliPath: true,
  },
  {
    id: 'anthropic',
    label: 'Claude',
    // current-generation ids per platform.claude.com models overview (2026-08)
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'sk-ant-api03-...',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    // 3.x lineup per ai.google.dev/gemini-api/docs/models (2026-08). 3.7 Flash is
    // the current stable Flash; 3.1 Pro is still preview-only.
    models: [
      'gemini-3.7-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ],
    defaultModel: 'gemini-3.7-flash',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // GET api.deepseek.com/v1/models serves `deepseek-v4-pro` and
    // `deepseek-flash` (verified 2026-09-21); the latter is V4.1 Flash with
    // native vision. We list it under the Genspark pool spelling so both
    // providers show the same versioned name; the adapter maps it back to
    // the unversioned wire id (see DEEPSEEK_WIRE_IDS in registry.ts).
    models: ['deepseek-v4-pro', DEEPSEEK_V41_FLASH],
    defaultModel: 'deepseek-v4-pro',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    // GPT-5.6 naming: sol is the flagship (the bare `gpt-5.6` alias resolves to
    // it, but spell it out so the picker says which tier it is), terra balances
    // cost/intelligence, luna is the high-volume tier (2026-08). gpt-6-astra
    // is deliberately absent: OpenAI serves its tool calls only through the
    // Responses API, which has no protocol here (2026-09-17)
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    defaultModel: 'gpt-5.6-terra',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    models: ['kimi-k3'],
    defaultModel: 'kimi-k3',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'glm',
    label: 'GLM',
    // bigmodel.cn text-model lineup (2026-08); 5.3 and 5.2 share a base model,
    // 5-Turbo is the cheap tier
    models: ['glm-5.3', 'glm-5.2', 'glm-5-turbo'],
    defaultModel: 'glm-5.3',
    keyPlaceholder: 'xxxxxxxx.xxxxxxxx',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    // Versioned DashScope ids: the bare qwen-max alias still points at a
    // Qwen2.5-era snapshot, so name the 3.x tiers explicitly (2026-08)
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'],
    defaultModel: 'qwen3.8-max',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'doubao',
    label: 'Doubao',
    // Ark ids are dashed and date-pinned; it also accepts ep-... inference
    // endpoint ids in the model field
    models: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'],
    defaultModel: 'doubao-seed-2-1-pro-260628',
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    // M3 is the current agentic/tool-use model; M2.5 moved to the legacy tier
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
    defaultModel: 'MiniMax-M3',
    keyPlaceholder: 'eyJ...',
  },
  {
    id: 'xai',
    label: 'Grok',
    models: ['grok-4.6', 'grok-4.5'],
    defaultModel: 'grok-4.6',
    keyPlaceholder: 'xai-...',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    // `-latest` aliases track the newest GA snapshot. Medium 3.5 is Mistral's
    // agentic tier; codestral is a code-completion/FIM model, not an agent driver.
    models: ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest'],
    defaultModel: 'mistral-medium-latest',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    // vendor-prefixed slugs exactly as openrouter.ai/api/v1/models lists them —
    // there is no `openai/gpt-5.6` alias there, only the per-tier ids
    models: [
      'openrouter/auto',
      'anthropic/claude-sonnet-5',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-sol',
      'moonshotai/kimi-k3',
    ],
    defaultModel: 'openrouter/auto',
    keyPlaceholder: 'sk-or-...',
  },
  {
    id: 'requesty',
    label: 'Requesty',
    // Managed policy ids exactly as GET router.requesty.ai/v1/models/managed
    // lists them (2026-09-11): short stable names Requesty routes across
    // providers, used as-is in the model field. The full vendor-prefixed
    // catalog (GET /v1/models, e.g. openai/gpt-4o-mini) works too when typed
    // in. Ids ending "@eu" route through EU providers only.
    models: [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gemini-3.7-flash',
      'deepseek-v4-pro',
      'kimi-k3',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'opper',
    label: 'Opper',
    // Pool ids exactly as GET api.opper.ai/v3/models lists them (2026-09-14):
    // a bare name is an Opper pool, and Opper picks the serving provider and
    // region per request. The vendor-prefixed catalog (anthropic/claude-sonnet-4-6,
    // azure/gpt-5, …) pins one provider and works as-is when typed in.
    // Full list at opper.ai/models.
    models: [
      'claude-sonnet-4-6',
      'claude-opus-5',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gemini-3.8-flash',
      'deepseek-v4-pro',
      'kimi-k3',
      'mistral-large-2512',
    ],
    defaultModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    // Pay-as-you-go gateway (opencode.ai/docs/zen); ids exactly as GET
    // /zen/v1/models lists them (2026-09-03). GPT-5.x, Grok and Muse Spark
    // are served only through the Responses API, which has no protocol here,
    // so they stay out until one exists.
    models: [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'gemini-3.7-flash',
      'gemini-3.1-pro',
      'kimi-k3',
      'kimi-k2.7-code',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-5.2',
      'minimax-m3',
      'qwen3.6-plus',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    // $10/month subscription to open-weight coding models (opencode.ai/docs/go),
    // same key as Zen; ids exactly as GET /zen/go/v1/models lists them
    // (2026-09-03). GPT-5.6 Luna, Grok and Muse Spark are Responses-only and
    // left out for the same reason as above.
    models: [
      'kimi-k2.7-code',
      'kimi-k3',
      'glm-5.3',
      'glm-5.3-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'qwen3.8-max',
      'qwen3.8-flash',
      'minimax-m3',
      'mimo-v2.5-pro',
      'longcat-2.0',
    ],
    defaultModel: 'kimi-k2.7-code',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'custom',
    label: 'Custom',
    models: [],
    defaultModel: '',
    keyPlaceholder: 'API Key',
    needsBaseUrl: true,
  },
]

/**
 * Fresh settings with every provider's default model and an empty key,
 * except providers listed in `defaultApiKeys` (e.g. an app-specific
 * preconfigured Anthropic key). Callers own that policy; this package
 * has no hardcoded keys.
 */
export function defaultAiSettings(
  defaultApiKeys?: Partial<Record<AiProviderId, string>>,
): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    providers[meta.id] = {
      apiKey: defaultApiKeys?.[meta.id] ?? '',
      model: meta.defaultModel,
      baseUrl: meta.needsBaseUrl ? '' : undefined,
      cliPath: meta.needsCliPath ? '' : undefined,
    }
  }
  return {
    provider: 'genspark',
    providers,
    gskToolsEnabled: true,
    media: defaultAiMediaSettings(),
    search: defaultAiSearchSettings(),
  }
}

/** false only on an explicit opt-out; absent (pre-toggle settings files) means on */
export function cloudToolsEnabled(settings: Pick<AiSettings, 'gskToolsEnabled'>): boolean {
  return settings.gskToolsEnabled !== false
}

/**
 * Preserve the user's provider even while configuration is incomplete.
 * Request validation reports the missing setting; it never changes providers.
 */
export function activeProvider(settings: AiSettings): AiProviderId {
  return settings.provider
}

/**
 * Model ids a vendor has stopped serving, mapped to their replacement. A
 * stored selection outlives the provider list, so without this remap an old
 * settings file keeps sending an id the API now rejects.
 */
const RETIRED_MODELS: Partial<Record<AiProviderId, Record<string, string>>> = {
  // chat/reasoner retired 2026-07-24 (thinking became a request parameter);
  // V4 Flash and V4 Flash Vision Exp retired 2026-09-10 in favour of V4.1
  // Flash, which carries vision natively. The vendor's own `deepseek-flash`
  // id is folded in as well so the stored value matches the listed one.
  deepseek: {
    'deepseek-chat': DEEPSEEK_V41_FLASH,
    'deepseek-reasoner': DEEPSEEK_V41_FLASH,
    'deepseek-v4-flash': DEEPSEEK_V41_FLASH,
    'deepseek-v4-flash-vision-exp': DEEPSEEK_V41_FLASH,
    'deepseek-flash': DEEPSEEK_V41_FLASH,
  },
  // proxy stopped serving bare gpt-5.6 (400) and removed the gemini route
  // entirely (405), verified 2026-08-31; gemini selections fall back to the
  // provider default since no gemini id is served at all
  genspark: {
    'gpt-5.6': 'gpt-5.6-terra',
    'gemini-3.1-pro-preview': 'claude-opus-4-7',
    'gemini-3-flash-preview': 'claude-opus-4-7',
    'gemini-3.7-flash': 'claude-opus-4-7',
  },
}

/**
 * Cloud starting allowance. Local and saved-profile policies refine it and
 * reserve at least half the configured context for input. Larger generation
 * can use an explicit profile limit within the selected model's ceiling.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192
/** Leave room for prompt, tools and evidence on small local-model contexts. */
export const DEFAULT_LOCAL_MAX_OUTPUT_TOKENS = 4096
/** bounds accepted for AiSettings.maxOutputTokens: below the first a short answer cannot even finish, above the second one turn risks the whole context window */
export const MIN_MAX_OUTPUT_TOKENS = 1024
export const MAX_MAX_OUTPUT_TOKENS = 131072

/** Out-of-range or non-finite input falls back to a bound / the default (a mistyped settings field must not kill AI features) */
export function clampMaxOutputTokens(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, n))
}

/** The effective per-turn output cap of a settings object (clamped; absent → default) */
export function maxOutputTokensOf(
  settings:
    | (Pick<AiSettings, 'maxOutputTokens'> & Partial<Pick<AiSettings, 'provider' | 'providers'>>)
    | null
    | undefined,
): number {
  if (settings?.provider && settings.providers?.[settings.provider])
    return modelPolicyOf(
      settings.provider,
      settings.providers[settings.provider],
      settings.maxOutputTokens,
    ).outputTokens
  const fallback =
    settings?.provider === 'custom' && isLoopbackApiUrl(settings.providers?.custom?.baseUrl)
      ? DEFAULT_LOCAL_MAX_OUTPUT_TOKENS
      : DEFAULT_MAX_OUTPUT_TOKENS
  return typeof settings?.maxOutputTokens !== 'number' || !Number.isFinite(settings.maxOutputTokens)
    ? fallback
    : clampMaxOutputTokens(settings.maxOutputTokens)
}

/** pasted keys/URLs/model ids often carry stray whitespace, which turns into a 401 with a valid key */
function trimConfigs(providers: AiSettings['providers']): AiSettings['providers'] {
  const trimmed = { ...providers }
  for (const [id, config] of Object.entries(trimmed)) {
    trimmed[id as AiProviderId] = {
      ...config,
      ...(config.policy ? { policy: normalizeModelPolicy(config.policy) } : {}),
      apiKey: config.apiKey?.trim() ?? '',
      model: config.model?.trim() ?? '',
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl.trim() } : {}),
      ...(config.cliPath !== undefined ? { cliPath: config.cliPath.trim() } : {}),
    }
  }
  return trimmed
}

function migrateRetiredModels(providers: AiSettings['providers']): AiSettings['providers'] {
  const migrated = { ...providers }
  for (const [id, replacements] of Object.entries(RETIRED_MODELS)) {
    const config = migrated[id as AiProviderId]
    const replacement = config?.model ? replacements[config.model] : undefined
    if (replacement) migrated[id as AiProviderId] = { ...config, model: replacement }
  }
  return migrated
}

/**
 * Merge on-disk settings over freshly computed defaults, migrating the
 * pre-provider shape (a single OpenAI-compatible endpoint) into the
 * "custom" provider slot. `stored` is whatever the caller read from its
 * settings file (already JSON-parsed); this function does no file I/O.
 */
export function resolveAiSettings(
  stored: Partial<AiSettings> & LegacyAiSettings,
  defaults: AiSettings,
): AiSettings {
  if (!stored.providers) {
    if (stored.apiKey || stored.baseUrl || stored.model) {
      const custom = {
        apiKey: stored.apiKey?.trim() ?? '',
        model: stored.model?.trim() ?? '',
        baseUrl: (stored.baseUrl ?? 'https://api.openai.com/v1').trim(),
      }
      return {
        ...defaults,
        provider: stored.provider ?? 'custom',
        providers: { ...defaults.providers, custom },
      }
    }
    return { ...defaults, provider: stored.provider ?? defaults.provider }
  }
  return {
    chatModels: normalizeChatModels(
      stored.chatModels ?? defaults.chatModels,
      Object.keys(defaults.providers),
    ),
    defaultChatModelId:
      typeof stored.defaultChatModelId === 'string'
        ? stored.defaultChatModelId
        : defaults.defaultChatModelId,
    provider: stored.provider ?? defaults.provider,
    // Trim before migrating: a pasted " deepseek-reasoner " must still hit
    // the retired-id remap instead of being sent to the API verbatim.
    providers: migrateRetiredModels(trimConfigs({ ...defaults.providers, ...stored.providers })),
    gskToolsEnabled: stored.gskToolsEnabled ?? defaults.gskToolsEnabled ?? true,
    media: resolveAiMediaSettings(stored.media ?? defaults.media),
    search: resolveAiSearchSettings(stored.search ?? defaults.search),
    // clamped on read: a hand-edited settings file with an absurd cap must not be
    // forwarded to the endpoint verbatim
    ...(stored.maxOutputTokens !== undefined || defaults.maxOutputTokens !== undefined
      ? {
          maxOutputTokens: clampMaxOutputTokens(stored.maxOutputTokens ?? defaults.maxOutputTokens),
        }
      : {}),
  }
}
