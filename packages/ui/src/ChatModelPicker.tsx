import { useEffect, useRef, useState } from 'react'

interface ModelChoice { id: string; name: string; provider: string; config: { model: string } }
interface ModelSettings { chatModels?: ModelChoice[] | undefined; defaultChatModelId?: string | undefined }
export interface ChatModelPickerProps {
  loadSettings: () => Promise<ModelSettings>
  onChange: (id: string) => void
  /** Per-file/per-directory preference. Only the profile ID, never credentials, is stored here. */
  storageKey?: string
  initialId?: string
  disabled?: boolean
}
export function ChatModelPicker({ loadSettings, onChange, storageKey, initialId = '', disabled = false }: ChatModelPickerProps) {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [selected, setSelected] = useState(() => { try { return storageKey ? localStorage.getItem(storageKey) || '' : initialId } catch { return initialId } })
  const [defaultId, setDefaultId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(loadSettings), changeRef = useRef(onChange), selectedRef = useRef(selected), disabledRef = useRef(disabled)
  loadRef.current = loadSettings; changeRef.current = onChange; disabledRef.current = disabled
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let alive = true, sequence = 0, restored = false
    const refresh = async () => {
      if (disabledRef.current) return
      const current = ++sequence
      try {
        const settings = await loadRef.current()
        if (!alive || current !== sequence || disabledRef.current) return
        const choices = settings.chatModels ?? []
        // Retain only display data in this component, not the fetched API keys.
        setModels(choices.map(m => ({ id: m.id, name: m.name, provider: m.provider, config: { model: m.config.model } })))
        setDefaultId(settings.defaultChatModelId || '')
        let id = selectedRef.current
        if (!restored) {
          restored = true
          try { if (storageKey) id = localStorage.getItem(storageKey) || '' } catch { id = '' }
        }
        if (id && !choices.some(m => m.id === id)) {
          setError('This chat’s saved model was removed. Choose a model before sending.')
          // Keep the missing ID: request resolution fails closed instead of changing providers silently.
        } else setError(null)
        selectedRef.current = id; setSelected(id); changeRef.current(id)
      } catch (cause) { if (alive && current === sequence) setError(cause instanceof Error ? cause.message : String(cause)) }
    }
    refreshRef.current = () => { void refresh() }
    void refresh()
    window.addEventListener('focus', refreshRef.current)
    window.addEventListener('nawa:models-changed', refreshRef.current)
    return () => { alive = false; sequence++; window.removeEventListener('focus', refreshRef.current); window.removeEventListener('nawa:models-changed', refreshRef.current) }
  }, [storageKey])
  const wasDisabled = useRef(disabled)
  useEffect(() => {
    if (wasDisabled.current && !disabled) refreshRef.current()
    wasDisabled.current = disabled
  }, [disabled])
  return <div className="nawa-chat-model-control">
    <label className="nawa-chat-model-label">Model
      <select aria-label="Chat model" value={selected} disabled={disabled} onFocus={() => refreshRef.current()} onChange={event => {
        const id = event.target.value
        selectedRef.current = id; setSelected(id); setError(null); changeRef.current(id)
        try { if (storageKey) localStorage.setItem(storageKey, id) } catch { /* Preference storage is optional. */ }
      }}>
        <option value="">{defaultId ? `Default · ${models.find(m => m.id === defaultId)?.name || 'configured model'}` : 'Default provider model'}</option>
        {selected && !models.some(m => m.id === selected) && <option value={selected}>Removed model — choose another</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.config.model} ({model.provider})</option>)}
      </select>
    </label>
    {error && <span role="alert" className="nawa-chat-model-error">{error}</span>}
    {!models.length && !error && <span className="nawa-chat-model-hint">Add model profiles in Settings → AI model.</span>}
  </div>
}
