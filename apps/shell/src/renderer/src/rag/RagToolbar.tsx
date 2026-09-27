import { useSidebarText } from '../explorer/sidebar-i18n'
import { usePanelActivity } from '../explorer/panel-state'
import { useEffect, useState } from 'react'
import type { RagProgress, RagSettingsView } from '../../../shared/rag-api'
import './rag.css'
export function RagToolbar({ folder, inSidebar = false, onStatus }: { folder: string | null; inSidebar?: boolean; onStatus?(value: string): void }) {
  const { s } = useSidebarText()
  const [retry, setRetry] = useState(0)
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
  }, [folder, retry])
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
  const remote = settings?.settings.backend === 'myagent'
  const configured = settings?.settings.enabled && (remote || !!settings?.settings.model)
  const running = progress?.running === true
  const status = error ? 'Check needs attention' : running ? 'Indexing…' : !settings ? 'Loading…' : configured ? 'Ready' : 'Needs setup'
  useEffect(() => { onStatus?.(status) }, [onStatus, status])
  usePanelActivity('ragAnalytics', 'index', error ? { kind: 'error', text: s('File search') + ': ' + error } : running ? { kind: 'busy', text: s('Indexing…') + ' ' + (progress?.folder ?? '') } : null)
  if (!folder) return null
  return <section className="nawa-rag-toolbar" aria-label={s('File search')} onContextMenu={e => e.stopPropagation()}>
    <details open={inSidebar || undefined}><summary hidden={inSidebar}>{s('File search')} · {s(status)}</summary>
      <p><strong>{remote ? "MyAgent · " : settings?.settings.model ? settings.settings.model + " · " : ""}</strong><bdi>{remote ? settings?.settings.serverUrl : settings?.settings.baseUrl}</bdi></p>
      {status === 'Needs setup' && <p role="status">{s('Configure and enable a RAG backend in Search settings.')}</p>}
      <label className="nawa-rag-check"><input type="checkbox" disabled={running || busy} checked={recursive} onChange={e => setRecursive(e.target.checked)}/>{s('Include subdirectories')}</label>
      <small>{s('Hidden files, links and node_modules are excluded.')}</small>
      <label className="nawa-rag-check"><input type="checkbox" disabled={running || busy} checked={consent} onChange={e => setConsent(e.target.checked)}/>{s(remote ? 'I allow MyAgent on this machine to read this directory and store its contents in the shared index using its configured embedding service.' : 'I allow this directory’s text to be sent to the embedding server and stored in the unencrypted local index.')}</label>
      <div className="nawa-rag-actions"><button className="set-btn primary" type="button" disabled={busy || running || !consent || !configured} onClick={() => void action('index')}>{s('Index / refresh directory')}</button></div>
      <details><summary>{s('Manage stored data')}</summary>
        <button className="set-btn" type="button" disabled={busy || running} onClick={() => setClear(true)}>{s(remote ? 'Forget file mappings' : 'Clear index')}</button>
        {clear && <div role="group" aria-label={s(remote ? 'Forget file mappings' : 'Clear index')}><p>{s(remote ? 'Forget this directory’s MyAgent mappings? Shared server documents, source files and conversations are kept.' : 'Clear these records? Source files and conversations are kept.')}</p><button className="set-btn danger" disabled={busy} onClick={() => void action('clear')}>{s('Clear')}</button> <button className="set-btn" disabled={busy} onClick={() => setClear(false)}>{s('Cancel')}</button></div>}
      </details>
    </details>
    {running && <div className="nawa-rag-running"><span role="status">{s('Indexing…')}<br/>{s('Job directory')}: <bdi>{progress.folder}</bdi><br/>{progress.message}<br/>{s('{scanned} files checked · {done} completed · {failed} failed', { scanned: progress.scanned, done: progress.embedded, failed: progress.failed })}</span><button type="button" className="set-btn" disabled={busy} onClick={() => void action('cancel')}>{s('Stop indexing')}</button></div>}
    {!running && progress?.folder === folder && progress.message && <p role="status">{progress.message}</p>}
    {error && <div role="alert" className="nawa-rag-error"><p>{error}</p><button type="button" className="set-btn" onClick={() => { setError(''); setRetry(value => value + 1) }}>{s('Retry')}</button></div>}
  </section>
}
