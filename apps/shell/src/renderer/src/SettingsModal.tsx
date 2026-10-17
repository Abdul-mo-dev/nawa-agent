import { ChatModelsEditor } from './ChatModelsEditor'
import { ModelPolicyEditor } from './ModelPolicyEditor'
import { PanelActivityContext, usePanelActivity, type PanelActivity } from './explorer/panel-state'
import { useSidebarText } from './explorer/sidebar-i18n'
import {
  REDACTED_AI_KEY,
  validateChatModels,
  validateModelPolicy,
  modelCapabilityIdentity,
} from '@genoffice/ai-provider/browser'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  DEFAULT_AI_PANEL_PREFS,
  Dropdown,
  aiPanelFontPx,
  clampAiCustomFontSize,
} from '@genoffice/ui'
import type { AiFontSize, AiPanelPrefs, AiPanelSide } from '@genoffice/ui'
import type { DecisionEndpoint, DefaultAppStatus, FileSearchSettings } from '../../shared/home-api'
import type { UpdateUiState } from '../../shared/update-api'
import {
  maxOutputTokensOf,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  activeCustomEndpoint,
  clampMaxOutputTokens,
  customEndpointLabel,
  newCustomEndpointId,
  removeCustomEndpoint,
  selectCustomEndpoint,
  upsertCustomEndpoint,
} from '@genoffice/ai-provider/browser'
import type {
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from '@genoffice/ai-provider'
import { useI18n } from './locale'
import type { StringKey, TFunc } from './locale'
import type { AccountStatus, AiCatalogEntry, DocTheme, UiTheme } from '../../shared/home-api'
import { ProviderLogo } from './provider-logos'
import { IntegrationsPane, skillUpdateDue } from './IntegrationsPane'
import { MyAgentSettings } from './myagent/MyAgentSettings'
import { KnowledgeSettings } from './KnowledgeSettings'
import './settings.css'

// ── Settings modal (opened from the account menu) ─────────
// Genspark-style two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
] as const

// GenMail's option order: follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

// Document page theme (genoffice#1811): the canvas/paper preference the editors follow;
// 'follow' keeps the pre-existing behavior of riding the UI theme
const DOC_THEME_OPTIONS = [
  { value: 'follow', labelKey: 'docThemeFollowApp' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: DocTheme; labelKey: StringKey }[]

const AI_FONT_SIZE_OPTIONS = [
  { value: 'default', labelKey: 'aiFontSizeDefault' },
  { value: 'large', labelKey: 'aiFontSizeLarge' },
  { value: 'xlarge', labelKey: 'aiFontSizeXLarge' },
  { value: 'custom', labelKey: 'aiFontSizeCustom' },
] as const satisfies readonly { value: AiFontSize; labelKey: StringKey }[]

const CHANNEL_OPTIONS = [
  { value: 'stable', labelKey: 'channelStable' },
  { value: 'beta', labelKey: 'channelBeta' },
] as const satisfies readonly { value: 'stable' | 'beta'; labelKey: StringKey }[]

/** px stepper for the custom AI panel text size; in-range values apply live,
 * out-of-range or partial input is clamped on blur */
function CustomFontSizeInput({
  value,
  label,
  onCommit,
}: {
  value: number
  label: string
  onCommit: (px: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : String(value)
  const commit = (raw: string) => {
    const px = clampAiCustomFontSize(raw)
    if (px !== null && px !== value) onCommit(px)
  }
  return (
    <label className="set-num">
      <input
        type="number"
        className="set-input set-num-input"
        aria-label={label}
        min={AI_CUSTOM_FONT_MIN_PX}
        max={AI_CUSTOM_FONT_MAX_PX}
        step={1}
        value={shown}
        onFocus={() => {
          setDraft(String(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= AI_CUSTOM_FONT_MIN_PX && n <= AI_CUSTOM_FONT_MAX_PX) {
            onCommit(n)
          }
        }}
        onBlur={() => {
          commit(draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="set-num-unit">px</span>
    </label>
  )
}

export type SettingsSection =
  'account' | 'aiModel' | 'aiMedia' | 'knowledge' | 'general' | 'integrations' | 'about'
export type SectionId = SettingsSection

const SECTIONS: readonly { id: SettingsSection; labelKey: StringKey }[] = [
  { id: 'account', labelKey: 'setSecAccount' },
  { id: 'aiModel', labelKey: 'setSecAiModel' },
  { id: 'aiMedia', labelKey: 'setSecAiMedia' },
  { id: 'knowledge', labelKey: 'setSecIntegrations' },
  { id: 'general', labelKey: 'setSecGeneral' },
  { id: 'integrations', labelKey: 'setSecIntegrations' },
  { id: 'about', labelKey: 'setSecAbout' },
]

function SectionIcon({ id }: { id: SettingsSection }) {
  if (id === 'knowledge')
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <path d="M2 3.5c2-1 4-1 6 0 2-1 4-1 6 0v9c-2-1-4-1-6 0-2-1-4-1-6 0Z M8 3.5v9" />
      </svg>
    )
  if (id === 'aiModel') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M12.8 11.2v3M11.3 12.7h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'aiMedia') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.5 11.5 6 8l2.5 2.5L10.5 9l3 2.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="10.5" cy="6" r="1.1" fill="currentColor" />
      </svg>
    )
  }
  if (id === 'account') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="5.2" r="2.9" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.7 13.6a5.5 5.5 0 0 1 10.6 0"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'integrations') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5V14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * Long enough that typing an address does not fire a request per keystroke,
 * short enough that the picker is populated by the time the eye reaches it.
 */
const CUSTOM_MODELS_DEBOUNCE_MS = 400

/** replace one catalog entry's model list, leaving every other entry untouched */
function foldModels(providerId: string, models: string[]) {
  return (current: AiCatalogEntry[]): AiCatalogEntry[] =>
    current.map((entry) =>
      entry.id === providerId ? { ...entry, models, defaultModel: '' } : entry,
    )
}

/** AI model pane: provider / model / key / base URL, saved to userData/ai-settings.json */
export function AiModelPane({ t }: { t: TFunc }) {
  const id = useId()
  const fieldId = (name: string) => `${id}-${name}`
  const { s } = useSidebarText()
  const [baseline, setBaseline] = useState<AiSettings | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [catalog, setCatalog] = useState<AiCatalogEntry[]>(
    () => window.aiOffice.getAiProviders?.() ?? [],
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  /** free-typed value of the output-cap field; committed (and clamped) on blur */
  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)
  usePanelActivity(
    'provider',
    'settings',
    testing || saving
      ? { kind: 'busy', text: s('Working…'), dirty: dirty || maxTokensDraft !== null }
      : error
        ? { kind: 'error', text: error, dirty: dirty || maxTokensDraft !== null }
        : dirty || maxTokensDraft !== null
          ? { kind: 'unsaved', text: s('Unsaved model settings') }
          : null,
  )

  const refreshCodexModels = useCallback(async (cliPath = '', selectedModel = '') => {
    if (!window.aiOffice.getCodexModels) return
    const live = await window.aiOffice.getCodexModels(cliPath)
    setCatalog((current) =>
      current.map((entry) => {
        if (entry.id !== 'codex') return entry
        const models =
          selectedModel && !live.models.includes(selectedModel)
            ? [selectedModel, ...live.models]
            : live.models
        return { ...entry, models, defaultModel: live.defaultModel }
      }),
    )
  }, [])

  // Re-read on every outside write (composer model chip) while the form has no
  // unsaved edits; a dirty form keeps the user's draft and saves it as is.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty || maxTokensDraft !== null
  /** bumped on every outside reload so a connection test that was still running reports nothing */
  const testSeqRef = useRef(0)
  useEffect(() => {
    let alive = true
    const load = () => {
      setError('')
      void window.aiOffice
        .getAiSettings?.()
        .then((s) => {
          if (!alive || !s) return
          testSeqRef.current += 1
          setTesting(false)
          setTestResult(null)
          setSaved(false)
          // The switch is disabled with genspark, so never present it stranded
          // off. Display-only: s.provider may be the activeProvider fallback for
          // a half-configured BYOK selection, so writing anything back here would
          // clobber the stored choice — the main process heals a genuine legacy
          // genspark+off file itself, judged on the raw stored provider.
          if (s.provider === 'genspark' && s.gskToolsEnabled === false) {
            s = { ...s, gskToolsEnabled: true }
          }
          setSettings(s)
          setBaseline(s)
          setDirty(false)
          setConflict(false)
          setMaxTokensDraft(null)
          const codex = s.providers.codex
          if (codex) {
            void refreshCodexModels(codex.cliPath ?? '', codex.model).catch(() => undefined)
          }
        })
        .catch((cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    load()
    const off = window.aiOffice.onAiSettingsChanged?.(() => {
      if (!dirtyRef.current) load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [refreshCodexModels, retry])

  // A user-hosted endpoint gets the same live model list as Codex, asked of the
  // endpoint itself. Keyed on the catalog's `needsBaseUrl` flag rather than on
  // the literal 'custom' id, so it follows the slot rather than the name, and
  // stays a no-op while any other provider is selected — a local server saved
  // months ago is never contacted while Genspark is in use.
  const endpointProvider = catalog.find(
    (entry) => entry.id === settings?.provider && entry.needsBaseUrl,
  )?.id
  const endpointConfig = settings ? settings.providers[settings.provider] : undefined
  const endpointBaseUrl = (endpointConfig?.baseUrl ?? '').trim()
  const endpointApiKey = endpointConfig?.apiKey ?? ''
  // The stored model decides where the pin goes below, but changing it must not
  // send another request, so it is read when the reply lands rather than keyed on.
  const selectedModelRef = useRef('')
  useEffect(() => {
    selectedModelRef.current = endpointConfig?.model ?? ''
  })
  /** the address that produced the list currently folded in; '' when none is */
  const listedForRef = useRef('')

  useEffect(() => {
    if (!endpointProvider) return
    // A list belonging to a different server — or to no server, once the address
    // is cleared — is misinformation, so it goes the moment the address changes:
    // the free-text box is the honest thing to show while the answer is unknown.
    if (listedForRef.current && listedForRef.current !== endpointBaseUrl) {
      listedForRef.current = ''
      setCatalog(foldModels(endpointProvider, []))
    }
    if (!endpointBaseUrl || !window.aiOffice.getCustomModels) return
    let cancelled = false
    const timer = setTimeout(() => {
      void window.aiOffice
        .getCustomModels(endpointBaseUrl, endpointApiKey)
        .then((live) => {
          // A server that will not answer leaves the current list alone: a blip
          // must not wipe a picker mid-use.
          if (cancelled || !live || live.models.length === 0) return
          // A hand-typed id is pinned to the top so it never vanishes from the
          // picker. The catalog is the only thing written — writing settings
          // here would revert whatever the user typed while the probe was in
          // flight, since `updateConfig` rebuilds them from its own render.
          const selected = selectedModelRef.current.trim()
          const models =
            selected && !live.models.includes(selected) ? [selected, ...live.models] : live.models
          listedForRef.current = endpointBaseUrl
          setCatalog(foldModels(endpointProvider, models))
        })
        .catch(() => undefined)
    }, CUSTOM_MODELS_DEBOUNCE_MS)
    // React's own cleanup drops a superseded reply, so a slow answer from the
    // previous address can never overwrite a fast one from the current address.
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [endpointProvider, endpointBaseUrl, endpointApiKey])

  if (!settings)
    return (
      <div className="nawa-model-scroll">
        <p role={error ? 'alert' : 'status'}>{error || s('Loading model settings…')}</p>
        {error && (
          <button className="set-btn" onClick={() => setRetry((value) => value + 1)}>
            {s('Retry')}
          </button>
        )}
      </div>
    )
  const provider = settings.provider
  const meta = catalog.find((c) => c.id === provider)
  const config = settings.providers[provider] ?? {
    apiKey: '',
    model: meta?.defaultModel ?? '',
    baseUrl: undefined,
    cliPath: undefined,
  }
  const isGenspark = provider === 'genspark'
  const isCodex = provider === 'codex'

  const touch = () => {
    setDirty(true)
    setConflict(false)
    setSaved(false)
    setTestResult(null)
    setError('')
  }
  const endpoint = meta?.needsBaseUrl ? activeCustomEndpoint(settings) : undefined
  const updateConfig = (patch: Partial<typeof config>) => {
    if (meta?.needsBaseUrl) {
      // the slot mirrors the active endpoint, so the edit lands on the endpoint
      const base = endpoint ?? {
        id: newCustomEndpointId(),
        name: '',
        baseUrl: config.baseUrl ?? '',
        apiKey: config.apiKey,
        model: config.model,
        ...(config.policy ? { policy: config.policy } : {}),
      }
      const { cliPath: _cli, ...fields } = patch
      setSettings(upsertCustomEndpoint(settings, { ...base, ...fields }, true))
    } else {
      setSettings({
        ...settings,
        providers: { ...settings.providers, [provider]: { ...config, ...patch } },
      })
    }
    touch()
  }
  const addEndpoint = () => {
    setSettings(
      upsertCustomEndpoint(
        settings,
        { id: newCustomEndpointId(), name: '', baseUrl: '', apiKey: '', model: '' },
        true,
      ),
    )
    touch()
  }
  const renameEndpoint = (name: string) => {
    if (!endpoint) return
    setSettings(upsertCustomEndpoint(settings, { ...endpoint, name }))
    touch()
  }
  const pickEndpoint = (id: string) => {
    setSettings(selectCustomEndpoint(settings, id))
    touch()
  }
  const deleteEndpoint = () => {
    if (!endpoint) return
    setSettings(removeCustomEndpoint(settings, endpoint.id))
    touch()
  }
  const parseOutputLimit = (draft: string) => {
    const parsed = Number.parseInt(draft, 10)
    return Number.isFinite(parsed)
      ? clampMaxOutputTokens(parsed)
      : maxOutputTokensOf({ ...settings, maxOutputTokens: undefined })
  }
  const withOutputLimit = (value: number) => {
    const policy = { ...config.policy, outputTokens: value }
    const next = {
      ...settings,
      maxOutputTokens: value,
      providers: {
        ...settings.providers,
        [settings.provider]: { ...config, policy },
      },
    }
    // The active endpoint owns the custom slot; saving only the mirror would
    // lose this edit when the settings normalizer resolves the endpoint list.
    return endpoint ? upsertCustomEndpoint(next, { ...endpoint, policy }) : next
  }
  /** Commit the output-cap input: clamp what was typed and drop a no-op edit */
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) return
    setMaxTokensDraft(null)
    const next = parseOutputLimit(maxTokensDraft)
    if (next === maxOutputTokensOf(settings)) return
    setSettings(withOutputLimit(next))
    touch()
  }
  const selectProvider = (id: AiSettings['provider']) => {
    // cloud tools cannot be off with genspark (chat runs through gsk anyway)
    setSettings({
      ...settings,
      provider: id,
      ...(id === 'genspark' ? { gskToolsEnabled: true } : {}),
    })
    touch()
  }
  const save = async () => {
    let next =
      maxTokensDraft === null ? settings : withOutputLimit(parseOutputLimit(maxTokensDraft))
    const savedEndpoint = meta?.needsBaseUrl ? activeCustomEndpoint(next) : undefined
    if (savedEndpoint && listedForRef.current === savedEndpoint.baseUrl) {
      const live = (meta?.models ?? []).filter((m) => m !== savedEndpoint.model)
      if (live.length) next = upsertCustomEndpoint(next, { ...savedEndpoint, models: live })
    }
    const profileError =
      validateChatModels(next) ?? validateModelPolicy(next.provider, next.providers[next.provider])
    if (profileError) {
      setError(profileError)
      return
    }
    setSaving(true)
    setError('')
    try {
      const current = await window.aiOffice.getAiSettings()
      if (JSON.stringify(current) !== JSON.stringify(baseline)) {
        setConflict(true)
        setError(
          s('Model settings changed in another editor. Reload the current settings before saving.'),
        )
        return
      }
      await window.aiOffice.setAiSettings(next)
      const savedSettings = await window.aiOffice.getAiSettings()
      setSettings(savedSettings)
      setBaseline(savedSettings)
      setMaxTokensDraft(null)
      setDirty(false)
      setConflict(false)
      setSaved(true)
      window.dispatchEvent(new Event('nawa:models-changed'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setConflict(message.includes('AI settings changed'))
      setError(message)
    } finally {
      setSaving(false)
    }
  }
  const test = () => {
    const seq = ++testSeqRef.current
    setTesting(true)
    setTestResult(null)
    window.aiOffice
      .testAiSettings?.({
        ...settings,
        selectedChatModelId: undefined,
        defaultChatModelId: undefined,
      })
      .then((r) => {
        if (seq !== testSeqRef.current) return
        setTestResult(r ?? { ok: false })
        if (r?.capabilities) {
          const tested = r.capabilities
          setSettings((current) => {
            if (!current) return current
            const connection = current.providers[provider]
            if (modelCapabilityIdentity(provider, connection) !== tested.identity) return current
            const policy = { ...connection.policy, tested }
            const next = {
              ...current,
              providers: {
                ...current.providers,
                [provider]: { ...connection, policy },
              },
            }
            const testedEndpoint = provider === 'custom' ? activeCustomEndpoint(current) : undefined
            return testedEndpoint ? upsertCustomEndpoint(next, { ...testedEndpoint, policy }) : next
          })
          setDirty(true)
          setSaved(false)
        }
        if (r?.ok && isCodex) {
          void refreshCodexModels(config.cliPath ?? '', config.model).catch(() => undefined)
        }
      })
      .catch((error) => {
        if (seq !== testSeqRef.current) return
        setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        if (seq === testSeqRef.current) setTesting(false)
      })
  }

  return (
    <div className="nawa-model-pane">
      <fieldset className="nawa-model-scroll" disabled={saving || testing}>
        <h3 className="set-pane-title">{s('Nawa chat model')}</h3>
        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label">{t('setAiProvider')}</label>
          </div>
          <Dropdown
            className="set-dd"
            value={provider}
            ariaLabel={t('setAiProvider')}
            options={catalog.map((c) => ({
              value: c.id,
              label: c.label,
              render: (
                <>
                  <ProviderLogo id={c.id} />
                  {c.label}
                </>
              ),
            }))}
            onPick={(v) => selectProvider(v as AiSettings['provider'])}
          />
        </div>
        <div className="set-field-desc set-ai-note">
          {isGenspark ? t('setAiGensparkHint') : isCodex ? t('setAiCodexHint') : t('setAiByokNote')}
        </div>
        {meta?.needsBaseUrl && (
          <>
            <div className="set-field">
              <div className="set-field-text">
                <div className="set-field-stack">
                  <label className="set-field-label">{t('setAiEndpoint')}</label>
                  <div className="set-field-desc">{t('setAiEndpointHint')}</div>
                </div>
              </div>
              <div className="set-ai-endpoint-row">
                {endpoint && (
                  <Dropdown
                    className="set-dd"
                    value={endpoint.id}
                    ariaLabel={t('setAiEndpoint')}
                    options={(settings.customEndpoints ?? []).map((e) => ({
                      value: e.id,
                      label: customEndpointLabel(e, meta.label),
                    }))}
                    onPick={pickEndpoint}
                  />
                )}
                <button className="set-btn" type="button" onClick={addEndpoint}>
                  {t('setAiEndpointAdd')}
                </button>
                {endpoint && (
                  <button className="set-btn" type="button" onClick={deleteEndpoint}>
                    {t('setAiEndpointRemove')}
                  </button>
                )}
              </div>
            </div>
            {endpoint && (
              <div className="set-field">
                <div className="set-field-text">
                  <label className="set-field-label" htmlFor={fieldId('set-ai-endpoint-name')}>
                    {t('setAiEndpointName')}
                  </label>
                </div>
                <input
                  id={fieldId('set-ai-endpoint-name')}
                  className="set-input"
                  type="text"
                  value={endpoint.name}
                  placeholder={customEndpointLabel(endpoint, meta.label)}
                  spellCheck={false}
                  onChange={(e) => renameEndpoint(e.target.value)}
                />
              </div>
            )}
          </>
        )}
        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label" htmlFor={fieldId('set-ai-model')}>
              {t('setAiModelId')}
            </label>
          </div>
          {meta && meta.models.length > 0 ? (
            <Dropdown
              className="set-dd"
              value={config.model || meta.defaultModel}
              ariaLabel={t('setAiModelId')}
              options={meta.models.map((m) => ({ value: m, label: m }))}
              onPick={(m) => updateConfig({ model: m })}
            />
          ) : (
            <input
              id={fieldId('set-ai-model')}
              className="set-input"
              type="text"
              value={config.model}
              placeholder="model-id"
              spellCheck={false}
              onChange={(e) => updateConfig({ model: e.target.value })}
            />
          )}
        </div>
        {isCodex ? (
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor={fieldId('set-ai-cli-path')}>
                  {t('setAiCodexPath')}
                </label>
                <div className="set-field-desc">{t('setAiCodexPathHint')}</div>
              </div>
            </div>
            <input
              id={fieldId('set-ai-cli-path')}
              className="set-input"
              type="text"
              value={config.cliPath ?? ''}
              placeholder={t('setAiCodexAutoPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateConfig({ cliPath: e.target.value.trim() })}
              onBlur={(e) => {
                const cliPath = e.target.value.trim()
                void refreshCodexModels(cliPath, config.model).catch(() => undefined)
              }}
            />
          </div>
        ) : !isGenspark ? (
          <>
            <div className="set-field">
              <div className="set-field-text">
                <div className="set-field-stack">
                  <label className="set-field-label" htmlFor={fieldId('set-ai-key')}>
                    {provider === 'custom' ? s('API key (optional)') : t('setAiApiKey')}
                  </label>
                  <div className="set-field-desc">{t('setAiKeyHint')}</div>
                </div>
              </div>
              <input
                id={fieldId('set-ai-key')}
                className="set-input"
                type="password"
                value={config.apiKey === REDACTED_AI_KEY ? '' : config.apiKey}
                placeholder={
                  config.apiKey === REDACTED_AI_KEY
                    ? s('Saved key · enter a replacement')
                    : (meta?.keyPlaceholder ?? 'API Key')
                }
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => updateConfig({ apiKey: e.target.value.trim() })}
              />
              {config.apiKey === REDACTED_AI_KEY && (
                <button
                  type="button"
                  className="set-btn"
                  onClick={() => updateConfig({ apiKey: '' })}
                >
                  {s('Remove saved key')}
                </button>
              )}
            </div>
            <div className="set-field">
              <div className="set-field-text">
                <div className="set-field-stack">
                  <label className="set-field-label" htmlFor={fieldId('set-ai-base-url')}>
                    {t('setAiBaseUrl')}
                  </label>
                  {!meta?.needsBaseUrl && (
                    <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>
                  )}
                </div>
              </div>
              <input
                id={fieldId('set-ai-base-url')}
                className="set-input"
                type="text"
                value={config.baseUrl ?? ''}
                placeholder={
                  provider === 'custom' ? 'http://127.0.0.1:8082/v1' : meta?.defaultBaseUrl
                }
                spellCheck={false}
                onChange={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
              />
            </div>
          </>
        ) : null}
        <details className="nawa-model-advanced">
          <summary>{s('Advanced model settings')}</summary>
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor={fieldId('set-ai-max-tokens')}>
                  {t('setAiMaxTokens')}
                </label>
                <div className="set-field-desc">{t('setAiMaxTokensDesc')}</div>
              </div>
            </div>
            <input
              id={fieldId('set-ai-max-tokens')}
              className="set-input"
              type="number"
              min={MIN_MAX_OUTPUT_TOKENS}
              max={MAX_MAX_OUTPUT_TOKENS}
              step={1024}
              value={maxTokensDraft ?? String(maxOutputTokensOf(settings))}
              onChange={(e) => setMaxTokensDraft(e.target.value)}
              onBlur={commitMaxTokens}
            />
          </div>
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{t('setAiGskTools')}</div>
                <div className="set-field-desc">{t('setAiGskToolsDesc')}</div>
              </div>
            </div>
            {/* locked on with the genspark provider — chat runs through gsk anyway */}
            <button
              className="set-switch"
              role="switch"
              aria-checked={settings.gskToolsEnabled !== false}
              aria-label={t('setAiGskTools')}
              disabled={isGenspark}
              onClick={() => {
                setSettings({ ...settings, gskToolsEnabled: settings.gskToolsEnabled === false })
                touch()
              }}
            />
          </div>
          <ModelPolicyEditor
            provider={provider}
            config={config}
            embedded
            hideOutput
            onChange={(value) => updateConfig(value)}
          />
        </details>
        <ChatModelsEditor
          settings={settings}
          catalog={catalog}
          onChange={(next) => {
            setSettings(next)
            touch()
          }}
          onTested={(id, tested) => {
            setSettings((current) =>
              current
                ? {
                    ...current,
                    chatModels: current.chatModels?.map((model) =>
                      model.id === id &&
                      modelCapabilityIdentity(model.provider, model.config) === tested.identity
                        ? {
                            ...model,
                            config: { ...model.config, policy: { ...model.config.policy, tested } },
                          }
                        : model,
                    ),
                  }
                : current,
            )
            touch()
          }}
        />
      </fieldset>
      <div className="set-pane-footer">
        {error && (
          <p className="nawa-form-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <button
            className="set-btn"
            disabled={saving || testing}
            onClick={() => setRetry((value) => value + 1)}
          >
            {s('Reload current settings')}
          </button>
        )}
        {(dirty || maxTokensDraft !== null) && <span role="status">{s('Unsaved changes')}</span>}
        <AiStatusPill
          status={
            testing
              ? { kind: 'testing', text: t('setAiTesting') }
              : testResult
                ? testResult.ok
                  ? { kind: 'ok', text: t('setAiTestOk') }
                  : { kind: 'err', text: testResult.error || t('setAiTestFail') }
                : saved
                  ? { kind: 'ok', text: t('setAiSaved') }
                  : null
          }
        />
        <button className="set-btn" disabled={testing || saving} onClick={test}>
          {t('setAiTest')}
        </button>
        <button
          className="set-btn"
          disabled={saving || testing || (!dirty && maxTokensDraft === null)}
          onClick={() => {
            setSettings(baseline)
            setDirty(false)
            setMaxTokensDraft(null)
            setError('')
            setSaved(false)
            setTestResult(null)
          }}
        >
          {s('Discard changes')}
        </button>
        <button
          className="set-btn primary"
          disabled={saving || testing || (!dirty && maxTokensDraft === null)}
          onClick={save}
        >
          {saving ? s('Saving…') : t('setAiSave')}
        </button>
      </div>
    </div>
  )
}

type Capability = 'image' | 'analysis' | 'video' | 'search'
/** a tested block: the four capabilities plus the decision-model reranker of the local file search */
type TestedBlock = Capability | 'rerank'
/** where an outside entry point (e.g. the home list's rerank button) lands when it opens the modal */
export interface SettingsTarget {
  section: SectionId
  block?: TestedBlock
}
type TestResult = { ok: boolean; error?: string }

/** Jev routes first (OpenRouter is the default), then the other decision-model servers */
const DECISION_ENDPOINTS: { value: DecisionEndpoint; label: string }[] = [
  { value: 'openrouter', label: 'Jev (OpenRouter)' },
  { value: 'direct', label: 'Jev (TypeSafe API)' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'liquid', label: 'Liquid AI (d1)' },
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'kev', label: 'Kev (local)' },
  { value: 'rizzo', label: 'Rizzo Flow (local)' },
  { value: 'custom', label: 'Custom (/v1/systemone)' },
]

/**
 * AI media & search pane, one block per capability — web search, image
 * generation, image analysis, video analysis — each with the same
 * provider / model / key / base URL rows as the AI Model pane. A vendor's key
 * and base URL are stored once and shared by every block that picks it.
 * Saved into the same ai-settings.json as the chat provider.
 */
function AiMediaPane({
  t,
  onFileSearchChange,
  focusBlock,
}: {
  t: TFunc
  onFileSearchChange?: () => void
  focusBlock?: TestedBlock
}) {
  const { s } = useSidebarText()
  const [mediaCatalog] = useState<AiMediaProviderMeta[]>(
    () => window.aiOffice.getAiMediaProviders?.() ?? [],
  )
  const [searchCatalog] = useState<AiSearchProviderMeta[]>(
    () => window.aiOffice.getAiSearchProviders?.() ?? [],
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [loadRetry, setLoadRetry] = useState(0)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [fileSearch, setFileSearchState] = useState<FileSearchSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<Partial<Record<TestedBlock, TestResult>> | null>(
    null,
  )
  usePanelActivity(
    'provider',
    'media-settings',
    saving || testing
      ? { kind: 'busy', text: s('Working…'), dirty }
      : dirty
        ? { kind: 'unsaved', text: s('Unsaved changes') }
        : saveError
          ? { kind: 'error', text: saveError }
          : null,
  )
  const focused = useRef(false)
  const scrollToFocused = (el: HTMLDivElement | null) => {
    if (!el || focused.current) return
    focused.current = true
    el.scrollIntoView({ block: 'start' })
  }

  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const testSeqRef = useRef(0)
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.aiOffice
        .getAiSettings?.()
        .then((s) => {
          if (!alive || !s) return
          testSeqRef.current += 1
          setTesting(false)
          setTestResults(null)
          setSaved(false)
          setSettings(s)
          setDirty(false)
          setSaveError('')
        })
        .catch((error) => {
          if (alive) setSaveError(error instanceof Error ? error.message : String(error))
        })
    }
    load()
    void window.aiOffice
      .getFileSearchSettings?.()
      .then((v) => {
        if (alive && v) setFileSearchState(v)
      })
      .catch((error) => {
        if (alive) setSaveError(error instanceof Error ? error.message : String(error))
      })
    // this pane saves the whole file too: follow chip switches while clean
    const off = window.aiOffice.onAiSettingsChanged?.(() => {
      if (!dirtyRef.current) load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [loadRetry])

  if (!settings)
    return (
      <div className="nawa-model-scroll">
        <p role={saveError ? 'alert' : 'status'}>{saveError || s('Loading model settings…')}</p>
        {saveError && (
          <button className="set-btn" onClick={() => setLoadRetry((value) => value + 1)}>
            {s('Retry')}
          </button>
        )}
      </div>
    )
  if (!settings.media || !settings.search)
    return <p role="alert">{s('Media settings are unavailable. Reload the current settings.')}</p>
  const media: AiMediaSettings = settings.media
  const search: AiSearchSettings = settings.search

  const touch = () => {
    setDirty(true)
    setSaveError('')
    setSaved(false)
    setTestResults(null)
  }
  const setMedia = (next: AiMediaSettings) => {
    setSettings({ ...settings, media: next })
    touch()
  }
  const setSearch = (next: AiSearchSettings) => {
    setSettings({ ...settings, search: next })
    touch()
  }
  const setFileSearch = (next: FileSearchSettings) => {
    setFileSearchState(next)
    touch()
  }
  const mediaConfigOf = (id: AiMediaProviderId) => {
    const meta = mediaCatalog.find((m) => m.id === id)
    return (
      media.providers[id] ?? {
        apiKey: '',
        imageModel: meta?.defaultImageModel ?? '',
        analysisModel: meta?.defaultAnalysisModel ?? '',
      }
    )
  }
  const updateMediaConfig = (
    id: AiMediaProviderId,
    patch: Partial<AiMediaSettings['providers'][AiMediaProviderId]>,
  ) =>
    setMedia({
      ...media,
      providers: { ...media.providers, [id]: { ...mediaConfigOf(id), ...patch } },
    })

  const save = async () => {
    const profileError = validateChatModels(settings)
    if (profileError) {
      setSaveError(profileError)
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await window.aiOffice.setAiSettings(settings)
      setSettings(await window.aiOffice.getAiSettings())
      if (fileSearch) await window.aiOffice.setFileSearchSettings?.(fileSearch)
      onFileSearchChange?.()
      setDirty(false)
      setSaved(true)
      window.dispatchEvent(new Event('nawa:models-changed'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  // every block reports its own verdict; blocks sharing a vendor share that vendor's one check
  const test = async () => {
    const seq = ++testSeqRef.current
    setTesting(true)
    setTestResults(null)
    const results: Partial<Record<TestedBlock, TestResult>> = {}
    const fallback: TestResult = { ok: true }
    const vendorChecks = new Map<AiMediaProviderId, Promise<TestResult>>()
    const vendorCheck = (id: AiMediaProviderId) => {
      let pending = vendorChecks.get(id)
      if (!pending) {
        pending =
          window.aiOffice.testAiMediaSettings?.({ provider: id, config: mediaConfigOf(id) }) ??
          Promise.resolve(fallback)
        vendorChecks.set(id, pending)
      }
      return pending
    }
    const blocks: [TestedBlock, () => Promise<TestResult>][] = [
      [
        'search',
        () =>
          window.aiOffice.testAiSearchSettings?.({
            provider: search.provider,
            apiKey:
              search.provider === 'genspark'
                ? ''
                : (search.providers[search.provider]?.apiKey ?? ''),
          }) ?? Promise.resolve(fallback),
      ],
      ['image', () => vendorCheck(media.imageProvider)],
      ['analysis', () => vendorCheck(media.analysisProvider)],
      ['video', () => vendorCheck(media.videoAnalysisProvider)],
    ]
    if (fileSearch?.rerank) {
      blocks.push([
        'rerank',
        () => window.aiOffice.testFileSearchRerank?.(fileSearch) ?? Promise.resolve(fallback),
      ])
    }
    await Promise.all(
      blocks.map(async ([block, run]) => {
        try {
          results[block] = await run()
        } catch (error) {
          results[block] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    if (seq !== testSeqRef.current) return
    setTestResults(results)
    setTesting(false)
  }

  const blockLabel = (block: TestedBlock) =>
    block === 'search'
      ? t('setAiCapSearch')
      : block === 'image'
        ? t('setAiCapImage')
        : block === 'analysis'
          ? t('setAiCapAnalysis')
          : block === 'video'
            ? t('setAiCapVideo')
            : t('setAiCapFileSearch')
  const blockProvider = (block: TestedBlock) => {
    if (block === 'rerank')
      return DECISION_ENDPOINTS.find((e) => e.value === fileSearch?.endpoint)?.label ?? ''
    if (block === 'search')
      return searchCatalog.find((m) => m.id === search.provider)?.label ?? search.provider
    const id =
      block === 'image'
        ? media.imageProvider
        : block === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    return mediaCatalog.find((m) => m.id === id)?.label ?? id
  }
  const blockStatus = (block: TestedBlock): AiStatus | null => {
    if (testing) return { kind: 'testing', text: t('setAiTesting') }
    const r = testResults?.[block]
    if (!r) return null
    return r.ok
      ? { kind: 'ok', text: t('setAiTestOk') }
      : { kind: 'err', text: r.error || t('setAiTestFail') }
  }
  const subhead = (block: TestedBlock, title: string) => (
    <div className="set-pane-subhead" ref={block === focusBlock ? scrollToFocused : undefined}>
      <h4 className="set-pane-subtitle">{title}</h4>
      <AiStatusPill status={blockStatus(block)} />
    </div>
  )
  const failed = testResults
    ? (Object.keys(testResults) as TestedBlock[]).filter((b) => !testResults[b]?.ok)
    : []
  const headStatus: AiStatus | null = testing
    ? { kind: 'testing', text: t('setAiTesting') }
    : testResults
      ? failed.length === 0
        ? { kind: 'ok', text: t('setAiTestOk') }
        : {
            kind: 'err',
            text: `${blockLabel(failed[0]!)} · ${blockProvider(failed[0]!)}: ${testResults[failed[0]!]?.error || t('setAiTestFail')}`,
          }
      : saved
        ? { kind: 'ok', text: t('setAiSaved') }
        : null

  const providerRow = (
    label: string,
    value: string,
    options: { id: string; label: string }[],
    onPick: (id: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label">{t('setAiProvider')}</label>
      </div>
      <Dropdown
        className="set-dd"
        value={value}
        ariaLabel={label}
        options={options.map((c) => ({
          value: c.id,
          label: c.label,
          render: (
            <>
              <ProviderLogo id={c.id} />
              {c.label}
            </>
          ),
        }))}
        onPick={onPick}
      />
    </div>
  )

  const modelRow = (
    id: string,
    models: string[],
    fallback: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label" htmlFor={id}>
          {t('setAiModelId')}
        </label>
      </div>
      {models.length > 0 ? (
        <Dropdown
          className="set-dd"
          value={value || fallback}
          ariaLabel={t('setAiModelId')}
          options={models.map((m) => ({ value: m, label: m }))}
          onPick={onChange}
        />
      ) : (
        <input
          id={id}
          className="set-input"
          type="text"
          value={value}
          placeholder="model-id"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )

  const keyRow = (
    id: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiApiKey')}
          </label>
          <div className="set-field-desc">{t('setAiKeyHint')}</div>
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="password"
        value={value === REDACTED_AI_KEY ? '' : value}
        placeholder={value === REDACTED_AI_KEY ? s('Saved key · enter a replacement') : placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
      />
      {value === REDACTED_AI_KEY && (
        <button type="button" className="set-btn" onClick={() => onChange('')}>
          {s('Remove saved key')}
        </button>
      )}
    </div>
  )

  /** a plain text row with an i18n label; used for the decision-endpoint extra fields */
  const textRow = (
    id: string,
    labelKey: StringKey,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t(labelKey)}
          </label>
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  const baseUrlRow = (
    id: string,
    meta: AiMediaProviderMeta,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiBaseUrl')}
          </label>
          {!meta.needsBaseUrl && <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>}
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="text"
        value={value}
        placeholder={meta.needsBaseUrl ? 'https://…/v1' : meta.defaultBaseUrl}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  /** one media block: provider → model → key → base URL (key/base URL shared per vendor) */
  const mediaBlock = (cap: Exclude<Capability, 'search'>) => {
    const title =
      cap === 'image'
        ? t('setAiCapImage')
        : cap === 'analysis'
          ? t('setAiCapAnalysis')
          : t('setAiCapVideo')
    const options = mediaCatalog.filter((m) =>
      cap === 'image'
        ? !!m.imageProtocol
        : cap === 'video'
          ? !!m.analysisProtocol && m.videoAnalysis
          : !!m.analysisProtocol,
    )
    const current =
      cap === 'image'
        ? media.imageProvider
        : cap === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    const meta = options.find((m) => m.id === current) ?? options[0]!
    const id = meta.id
    const config = mediaConfigOf(id)
    const pick = (next: string) => {
      const p = next as AiMediaProviderId
      setMedia(
        cap === 'image'
          ? { ...media, imageProvider: p }
          : cap === 'video'
            ? { ...media, videoAnalysisProvider: p }
            : { ...media, analysisProvider: p },
      )
    }
    const modelField = cap === 'image' ? 'imageModel' : 'analysisModel'
    return (
      <section key={cap}>
        {subhead(cap, title)}
        {providerRow(title, id, options, pick)}
        <div className="set-field-desc set-ai-note">
          {id === 'genspark' ? t('setAiMediaGensparkHint') : meta.description}
        </div>
        {id !== 'genspark' && (
          <>
            {modelRow(
              `set-ai-${cap}-model`,
              cap === 'image' ? meta.imageModels : meta.analysisModels,
              cap === 'image' ? meta.defaultImageModel : meta.defaultAnalysisModel,
              config[modelField],
              (m) => updateMediaConfig(id, { [modelField]: m }),
            )}
            {keyRow(`set-ai-${cap}-key`, config.apiKey, meta.keyPlaceholder, (v) =>
              updateMediaConfig(id, { apiKey: v }),
            )}
            {baseUrlRow(`set-ai-${cap}-base-url`, meta, config.baseUrl ?? '', (v) =>
              updateMediaConfig(id, { baseUrl: v }),
            )}
          </>
        )}
      </section>
    )
  }

  const searchMeta = searchCatalog.find((m) => m.id === search.provider)
  const searchKey =
    search.provider === 'genspark' ? '' : (search.providers[search.provider]?.apiKey ?? '')

  return (
    <>
      <div className="set-pane-head">
        <h3 className="set-pane-title">{t('setSecAiMedia')}</h3>
        <div className="set-pane-actions">
          <AiStatusPill status={headStatus} />
          <button className="set-btn" disabled={testing || saving} onClick={() => void test()}>
            {t('setAiTest')}
          </button>
          <button className="set-btn primary" disabled={!dirty || testing || saving} onClick={save}>
            {t('setAiSave')}
          </button>
        </div>
      </div>
      {saveError && (
        <p className="nawa-form-error" role="alert">
          {saveError}
        </p>
      )}
      {saveError.includes('AI settings changed') && (
        <button
          className="set-btn"
          disabled={saving || testing}
          onClick={() => setLoadRetry((value) => value + 1)}
        >
          {s('Reload current settings')}
        </button>
      )}
      <fieldset className="set-media-fields" disabled={saving || testing}>
        <div className="set-field-desc set-ai-note">{t('setAiSharedKeyHint')}</div>
        <section>
          {subhead('search', t('setAiCapSearch'))}
          {providerRow(t('setAiCapSearch'), search.provider, searchCatalog, (v) =>
            setSearch({ ...search, provider: v as AiSearchSettings['provider'] }),
          )}
          <div className="set-field-desc set-ai-note">
            {search.provider === 'genspark'
              ? t('setAiSearchGensparkHint')
              : search.provider === 'parallel'
                ? t('setAiSearchParallelHint')
                : search.provider === 'serply'
                  ? t('setAiSearchSerplyHint')
                  : searchMeta?.imageSearch
                    ? t('setAiSearchSerperHint')
                    : t('setAiSearchTavilyHint')}
          </div>
          {search.provider !== 'genspark' &&
            keyRow('set-ai-search-key', searchKey, searchMeta?.keyPlaceholder ?? 'API Key', (v) =>
              setSearch({
                ...search,
                providers: { ...search.providers, [search.provider]: { apiKey: v } },
              }),
            )}
        </section>
        {fileSearch && (
          <section>
            {subhead('rerank', t('setAiCapFileSearch'))}
            <div className="set-field">
              <div className="set-field-text">
                <div className="set-field-stack">
                  <div className="set-field-label">{t('setSearchRerank')}</div>
                  <div className="set-field-desc">{t('setSearchRerankDesc')}</div>
                </div>
              </div>
              <button
                className="set-switch"
                role="switch"
                aria-checked={fileSearch.rerank}
                aria-label={t('setSearchRerank')}
                onClick={() => setFileSearch({ ...fileSearch, rerank: !fileSearch.rerank })}
              />
            </div>
            {fileSearch.rerank && (
              <>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('setSearchRerankEndpoint')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={fileSearch.endpoint}
                    ariaLabel={t('setSearchRerankEndpoint')}
                    options={DECISION_ENDPOINTS}
                    onPick={(v) =>
                      setFileSearch({ ...fileSearch, endpoint: v as DecisionEndpoint })
                    }
                  />
                </div>
                {keyRow(
                  'set-search-jev-key',
                  fileSearch.keys[fileSearch.endpoint],
                  fileSearch.endpoint === 'openrouter' ? 'sk-or-…' : 'API Key',
                  (v) =>
                    setFileSearch({
                      ...fileSearch,
                      keys: { ...fileSearch.keys, [fileSearch.endpoint]: v },
                    }),
                )}
                {fileSearch.endpoint === 'custom' && (
                  <>
                    {textRow(
                      'set-search-jev-url',
                      'setSearchRerankCustomUrl',
                      fileSearch.customBaseUrl,
                      'http://127.0.0.1:8009/v1/systemone',
                      (v) => setFileSearch({ ...fileSearch, customBaseUrl: v }),
                    )}
                    {textRow(
                      'set-search-jev-model',
                      'setSearchRerankCustomModel',
                      fileSearch.customModel,
                      'kev-latest',
                      (v) => setFileSearch({ ...fileSearch, customModel: v }),
                    )}
                  </>
                )}
                {fileSearch.endpoint === 'cloudflare' && (
                  <>
                    {textRow(
                      'set-search-jev-account',
                      'setSearchRerankAccount',
                      fileSearch.cloudflareAccountId,
                      '',
                      (v) => setFileSearch({ ...fileSearch, cloudflareAccountId: v }),
                    )}
                    {textRow(
                      'set-search-jev-cf-model',
                      'setSearchRerankCustomModel',
                      fileSearch.cloudflareModel,
                      '@cf/cloudflare/clef',
                      (v) => setFileSearch({ ...fileSearch, cloudflareModel: v }),
                    )}
                  </>
                )}
              </>
            )}
          </section>
        )}
        {mediaBlock('image')}
        {mediaBlock('analysis')}
        {mediaBlock('video')}
      </fieldset>
    </>
  )
}

interface AiStatus {
  kind: 'testing' | 'ok' | 'err'
  text: string
}

/** colored feedback pill in the AI pane header: spinner while testing, then success/error */
function AiStatusPill({ status }: { status: AiStatus | null }) {
  if (!status) return null
  return (
    <span
      className={`set-ai-status ${status.kind}`}
      role="status"
      // error text (HTTP body, network message) can be long — full text via native tooltip
      title={status.kind === 'err' ? status.text : undefined}
    >
      {status.kind === 'testing' ? (
        <span className="set-ai-spin" aria-hidden="true" />
      ) : status.kind === 'ok' ? (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path
            d="M4.2 7.3l1.9 1.9 3.7-4.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path d="M7 3.8v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="1" fill="currentColor" />
        </svg>
      )}
      <span className="set-ai-status-text">{status.text}</span>
    </span>
  )
}

export interface SettingsModalProps {
  initialSection?: SettingsSection
  status: AccountStatus | null
  loggingOut: boolean
  /** browser sign-in in progress (spinner shows on the account entry) */
  loginWaiting: boolean
  /** device auth URL while waiting — rescue actions when the browser did not auto-open */
  loginUrl: string | null
  urlCopied: boolean
  onOpenLoginUrl: () => void
  onCopyLoginUrl: () => void
  onClose: () => void
  /** the decision-model search settings were saved; the home search re-judges or drops its current order */
  onFileSearchChange?: () => void
  /** closes the modal and launches the Genspark login flow (progress shows on the account entry) */
  onLogin: () => void
  onLogout: () => void
  /** an installed skill is older than the bundled one: dot on the Integrations entry */
  skillUpdateDue?: boolean
  onSkillUpdateDue?: (due: boolean) => void
  /** open on this section / block instead of the account page */
  target?: SettingsTarget | null
}

export function SettingsModal({
  initialSection = 'account',
  status,
  loggingOut,
  loginWaiting,
  loginUrl,
  urlCopied,
  onOpenLoginUrl,
  onCopyLoginUrl,
  onClose,
  onFileSearchChange,
  onLogin,
  onLogout,
  skillUpdateDue: updateDue = false,
  onSkillUpdateDue,
  target,
}: SettingsModalProps) {
  const { lang, setLang, t } = useI18n()
  const { s, dir } = useSidebarText()
  const [section, setSection] = useState<SettingsSection>(target?.section ?? initialSection)
  const [visited, setVisited] = useState<Set<SettingsSection>>(
    () => new Set([target?.section ?? initialSection]),
  )
  const [myAgentVisited, setMyAgentVisited] = useState(false)
  const [activities, setActivities] = useState<Record<string, PanelActivity>>({})
  const [closePrompt, setClosePrompt] = useState(false)
  const modal = useRef<HTMLDivElement>(null)
  const publish = useCallback((_tab: unknown, source: string, activity: PanelActivity | null) => {
    setActivities((previous) => {
      if (!activity) {
        if (!previous[source]) return previous
        const next = { ...previous }
        delete next[source]
        return next
      }
      if (
        previous[source]?.kind === activity.kind &&
        previous[source]?.text === activity.text &&
        previous[source]?.dirty === activity.dirty
      )
        return previous
      return { ...previous, [source]: activity }
    })
  }, [])
  const busy = Object.values(activities).some((activity) => activity.kind === 'busy')
  const dirty = Object.values(activities).some(
    (activity) => activity.dirty || activity.kind === 'unsaved',
  )
  const requestClose = useCallback(() => {
    if (busy) return
    if (dirty) setClosePrompt(true)
    else onClose()
  }, [busy, dirty, onClose])
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose
  const knowledgeLabel = s('Knowledge')
  useEffect(() => {
    if (!target) return
    setSection(target.section)
    setVisited((previous) => new Set([...previous, target.section]))
  }, [target])
  const [theme, setTheme] = useState<UiTheme>('system')
  const [docTheme, setDocTheme] = useState<DocTheme>('follow')
  const [saveDir, setSaveDir] = useState('')
  const [analyticsOn, setAnalyticsOn] = useState(true)
  const [analyticsSaving, setAnalyticsSaving] = useState(false)
  const [autoSaveOn, setAutoSaveOn] = useState(false)
  const [defaultApp, setDefaultApp] = useState<DefaultAppStatus | null>(null)
  const [defaultAppBusy, setDefaultAppBusy] = useState(false)
  const [defaultAppFailed, setDefaultAppFailed] = useState(false)
  const [aiPrefs, setAiPrefs] = useState<AiPanelPrefs>(DEFAULT_AI_PANEL_PREFS)
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable')
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState<UpdateUiState | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getDocumentTheme?.().then((th) => {
      if (alive) setDocTheme(th)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAnalyticsEnabled?.().then((on) => {
      if (alive) setAnalyticsOn(on !== false)
    })
    void window.aiOffice.getAutoSaveDefault?.().then((v) => {
      if (alive) setAutoSaveOn(v.on)
    })
    void window.aiOffice.getDefaultAppStatus?.().then((st) => {
      if (alive) setDefaultApp(st)
    })
    void window.aiOffice.getAiPanelPrefs?.().then((prefs) => {
      if (alive) setAiPrefs(prefs)
    })
    void window.aiOffice.getUpdateChannel?.().then((ch) => {
      if (alive) setChannel(ch)
    })
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    // a rejected invoke (main process not ready, a shell whose preload does
    // not expose the channel) must not surface as an unhandled rejection;
    // without a known state the About row simply stays hidden
    void window.aiOffice
      .getUpdateState?.()
      .then((s) => {
        if (alive) setUpdateState(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // live update state: the About row offers the update as soon as one is known
  useEffect(() => {
    const off = window.aiOffice.onUpdateStateChanged?.((s) => setUpdateState(s))
    return () => off?.()
  }, [])

  useEffect(() => {
    const element = modal.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings: HTMLElement[] = []
    let branch: HTMLElement = element.parentElement!
    while (branch.parentElement) {
      siblings.push(
        ...[...branch.parentElement.children].filter(
          (node): node is HTMLElement => node instanceof HTMLElement && node !== branch,
        ),
      )
      branch = branch.parentElement
    }
    const inert = siblings.map((node) => [node, node.inert] as const)
    inert.forEach(([node]) => {
      node.inert = true
    })
    element.querySelector<HTMLElement>('.set-nav-item.active')?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
      }
      if (e.key !== 'Tab') return
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0)
      const first = controls[0],
        last = controls.at(-1)
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      inert.forEach(([node, value]) => {
        node.inert = value
      })
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const applyDocumentTheme = (next: DocTheme) => {
    setDocTheme(next)
    void window.aiOffice.setDocumentTheme(next)
  }

  const updateAiPrefs = (patch: Partial<AiPanelPrefs>) => {
    setAiPrefs((prev) => ({ ...prev, ...patch }))
    void window.aiOffice.setAiPanelPrefs(patch).then(setAiPrefs)
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  // Windows only opens the system page; re-read ownership when the user comes back
  useEffect(() => {
    if (!defaultApp?.manualOnly) return
    const refresh = () => {
      void window.aiOffice.getDefaultAppStatus?.().then(setDefaultApp)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [defaultApp?.manualOnly])

  const claimDefaultApp = () => {
    setDefaultAppBusy(true)
    setDefaultAppFailed(false)
    void window.aiOffice
      .setDefaultApp()
      .then((st) => {
        setDefaultApp(st)
        if (!st.manualOnly && st.state !== 'default') setDefaultAppFailed(true)
      })
      .catch(() => setDefaultAppFailed(true))
      .finally(() => setDefaultAppBusy(false))
  }

  const defaultAppDesc = (() => {
    if (!defaultApp) return ''
    if (defaultAppFailed) return t('setDefaultAppFailed')
    if (defaultApp.state === 'default') return t('setDefaultAppIs')
    if (defaultApp.state === 'other' && defaultApp.others.length > 0)
      return t('setDefaultAppOther', { app: defaultApp.others.join(', ') })
    return t('setDefaultAppDesc')
  })()

  const loggedIn = status?.loggedIn ?? false
  const email = status?.email ?? ''

  return (
    <PanelActivityContext.Provider value={publish}>
      <div
        className="set-overlay"
        dir={dir}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) requestClose()
        }}
      >
        <div
          ref={modal}
          className="set-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('settings')}
        >
          <div className="set-header">
            <h2 className="set-title">{t('settings')}</h2>
            <button
              className="set-close"
              disabled={busy}
              onClick={requestClose}
              aria-label={t('cancel')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M2 2l10 10M12 2L2 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <div className="set-body">
            <nav className="set-nav" aria-label={t('settings')}>
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  className={`set-nav-item${section === s.id ? ' active' : ''}`}
                  aria-current={section === s.id}
                  onClick={() => {
                    setSection(s.id)
                    setVisited((previous) => new Set([...previous, s.id]))
                  }}
                >
                  <SectionIcon id={s.id} />
                  {s.id === 'knowledge' ? knowledgeLabel : t(s.labelKey)}
                  {s.id === 'integrations' && updateDue && (
                    <span className="set-nav-dot" role="img" aria-label={t('intgUpdateDue')} />
                  )}
                </button>
              ))}
            </nav>
            <div className="set-pane">
              {section === 'account' && (
                <>
                  <h3 className="set-pane-title">{t('setSecAccount')}</h3>
                  <Field label={t('setEmail')} value={loggedIn ? email : t('setNotLoggedIn')} />
                  {loggedIn && (
                    <Field
                      label={t('credits')}
                      value={
                        status?.creditBalance === undefined
                          ? '—'
                          : Math.floor(status.creditBalance).toLocaleString('en-US')
                      }
                      action={
                        <button
                          className="set-btn"
                          data-tip={t('creditsTip')}
                          onClick={() => void window.aiOffice.openCreditUsage?.()}
                        >
                          {t('setViewUsage')}
                        </button>
                      }
                    />
                  )}
                  <div className="set-pane-footer">
                    {loggedIn ? (
                      <button className="set-btn danger" disabled={loggingOut} onClick={onLogout}>
                        {loggingOut ? t('loggingOut') : t('logout')}
                      </button>
                    ) : (
                      <>
                        {loginWaiting && loginUrl && (
                          <>
                            <button className="set-btn" onClick={onOpenLoginUrl}>
                              {t('loginOpenManually')}
                            </button>
                            <button className="set-btn" onClick={onCopyLoginUrl}>
                              {urlCopied ? t('loginCopied') : t('loginCopyUrl')}
                            </button>
                          </>
                        )}
                        <button className="set-btn primary" onClick={onLogin}>
                          {loginWaiting ? t('waitingShort') : t('loginGenspark')}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
              <div hidden={section !== 'aiModel'}>
                {visited.has('aiModel') && <AiModelPane t={t} />}
              </div>
              <div hidden={section !== 'aiMedia'}>
                {visited.has('aiMedia') && (
                  <AiMediaPane
                    t={t}
                    onFileSearchChange={onFileSearchChange}
                    focusBlock={section === 'aiMedia' ? target?.block : undefined}
                  />
                )}
              </div>
              <div hidden={section !== 'knowledge'}>
                {visited.has('knowledge') && (
                  <KnowledgeSettings suspended={activities['myagent-settings']?.kind === 'busy'} />
                )}
              </div>
              {section === 'general' && (
                <>
                  <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('language')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={lang}
                      ariaLabel={t('language')}
                      options={LANG_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                      onPick={(v) => setLang(v as typeof lang)}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('theme')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={theme}
                      ariaLabel={t('theme')}
                      options={THEME_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => applyTheme(v as UiTheme)}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('documentTheme')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={docTheme}
                      ariaLabel={t('documentTheme')}
                      options={DOC_THEME_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => applyDocumentTheme(v as DocTheme)}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('setAiPanelSide')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={aiPrefs.side}
                      ariaLabel={t('setAiPanelSide')}
                      options={[
                        { value: 'left', label: t('aiPanelSideLeft') },
                        { value: 'right', label: t('aiPanelSideRight') },
                      ]}
                      onPick={(side) => updateAiPrefs({ side: side as AiPanelSide })}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('setAiFontSize')}</label>
                    </div>
                    {aiPrefs.fontSize === 'custom' && (
                      <CustomFontSizeInput
                        value={aiPrefs.customFontSize}
                        label={t('aiFontSizeCustom')}
                        onCommit={(px) => updateAiPrefs({ customFontSize: px })}
                      />
                    )}
                    <Dropdown
                      className="set-dd"
                      value={aiPrefs.fontSize}
                      ariaLabel={t('setAiFontSize')}
                      options={AI_FONT_SIZE_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => {
                        const fontSize = v as AiFontSize
                        // start the custom size from the preset being left so nothing jumps
                        updateAiPrefs(
                          fontSize === 'custom' && aiPrefs.fontSize !== 'custom'
                            ? { fontSize, customFontSize: aiPanelFontPx(aiPrefs) }
                            : { fontSize },
                        )
                      }}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAiSpellcheck')}</div>
                        <div className="set-field-desc">{t('setAiSpellcheckDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={aiPrefs.spellcheck}
                      aria-label={t('setAiSpellcheck')}
                      onClick={() => updateAiPrefs({ spellcheck: !aiPrefs.spellcheck })}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAiOpenInNewDocs')}</div>
                        <div className="set-field-desc">{t('setAiOpenInNewDocsDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={aiPrefs.openInNewDocs}
                      aria-label={t('setAiOpenInNewDocs')}
                      onClick={() => updateAiPrefs({ openInNewDocs: !aiPrefs.openInNewDocs })}
                    />
                  </div>
                  {defaultApp && defaultApp.state !== 'unsupported' && (
                    <div className="set-field">
                      <div className="set-field-text">
                        <div className="set-field-stack">
                          <div className="set-field-label">{t('setDefaultApp')}</div>
                          <div className="set-field-desc">{defaultAppDesc}</div>
                        </div>
                      </div>
                      <button
                        className="set-btn"
                        disabled={defaultAppBusy || defaultApp.state === 'default'}
                        onClick={claimDefaultApp}
                      >
                        {defaultApp.manualOnly
                          ? t('setDefaultAppOpenSettings')
                          : t('setDefaultAppSet')}
                      </button>
                    </div>
                  )}
                  <Field
                    label={t('saveLocation')}
                    value={saveDir || '—'}
                    valueTitle={saveDir}
                    action={
                      <button className="set-btn" onClick={changeSaveDir}>
                        {t('setChange')}
                      </button>
                    }
                  />
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAutoSave')}</div>
                        <div className="set-field-desc">{t('setAutoSaveDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={autoSaveOn}
                      aria-label={t('setAutoSave')}
                      onClick={() => {
                        const next = !autoSaveOn
                        setAutoSaveOn(next)
                        void window.aiOffice.setAutoSaveDefault?.(next).catch(() => {})
                      }}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAnalytics')}</div>
                        <div className="set-field-desc">{t('setAnalyticsDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={analyticsOn}
                      aria-label={t('setAnalytics')}
                      disabled={analyticsSaving}
                      onClick={() => {
                        const next = !analyticsOn
                        setAnalyticsSaving(true)
                        void window.aiOffice
                          .setAnalyticsEnabled(next)
                          .then((persisted) => {
                            if (persisted) setAnalyticsOn(next)
                          })
                          .catch(() => {})
                          .finally(() => setAnalyticsSaving(false))
                      }}
                    />
                  </div>
                </>
              )}
              {section === 'integrations' && (
                <IntegrationsPane t={t} onStatus={(st) => onSkillUpdateDue?.(skillUpdateDue(st))} />
              )}
              <div hidden={section !== 'integrations'}>
                {visited.has('integrations') && (
                  <details
                    className="set-optional-integration"
                    onToggle={(event) => {
                      if (event.currentTarget.open) setMyAgentVisited(true)
                    }}
                  >
                    <summary>{s('MyAgent server (optional)')}</summary>
                    {myAgentVisited && (
                      <MyAgentSettings
                        hideConnection
                        connectionPending={
                          !!activities['search-settings']?.dirty ||
                          ['unsaved', 'busy'].includes(activities['search-settings']?.kind ?? '')
                        }
                      />
                    )}
                  </details>
                )}
              </div>
              {section === 'about' && (
                <>
                  <h3 className="set-pane-title">{t('setSecAbout')}</h3>
                  <Field label={t('versionLabel')} value={appVersion || '—'} />
                  {updateState && (
                    <div className="set-field">
                      <div className="set-field-text">
                        <label className="set-field-label">{t('setUpdateAvailableLabel')}</label>
                      </div>
                      <button
                        type="button"
                        className="set-update-btn"
                        onClick={() => void window.aiOffice.openUpdateDialog?.()}
                      >
                        {updateState.phase === 'downloading'
                          ? t('setUpdateDownloading', {
                              percent: Math.round(updateState.percent),
                            })
                          : updateState.phase === 'downloaded'
                            ? t('setUpdateRestart')
                            : t('setUpdateTo', { version: updateState.version })}
                      </button>
                    </div>
                  )}
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('updateChannel')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={channel}
                      ariaLabel={t('updateChannel')}
                      options={CHANNEL_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => {
                        const next = v === 'beta' ? 'beta' : 'stable'
                        setChannel(next)
                        void window.aiOffice.setUpdateChannel(next)
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
          {closePrompt && (
            <div className="set-close-prompt" role="alert">
              <span>{s('Discard unsaved settings?')}</span>
              <button type="button" className="set-btn" onClick={() => setClosePrompt(false)}>
                {s('Keep editing')}
              </button>
              <button type="button" className="set-btn danger" disabled={busy} onClick={onClose}>
                {s('Discard and close')}
              </button>
            </div>
          )}
        </div>
      </div>
    </PanelActivityContext.Provider>
  )
}
