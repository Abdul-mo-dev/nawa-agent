import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RagFileStatus, RagProgress, RagSettings } from '../../../shared/rag-api'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { isWithin } from '../explorer/model'
import { usePanelActivity } from '../explorer/panel-state'

/** Optional indexing controls. File readiness and per-file progress live in the main file table. */
export function SelectedFileRefresh({ folder, selectedFiles, backend, configured, progress, onProgress }: {
  folder: string; selectedFiles: string[]; backend: RagSettings['backend']; configured: boolean
  progress: RagProgress | null; onProgress(value: RagProgress): void
}) {
  const { s } = useSidebarText()
  const scopeKey = JSON.stringify([...new Set(selectedFiles)].filter(path => isWithin(path, folder)).sort())
  const paths = useMemo<string[]>(() => JSON.parse(scopeKey), [scopeKey])
  const consentScope = backend + '\\0' + folder + '\\0' + scopeKey
  const tooMany = paths.length > 256
  const [files, setFiles] = useState<RagFileStatus[]>([])
  const [consentedScope, setConsent] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const consent = backend === 'native' || consentedScope === consentScope
  const sequence = useRef(0), alive = useRef(true), working = useRef(false)
  const running = progress?.running === true
  const job = progress?.scope === 'selected' && progress.folder === folder ? progress : null
  const failed = paths.filter(path => files.some(file => file.path === path && file.status === 'failed')
    || job?.files?.some(file => file.path === path && file.status === 'failed'))

  const refresh = useCallback(async () => {
    if (!paths.length || tooMany || !configured) return
    const current = ++sequence.current
    try {
      const values = await window.nawaRag.statuses(paths, false)
      if (alive.current && current === sequence.current) setFiles(values)
    } catch { /* The file table shows availability errors; retry remains optional here. */ }
  }, [paths, tooMany, configured])
  useEffect(() => {
    alive.current = true
    setFiles([]); setConsent(''); setError('')
    void refresh()
    const changed = () => { void refresh() }
    const settingsChanged = () => { setConsent(''); changed() }
    const off = window.nawaRag.onChanged(changed)
    window.addEventListener('nawa:rag-settings-changed', settingsChanged)
    return () => {
      alive.current = false; sequence.current++
      off(); window.removeEventListener('nawa:rag-settings-changed', settingsChanged)
    }
  }, [folder, backend, refresh])

  const perform = async (retry: boolean) => {
    if (working.current || running || !paths.length || tooMany || !configured || !consent) return
    const requested = retry ? [...failed] : [...paths], current = sequence.current
    if (!requested.length) return
    working.current = true; setBusy(true); setError('')
    try {
      const value = await window.nawaRag.indexSelected(folder, requested, consent)
      if (alive.current) onProgress(value)
    } catch (cause) {
      if (alive.current && current === sequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { working.current = false; if (alive.current) setBusy(false) }
  }
  usePanelActivity('ragAnalytics', 'selected-refresh', error ? { kind: 'error', text: error } : null)

  return <section className="nawa-selected-refresh" aria-label={s('Selected-file indexing')}>
    {!paths.length && <p>{s('Select files in the main panel.')}</p>}
    {tooMany && <p role="alert">{s('Select at most 256 files.')}</p>}
    {configured && paths.length > 0 && !tooMany && <>
      {backend !== 'native' && <label className="nawa-rag-check">
        <input type="checkbox" checked={consent} disabled={busy || running}
          onChange={event => setConsent(event.target.checked ? consentScope : '')} />
        {s(backend === 'myagent'
          ? 'Allow the configured MyAgent service to read and index these files.'
          : 'Allow sending file text to the configured embedding endpoint for indexing.')}
      </label>}
      <div className="nawa-rag-actions">
        <button type="button" className="set-btn primary" disabled={busy || running || !consent}
          onClick={() => void perform(false)}>{s('Refresh selected files')}</button>
        <button type="button" className="set-btn" disabled={busy || running || !consent || !failed.length}
          onClick={() => void perform(true)}>{s('Retry failed files')}</button>
      </div>
    </>}
    {error && <p className="nawa-rag-error" role="alert">{error}</p>}
  </section>
}
