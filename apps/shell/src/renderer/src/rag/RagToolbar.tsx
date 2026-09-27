import { useEffect, useState } from 'react'
import type { RagProgress, RagSettingsView } from '../../../shared/rag-api'
import './rag.css'
export function RagToolbar({ folder , inSidebar = false }: { folder: string | null ; inSidebar?: boolean }) {
  const [settings, setSettings] = useState<RagSettingsView | null>(null), [progress, setProgress] = useState<RagProgress | null>(null)
  const [recursive, setRecursive] = useState(true), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [clear, setClear] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true, pending = false
    setConsent(false); setClear(false); setError('')
    if (!window.nawaRag) { setError('RAG unavailable. Rebuild and restart the shell.'); return }
    const load = () => { void window.nawaRag.settings().then(value => { if (alive) setSettings(value) }).catch(e => { if (alive) setError(String(e)) }) }
    const poll = () => {
      if (pending) return
      pending = true
      void window.nawaRag.progress().then(value => { if (alive) setProgress(value) }).catch(e => { if (alive) setError(String(e)) }).finally(() => { pending = false })
    }
    const changed = () => { poll() }
    const changedSettings = () => { setConsent(false); load() }
    load(); poll()
    const off = window.nawaRag.onChanged(changed), timer = setInterval(poll, 2000)
    window.addEventListener('nawa:rag-settings-changed', changedSettings)
    return () => { alive = false; off(); clearInterval(timer); window.removeEventListener('nawa:rag-settings-changed', changedSettings) }
  }, [folder])
  const action = async (kind: 'index' | 'cancel' | 'clear') => {
    if (!folder || busy) return
    setBusy(true); setError('')
    try {
      if (kind === 'index') setProgress(await window.nawaRag.index(folder, recursive, consent))
      else if (kind === 'cancel') await window.nawaRag.cancel()
      else { await window.nawaRag.clear(folder); setClear(false) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  if (!folder) return null
  const running = progress?.running === true
  return <section className="nawa-rag-toolbar" aria-label="Directory RAG indexing" onContextMenu={e => e.stopPropagation()}>
    <details open={inSidebar || undefined}><summary>Directory RAG · {settings?.settings.enabled ? settings.settings.model : 'not configured'}</summary>
      <p>Index the opened directory using <code>{settings?.settings.baseUrl ?? 'the configured embedding endpoint'}</code>. Configure it in Settings → Embeddings &amp; RAG.</p>
      <label className="nawa-rag-check"><input type="checkbox" disabled={running || busy} checked={recursive} onChange={e => setRecursive(e.target.checked)}/> Include subdirectories (hidden entries, links and node_modules are excluded)</label>
      <label className="nawa-rag-check"><input type="checkbox" disabled={running || busy} checked={consent} onChange={e => setConsent(e.target.checked)}/> I allow text from this directory to be sent to the configured embedding server and stored in Nawa’s unencrypted local RAG index.</label>
      <p>Chat still reads only individually selected files. Indexing does not change the file-selection permission rules.</p>
      <div className="nawa-rag-actions"><button className="set-btn primary" type="button" disabled={busy || running || !consent || !settings?.settings.enabled} onClick={() => void action('index')}>Index / refresh directory</button><button className="set-btn" type="button" disabled={busy || running} onClick={() => setClear(true)}>Clear this directory’s RAG index</button></div>
      {clear && <div role="group" aria-label="Confirm clearing RAG index"><p>Remove indexed chunks and vectors for this directory and its subdirectories? Original files and chat history will stay unchanged.</p><button className="set-btn danger" disabled={busy} onClick={() => void action('clear')}>Clear index records</button> <button className="set-btn" disabled={busy} onClick={() => setClear(false)}>Keep index</button></div>}
    </details>
    {running && <div className="nawa-rag-running"><span role="status">{progress?.message} · {progress?.scanned} files checked · {progress?.embedded} embedded · {progress?.failed} failed</span><button type="button" className="set-btn" disabled={busy} onClick={() => void action('cancel')}>Stop indexing</button></div>}
    {!running && progress?.folder === folder && progress.message && <p role="status">{progress.message}</p>}
    {error && <p className="nawa-rag-error" role="alert">{error}</p>}
  </section>
}
