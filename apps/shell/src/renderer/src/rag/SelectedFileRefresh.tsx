import { useEffect, useMemo, useRef, useState } from 'react'
import type { RagFileStatus, RagProgress } from '../../../shared/rag-api'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { basename, isWithin } from '../explorer/model'
import { usePanelActivity } from '../explorer/panel-state'

export function SelectedFileRefresh({ folder, selectedFiles, configured, progress, onProgress }: {
  folder: string; selectedFiles: string[]; configured: boolean; progress: RagProgress | null; onProgress(value: RagProgress): void
}) {
  const { s } = useSidebarText()
  const scopeKey = JSON.stringify([...new Set(selectedFiles)].filter(path => isWithin(path, folder)).sort())
  const paths = useMemo<string[]>(() => JSON.parse(scopeKey), [scopeKey])
  const consentScope = folder + '\0' + scopeKey
  const [files, setFiles] = useState<RagFileStatus[]>([]), [consentedScope, setConsent] = useState('')
  const consent = consentedScope === consentScope
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sequence = useRef(0), alive = useRef(true), working = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++ } }, [])
  useEffect(() => { sequence.current++; setFiles([]); setConsent(''); setError('') }, [folder, scopeKey])
  useEffect(() => {
    const invalidate = () => { sequence.current++; setFiles([]); setConsent(''); setError('') }
    window.addEventListener('nawa:rag-settings-changed', invalidate)
    return () => window.removeEventListener('nawa:rag-settings-changed', invalidate)
  }, [])
  const running = progress?.running === true
  const job = progress?.scope === 'selected' && progress.folder === folder ? progress : null
  const failed = paths.filter(path => files.some(file => file.path === path && file.status === 'failed') || job?.files?.some(file => file.path === path && file.status === 'failed'))
  const tooMany = paths.length > 256
  const perform = async (kind: 'check' | 'refresh' | 'retry') => {
    if (working.current || running || !paths.length || tooMany) return
    const requested = kind === 'retry' ? [...failed] : [...paths], current = sequence.current
    if (!requested.length) return
    working.current = true; setBusy(true); setError('')
    try {
      if (kind === 'check') {
        const result = await window.nawaRag.statuses(requested, true)
        if (alive.current && current === sequence.current) setFiles(result)
      } else {
        const value = await window.nawaRag.indexSelected(folder, requested, consent)
        if (alive.current) onProgress(value)
        if (alive.current && current === sequence.current) setFiles([])
      }
    } catch (cause) { if (alive.current && current === sequence.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  usePanelActivity('ragAnalytics', 'selected-refresh', busy ? { kind: 'busy', text: s('Checking selected files…') } : error ? { kind: 'error', text: error } : null)
  const label = (file: RagFileStatus) => s(file.verified ? 'Ready — snapshot verified' : file.error ? 'Needs attention' : file.status === 'not-indexed' ? 'Needs indexing' : file.status === 'embedded' ? 'Indexed — not verified' : file.status === 'stale' ? 'Needs refresh' : 'Indexing failed')
  return <section className="nawa-selected-refresh" aria-label={s('Selected-file readiness')}>
    <h4>{s('Selected files')}</h4>
    <p>{s('{count} individual files selected', { count: paths.length })}</p>
    {!paths.length && <p>{s('Select individual files in Explorer to check or refresh them. Selected folders are not expanded.')}</p>}
    {tooMany && <p role="alert">{s('Select at most 256 files for one refresh.')}</p>}
    <div className="nawa-rag-actions"><button type="button" className="set-btn" disabled={busy || running || !paths.length || tooMany} onClick={() => void perform('check')}>{s('Check selected files')}</button></div>
    {files.length > 0 && <ul className="nawa-rag-file-results">{files.map(file => <li key={file.path}><strong title={file.path}><bdi>{basename(file.path)}</bdi></strong><span>{label(file)}</span>{file.error && <p>{file.error}</p>}</li>)}</ul>}
    {paths.length > 0 && <>
      <label className="nawa-rag-check"><input type="checkbox" checked={consent} disabled={busy || running} onChange={e => setConsent(e.target.checked ? consentScope : '')}/>{s('I allow MyAgent to read these selected files and refresh their shared index using its configured processing services.')}</label>
      <div className="nawa-rag-actions"><button type="button" className="set-btn primary" disabled={busy || running || !configured || !consent || tooMany} onClick={() => void perform('refresh')}>{s('Refresh selected files')}</button><button type="button" className="set-btn" disabled={busy || running || !configured || !consent || !failed.length || tooMany} onClick={() => void perform('retry')}>{s('Retry failed files')}</button></div>
      <details><summary>{s('Refresh details')}</summary><p>{s('Only the files chosen when this action starts are refreshed. Selection changes affect the next action. Refresh also reapplies extraction settings to unchanged files.')}</p></details>
    </>}
    {job?.files?.length ? <details open={running || job.failed > 0}><summary>{s('Latest selected-file refresh')}</summary><ul className="nawa-rag-file-results">{job.files.map(file => <li key={file.path}><strong title={file.path}><bdi>{basename(file.path)}</bdi></strong><span>{s(file.status === 'embedded' ? 'Refreshed' : file.status === 'failed' ? 'Failed' : file.status === 'canceled' ? 'Canceled' : file.status === 'pending' ? 'Waiting' : file.status === 'checking' ? 'Checking…' : 'Indexing…')}</span>{file.error && <p>{file.error}</p>}</li>)}</ul></details> : null}
    {error && <p className="nawa-rag-error" role="alert">{error}</p>}
  </section>
}
