import { useEffect, useRef, useState } from 'react'
import { isWithin } from './model'
import { Icon } from './Icons'
import { PanelDialog } from './PanelDialog'
import { usePanelActivity } from './panel-state'
import { useSidebarText } from './sidebar-i18n'

/** A direct selected-file action. Embeddings and exact table preparation run independently. */
export function IndexSelectedButton({ folder, selectedFiles, onOpenSettings }: {
  folder: string | null; selectedFiles: string[]; onOpenSettings(): void
}) {
  const { s } = useSidebarText()
  const [submitting, setSubmitting] = useState(false), [running, setRunning] = useState(false)
  const [errors, setErrors] = useState<string[]>([]), [detailsOpen, setDetailsOpen] = useState(false)
  const working = useRef(false), alive = useRef(true), refresh = useRef<() => void>(() => {})
  useEffect(() => {
    alive.current = true
    let checking = false, again = false
    const read = async () => {
      if (checking) { again = true; return }
      checking = true
      try {
        do {
          again = false
          const results = await Promise.allSettled([window.nawaRag.progress(), window.nawaAnalytics.progress()])
          if (alive.current) setRunning(results.some(result => result.status === 'fulfilled' && result.value.running))
        } while (again && alive.current)
      } finally { checking = false }
    }
    refresh.current = () => { void read() }
    refresh.current()
    const offRag = window.nawaRag.onChanged(refresh.current), offData = window.nawaAnalytics.onChanged(refresh.current)
    return () => { alive.current = false; offRag(); offData() }
  }, [])
  const paths = [...new Set(selectedFiles)]
  const valid = !!folder && paths.length > 0 && paths.length <= 256 && paths.every(path => isWithin(path, folder))
  const busy = submitting || running
  usePanelActivity('ai', 'selected-index', busy ? { kind: 'busy', text: s('Indexing selected files') }
    : errors.length ? { kind: 'error', text: s('Some files could not be prepared. See file status for details.') } : null)
  const index = async () => {
    if (working.current || busy || !valid || !folder) return
    // Selection changes never broaden an in-flight request.
    const requestedFolder = folder, requested = [...paths]
    working.current = true; setSubmitting(true); setErrors([])
    const embed = async () => {
      const { settings } = await window.nawaRag.settings()
      if (!settings.enabled || (settings.backend === 'local' && !settings.model.trim()))
        throw new Error(s('Choose an embedding model in Knowledge settings, then click Index again.'))
      await window.nawaRag.indexSelected(requestedFolder, requested, true)
    }
    try {
      const results = await Promise.allSettled([embed(), window.nawaAnalytics.prepareSelected(requestedFolder, requested)])
      const problems: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') problems.push(`${s(index === 0 ? 'File search' : 'Data analysis')}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        else if (index === 1) {
          const data = result.value as Awaited<ReturnType<typeof window.nawaAnalytics.prepareSelected>>
          if (data.failedFiles || data.blockedTables) problems.push(s('Some tables could not be prepared. Hover over their analysis status in the file table for details.'))
        }
      }
      if (alive.current) { setErrors(problems); setDetailsOpen(problems.length > 0) }
    } finally {
      working.current = false
      if (alive.current) { setSubmitting(false); refresh.current() }
    }
  }
  const hint = busy ? 'Indexing selected files. Progress is shown in the file table.'
    : !paths.length || !folder ? 'Select files in the main panel, then click Index.'
    : paths.length > 256 ? 'Select at most 256 files.'
    : !valid ? 'Select files inside the opened directory.'
    : 'Embed selected files and prepare their tables for data analysis.'
  return <>
    <button type="button" className="nawa-index-selected" aria-label={s('Index selected files')}
      disabled={!valid || busy} aria-busy={busy} title={s(hint)} onClick={() => void index()}>
      <Icon name={busy ? 'refresh' : 'search'} size={14} className={busy ? 'nawa-index-spinner' : ''} />{s('Index')}
    </button>
    {errors.length > 0 && <button type="button" className="ex-tool nawa-index-warning" aria-label={s('Indexing details')}
      title={s('Indexing details')} onClick={() => setDetailsOpen(true)}><Icon name="info" size={16} /></button>}
    <PanelDialog open={detailsOpen} title={s('Indexing details')} onClose={() => setDetailsOpen(false)}>
      {errors.map((error, index) => <p key={index} role="alert">{error}</p>)}
      <button type="button" className="set-btn" onClick={() => { setDetailsOpen(false); onOpenSettings() }}>{s('Knowledge settings')}</button>
    </PanelDialog>
  </>
}
