import { useEffect, useId, useState } from 'react'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { usePanelActivity } from '../explorer/panel-state'
import { DEFAULT_RAG_SETTINGS, type RagSettings as Settings, type RagSettingsView } from '../../../shared/rag-api'
import './rag.css'

export function RagSettings({ myAgentOnly = false, suspended = false, compact = false, onDirtyChanged }: {
  myAgentOnly?: boolean
  suspended?: boolean
  compact?: boolean
  onDirtyChanged?(dirty: boolean): void
}) {
  const { s } = useSidebarText(), id = useId()
  const [retry, setRetry] = useState(0)
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_RAG_SETTINGS })
  const [view, setView] = useState<RagSettingsView | null>(null)
  const [key, setKey] = useState(''), [removeKey, setRemoveKey] = useState(false)
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [models, setModels] = useState<string[]>([])
  const busy = working || suspended, remote = settings.backend === 'myagent', native = settings.backend === 'native'
  const dirty = !!view && (!!key || removeKey || JSON.stringify(settings) !== JSON.stringify(view.settings))
  useEffect(() => { onDirtyChanged?.(dirty || working) }, [dirty, working, onDirtyChanged])
  usePanelActivity('ragAnalytics', 'search-settings', working ? { kind: 'busy', text: s('Working…'), dirty }
    : error ? { kind: 'error', text: error, dirty } : dirty ? { kind: 'unsaved', text: s('Unsaved search settings') } : null)
  useEffect(() => {
    let alive = true
    setError('')
    if (!window.nawaRag) { setError(s('RAG bridge is unavailable. Rebuild and restart Nawa.')); return }
    void window.nawaRag.settings().then(result => {
      if (!alive) return
      setView(result)
      setSettings(myAgentOnly ? { ...result.settings, backend: 'myagent' } : result.settings)
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [retry, myAgentOnly])
  const change = <K extends keyof Settings>(field: K, value: Settings[K]) => {
    setSettings(previous => ({ ...previous, [field]: value })); setNotice(''); setError('')
    if (field === 'baseUrl') setModels([])
  }
  const useBackend = (backend: Settings['backend']) => {
    setSettings(previous => backend === 'local' && previous.backend !== 'local'
      ? { ...DEFAULT_RAG_SETTINGS, enabled: previous.enabled, serverUrl: previous.serverUrl }
      : { ...previous, backend })
    setModels([]); setNotice(''); setError('')
  }
  const credential = () => removeKey ? '' : key.trim() ? key : undefined
  const perform = async (action: 'save' | 'test' | 'models' | 'generate') => {
    if (busy || !view) return
    setWorking(true); setError(''); setNotice('')
    try {
      if (action === 'save') {
        const result = await window.nawaRag.save(settings, credential())
        setView(result); setSettings(result.settings); setKey(''); setRemoveKey(false)
        setNotice(s('Settings saved.'))
        window.dispatchEvent(new Event('nawa:rag-settings-changed'))
      } else if (action === 'models') {
        const ids = await window.nawaRag.models(settings, credential())
        setModels(ids)
        if (ids.length === 1) change('model', ids[0])
        setNotice(s(ids.length === 1 ? 'Loaded model selected. Test connection to verify embeddings.' : 'Choose a loaded embedding model.'))
      } else if (action === 'generate') {
        setKey(await window.nawaMyAgent.generateKey())
      } else {
        const result = await window.nawaRag.test(settings, credential())
        setNotice(result.message)
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setWorking(false) }
  }
  const textField = (field: 'serverUrl' | 'baseUrl' | 'model' | 'modelRevision' | 'documentPrefix' | 'queryPrefix', label: string, hint?: string) => (
    <label className="nawa-rag-field" htmlFor={`${id}-${field}`} key={field}>
      <span>{s(label)}</span>
      <input id={`${id}-${field}`} aria-label={s(label)} className="set-input" value={settings[field]} disabled={busy}
        onChange={e => change(field, e.target.value)} spellCheck={false} dir="ltr" list={field === 'model' ? `${id}-models` : undefined}
        placeholder={field === 'baseUrl' ? DEFAULT_RAG_SETTINGS.baseUrl : undefined} />
      {hint && <small>{s(hint)}</small>}
    </label>
  )
  const numberField = (field: 'dimensions' | 'maxInputTokens' | 'chunkTokens' | 'overlapTokens' | 'batchSize' | 'concurrency' | 'timeoutMs' | 'topK' | 'contextChars', label: string, min: number, max: number) => (
    <label className="nawa-rag-field" key={field} htmlFor={`${id}-${field}`}><span>{s(label)}</span>
      <input id={`${id}-${field}`} className="set-input" type="number" min={min} max={max} step={1} value={settings[field]} disabled={busy}
        onChange={e => change(field, Number(e.target.value))} /></label>
  )
  if (!view) return <div><p role={error ? 'alert' : 'status'}>{error || s('Loading…')}</p>
    {error && <button type="button" className="set-btn" onClick={() => setRetry(value => value + 1)}>{s('Retry')}</button>}</div>
  return <section className={`nawa-rag-settings${compact ? ' is-compact' : ''}`} aria-label={s(myAgentOnly ? 'MyAgent connection' : 'Embedding settings')}>
    {!myAgentOnly && <h4 className="nawa-settings-heading">{s('File search')}</h4>}
    <label className="nawa-rag-check"><input type="checkbox" disabled={busy} checked={settings.enabled}
      onChange={e => change('enabled', e.target.checked)} />{s('Enable file search')}</label>
    {remote ? textField('serverUrl', 'MyAgent server URL') : native ? <div className="nawa-embedding-source">
      <span>{s('Built-in embedding model')}</span>
      <button type="button" className="set-btn" disabled={busy} onClick={() => useBackend('local')}>{s('Use llama.cpp')}</button>
    </div> : <>
      <div className="nawa-embedding-source"><strong>llama.cpp</strong><span>{s('Local embedding server')}</span></div>
      {textField('baseUrl', 'Server address')}
      <div className="nawa-embedding-model">
        {models.length > 1 ? <label className="nawa-rag-field" htmlFor={`${id}-model`}><span>{s('Embedding model')}</span>
          <select id={`${id}-model`} className="set-input" aria-label={s('Embedding model')} value={settings.model} disabled={busy} onChange={e => change('model', e.target.value)}>
            {!models.includes(settings.model) && <option value={settings.model}>{settings.model || s('Choose a model')}</option>}
            {models.map(model => <option key={model} value={model}>{model}</option>)}
          </select></label> : textField('model', 'Embedding model')}
        <button type="button" className="set-btn" disabled={busy} onClick={() => void perform('models')}>{s('Load models')}</button>
      </div>
      <datalist id={`${id}-models`}>{models.map(model => <option key={model} value={model} />)}</datalist>
    </>}
    <details className="nawa-embedding-advanced"><summary>{s('Advanced embedding settings')}</summary>
      {!myAgentOnly && <label className="nawa-rag-field" htmlFor={`${id}-backend`}><span>{s('Search engine')}</span>
        <select id={`${id}-backend`} className="set-input" aria-label={s('Search engine')} value={settings.backend} disabled={busy}
          onChange={e => useBackend(e.target.value as Settings['backend'])}>
          <option value="local">llama.cpp</option><option value="native">{s('Built-in model')}</option><option value="myagent">MyAgent</option>
        </select></label>}
      {!native && <>
        <label className="nawa-rag-field" htmlFor={`${id}-key`}><span>{s(remote ? 'MyAgent service API key' : 'API key (optional)')}</span>
          <input id={`${id}-key`} className="set-input" type="password" autoComplete="off" value={key} disabled={busy || removeKey}
            placeholder={s(view.hasKey ? 'Stored securely — blank keeps the current key' : 'Optional provider key')} onChange={e => setKey(e.target.value)} /></label>
        {view.hasKey && <label className="nawa-rag-check"><input type="checkbox" checked={removeKey} disabled={busy} onChange={e => setRemoveKey(e.target.checked)} />{s('Remove the stored API key on save')}</label>}
        {remote && <button type="button" className="set-btn" disabled={busy || removeKey} onClick={() => void perform('generate')}>{s('Generate new service key')}</button>}
      </>}
      {!native && !remote && <>
        <label className="nawa-rag-check"><input type="checkbox" disabled={busy} checked={settings.allowRemote} onChange={e => change('allowRemote', e.target.checked)} />{s('Allow a remote embedding server')}</label>
        {settings.allowRemote && <small>{s('Indexed text and search queries will be sent to this server.')}</small>}
        {textField('modelRevision', 'Model revision', 'Change this when replacing model weights under the same name.')}
        <div className="nawa-rag-grid">{textField('documentPrefix', 'Document prefix')}{textField('queryPrefix', 'Query prefix / instruction')}</div>
        <label className="nawa-rag-field" htmlFor={`${id}-tokenizer`}><span>{s('Token counting')}</span>
          <select id={`${id}-tokenizer`} className="set-input" value={settings.tokenizer} disabled={busy} onChange={e => change('tokenizer', e.target.value as Settings['tokenizer'])}>
            <option value="llama.cpp">llama.cpp</option><option value="conservative">{s('Conservative byte budget')}</option>
          </select></label>
      </>}
      <div className="nawa-rag-grid">
        {!native && !remote && <>{numberField('dimensions', 'Vector dimensions (0 = detect)', 0, 16384)}{numberField('maxInputTokens', 'Maximum input tokens', 128, 32768)}</>}
        {!remote && <>{numberField('chunkTokens', 'Chunk size (tokens)', 64, native ? 384 : 16000)}{numberField('overlapTokens', 'Chunk overlap (tokens)', 0, 1000)}</>}
        {!native && !remote && <>{numberField('batchSize', 'Chunks per request', 1, 64)}{numberField('concurrency', 'Concurrent requests', 1, 8)}</>}
        {numberField('timeoutMs', 'Request timeout (milliseconds)', 1000, 300000)}
        {numberField('topK', 'Search results', 1, 24)}{numberField('contextChars', 'Context character limit', 4000, 64000)}
      </div>
      <p className="nawa-settings-hint">{s('Changing the model or chunking requires re-indexing affected files.')}</p>
    </details>
    <div className="nawa-settings-footer">
      <div className="nawa-rag-actions">
        <button type="button" className="set-btn" disabled={busy} onClick={() => void perform('test')}>{s(working ? 'Working…' : native ? 'Download / test model' : 'Test connection')}</button>
        {dirty && <button type="button" className="set-btn" disabled={busy} onClick={() => {
          setSettings(myAgentOnly ? { ...view.settings, backend: 'myagent' } : view.settings); setKey(''); setRemoveKey(false); setNotice(''); setError(''); setModels([])
        }}>{s('Discard changes')}</button>}
        <button type="button" className="set-btn primary" disabled={busy || !dirty} onClick={() => void perform('save')}>{s(working ? 'Working…' : 'Save')}</button>
      </div>
      {dirty && <small role="status">{s('Unsaved changes')}</small>}
      {notice && <p role="status">{notice}</p>}{error && <p className="nawa-rag-error" role="alert">{error}</p>}
    </div>
  </section>
}
