import { useEffect, useId, useState } from 'react'
import { DEFAULT_RAG_SETTINGS, type RagSettings as Settings, type RagSettingsView } from '../../../shared/rag-api'
import './rag.css'
export function RagSettings() {
  const id = useId(), [settings, setSettings] = useState<Settings>({ ...DEFAULT_RAG_SETTINGS })
  const [view, setView] = useState<RagSettingsView | null>(null), [key, setKey] = useState(''), [removeKey, setRemoveKey] = useState(false)
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => {
    let alive = true
    if (!window.nawaRag) { setError('RAG bridge is unavailable. Rebuild and restart Nawa.'); return }
    void window.nawaRag.settings().then(result => { if (alive) { setView(result); setSettings(result.settings); setLoaded(true) } }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [])
  const change = <K extends keyof Settings>(field: K, value: Settings[K]) => { setSettings(previous => ({ ...previous, [field]: value })); setNotice('Unsaved embedding settings.') }
  const credential = () => removeKey ? '' : key.trim() ? key : undefined
  const perform = async (action: 'save' | 'test') => {
    if (busy || !loaded) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (action === 'save') { const result = await window.nawaRag.save(settings, credential()); setView(result); setSettings(result.settings); setKey(''); setRemoveKey(false); setNotice('Embedding settings saved. Changed model, prefixes or chunking settings require re-indexing existing files.'); window.dispatchEvent(new Event('nawa:rag-settings-changed')) }
      else { const result = await window.nawaRag.test(settings, credential()); setNotice(result.message) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const textField = (field: 'baseUrl' | 'model' | 'modelRevision' | 'documentPrefix' | 'queryPrefix', label: string, hint: string) => <label className="nawa-rag-field" htmlFor={`${id}-${field}`} key={field}><span>{label}</span><input id={`${id}-${field}`} className="set-input" value={settings[field]} disabled={busy} onChange={e => change(field, e.target.value)} spellCheck={false}/><small>{hint}</small></label>
  const numberField = (field: 'dimensions' | 'maxInputTokens' | 'chunkTokens' | 'overlapTokens' | 'batchSize' | 'concurrency' | 'timeoutMs' | 'topK' | 'contextChars', label: string, min: number, max: number) => <label className="nawa-rag-field" key={field} htmlFor={`${id}-${field}`}><span>{label}</span><input id={`${id}-${field}`} className="set-input" type="number" min={min} max={max} step={1} value={settings[field]} disabled={busy} onChange={e => change(field, Number(e.target.value))}/></label>
  return <section className="nawa-rag-settings" aria-label="Embedding model and RAG settings">
    <h3 className="set-pane-title">Embeddings &amp; RAG</h3>
    <p>Use your existing llama.cpp embedding server. The chat model remains separate. Text, structural chunks, vectors and fingerprints are stored locally in a separate SQLite database; chat history is not modified.</p>
    <label className="nawa-rag-check"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => change('enabled', e.target.checked)}/> Enable RAG for directory chat’s selected-file content searches</label>
    {textField('baseUrl', 'Embedding API base URL', 'Example: http://127.0.0.1:8081/v1. Requests use /v1/embeddings, not /chat/completions.')}
    {textField('model', 'Embedding model ID / server alias', 'Use the model or alias exposed by your running embedding server. No model is downloaded by Nawa.')}
    {textField('modelRevision', 'Model revision / fingerprint label', 'Change this when replacing GGUF weights behind the same model alias. Dimensions alone cannot identify a model.')}
    <label className="nawa-rag-field" htmlFor={`${id}-key`}><span>API key (optional)</span><input id={`${id}-key`} className="set-input" type="password" autoComplete="off" value={key} disabled={busy || removeKey} placeholder={view?.hasKey ? 'Stored securely — blank keeps the current key' : 'Leave blank when your server needs no key'} onChange={e => setKey(e.target.value)}/><small>Keys are stored with OS protection and are not returned to the renderer.</small></label>
    {view?.hasKey && <label className="nawa-rag-check"><input type="checkbox" checked={removeKey} disabled={busy} onChange={e => setRemoveKey(e.target.checked)}/> Remove the stored API key on save</label>}
    <label className="nawa-rag-check"><input type="checkbox" checked={settings.allowRemote} disabled={busy} onChange={e => change('allowRemote', e.target.checked)}/> Allow a LAN/remote embedding endpoint. I understand indexed text and retrieval queries will be sent to that configured server.</label>
    <details><summary>Model input format and chunking</summary>
      {textField('documentPrefix', 'Document prefix', 'Leave empty unless required by this embedding model. Prefixes are included in token-limit checks.')}
      {textField('queryPrefix', 'Query prefix / instruction', 'Use the retrieval-query format required by the same model. Query and document prefixes may differ.')}
      <label className="nawa-rag-field" htmlFor={`${id}-tokenizer`}><span>Token counting</span><select id={`${id}-tokenizer`} className="set-input" value={settings.tokenizer} disabled={busy} onChange={e => change('tokenizer', e.target.value as Settings['tokenizer'])}><option value="llama.cpp">llama.cpp /tokenize — model tokenizer</option><option value="conservative">Conservative UTF-8 byte budget — smaller chunks</option></select><small>Conservative mode is for gateways without /tokenize. It is an estimate, not an exact tokenizer.</small></label>
      <div className="nawa-rag-grid">{numberField('dimensions', 'Expected vector dimensions (0 = detect)', 0, 16384)}{numberField('maxInputTokens', 'Maximum embedding input tokens', 128, 32768)}{numberField('chunkTokens', 'Target chunk tokens including context', 64, 16000)}{numberField('overlapTokens', 'Overlap target (approximate)', 0, 1000)}</div>
      <p>Pages, headings, table rows, worksheet cell addresses, slide numbers and notes are retained where supported. Oversized structural blocks are split with repeated context; image-only content is not silently marked embedded.</p>
    </details>
    <details><summary>Performance and retrieval</summary><div className="nawa-rag-grid">{numberField('batchSize', 'Chunks per embedding request', 1, 64)}{numberField('concurrency', 'Concurrent embedding requests', 1, 8)}{numberField('timeoutMs', 'Request timeout (milliseconds)', 1000, 300000)}{numberField('topK', 'Primary retrieved chunks', 1, 24)}{numberField('contextChars', 'Retrieved text character budget', 4000, 64000)}</div><p>Vector and keyword results are fused. Extraction runs in a worker; indexing and search have separate workers. Increase concurrency only within your embedding server’s capacity.</p></details>
    <div className="nawa-rag-actions"><button className="set-btn" type="button" disabled={busy || !loaded} onClick={() => void perform('test')}>{busy ? 'Working…' : 'Test connection'}</button><button className="set-btn primary" type="button" disabled={busy || !loaded} onClick={() => void perform('save')}>Save embedding settings</button></div>
    {notice && <p role="status">{notice}</p>}{error && <p className="nawa-rag-error" role="alert">{error}</p>}
    {view && <p className="nawa-rag-path">RAG database: <code>{view.databasePath}</code><br/>Extracted text and vectors are unencrypted. Clearing a directory index does not delete original files or conversations.</p>}
  </section>
}
