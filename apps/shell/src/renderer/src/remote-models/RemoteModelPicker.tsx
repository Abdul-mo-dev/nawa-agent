import { useEffect, useId, useState } from 'react'
import { REDACTED_AI_KEY } from '@genoffice/ai-provider/browser'
import type { RemoteEmbeddingProfile } from '../../../shared/remote-models-api'
import { remoteModelStrings } from '../i18n/strings-remote-models'
import { useI18n } from '../locale'

interface Props {
  profile: RemoteEmbeddingProfile & {
    role: 'chat' | 'embedding'
    key?: string
    hasKey: boolean
    isNew: boolean
  }
  onChange(model: string): void
}
const CUSTOM = 'custom'

/** Discovery never picks a model or overwrites a custom ID on the user's behalf. */
export function RemoteModelPicker({ profile, onChange }: Props) {
  const { lang } = useI18n()
  const copy = remoteModelStrings[lang],
    id = useId()
  const [catalog, setCatalog] = useState<string[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'failed'>('idle')
  const [refresh, setRefresh] = useState(0)
  const [custom, setCustom] = useState(false)
  const { baseUrl, key, hasKey, role, id: profileId } = profile
  const selected = catalog.includes(profile.model) && !custom ? `model:${profile.model}` : CUSTOM
  useEffect(() => {
    let canceled = false
    setCatalog([])
    setState('idle')
    let url: URL
    try {
      url = new URL(baseUrl.trim())
    } catch {
      return
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      key === REDACTED_AI_KEY
    )
      return
    setState('loading')
    const timer = setTimeout(() => {
      const list =
        role === 'chat'
          ? window.aiOffice
              .getCustomModels(baseUrl, key ?? (hasKey ? REDACTED_AI_KEY : ''), profileId)
              .then((value) => value.models)
          : window.nawaRemoteEmbeddings.models(
              { ...profile, name: profile.name.trim() || 'Remote model' },
              key,
            )
      void list
        .then((models) => {
          if (canceled) return
          const ids = [
            ...new Set(
              models.filter(
                (value) => typeof value === 'string' && value.trim() && value.length <= 256,
              ),
            ),
          ]
          setCatalog(ids)
          setState(ids.length ? 'ready' : 'empty')
        })
        .catch(() => {
          if (!canceled) setState('failed')
        })
    }, 500)
    return () => {
      canceled = true
      clearTimeout(timer)
    }
    // Changes to model/label/embedding tuning do not repeat discovery or alter credentials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, key, hasKey, role, profileId, refresh])
  return (
    <div className="rm-field rm-model-picker">
      <label htmlFor={`${id}-list`}>{copy.availableModels}</label>
      <div className="rm-model-list">
        <select
          id={`${id}-list`}
          className="set-input"
          dir="ltr"
          value={selected}
          onChange={(event) => {
            const value = event.target.value
            setCustom(value === CUSTOM)
            if (value !== CUSTOM) onChange(value.slice('model:'.length))
          }}
        >
          <option value={CUSTOM}>{copy.customModel}</option>
          {catalog.map((model) => (
            <option key={model} value={`model:${model}`}>
              {model}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="set-btn"
          disabled={state === 'loading' || !baseUrl.trim()}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {copy.refreshModels}
        </button>
      </div>
      {selected === CUSTOM && (
        <label htmlFor={`${id}-custom`}>
          <span>{copy.model}</span>
          <input
            id={`${id}-custom`}
            className="set-input"
            value={profile.model}
            maxLength={256}
            dir="ltr"
            spellCheck={false}
            required
            onChange={(event) => {
              setCustom(true)
              onChange(event.target.value)
            }}
          />
        </label>
      )}
      <span className="lm-hint" role="status">
        {state === 'loading'
          ? copy.modelsLoading
          : state === 'ready'
            ? copy.modelsReady
            : state === 'empty' || state === 'failed'
              ? copy.modelsUnavailable
              : copy.modelsHint}
      </span>
    </div>
  )
}
