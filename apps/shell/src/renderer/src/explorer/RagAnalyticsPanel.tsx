import { useId, useRef, type RefObject } from 'react'
import { RagToolbar } from '../rag/RagToolbar'
import { RagSettings } from '../rag/RagSettings'
import { AnalyticsToolbar } from '../analytics/AnalyticsToolbar'
import { AnalyticsSettings } from '../analytics/AnalyticsSettings'

/** Own navigation here: toolbar versions share folder/inSidebar, not settings callbacks. */
export function RagAnalyticsPanel({ folder, onAddFolder }: { folder: string | null; onAddFolder(): void }) {
  const id = useId()
  const ragSettings = useRef<HTMLDetailsElement>(null)
  const analyticsSettings = useRef<HTMLDetailsElement>(null)
  const ragSettingsId = `${id}-rag-settings`
  const analyticsSettingsId = `${id}-analytics-settings`

  const show = (ref: RefObject<HTMLDetailsElement | null>) => {
    const details = ref.current
    if (!details) return
    details.open = true
    requestAnimationFrame(() => {
      if (!details.isConnected) return
      details.querySelector('summary')?.focus({ preventScroll: true })
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  return <div className="nawa-rag-analytics-panel">
    {!folder && <div className="nawa-workspace-context">
      <p>Open a workspace directory to index files or import table data. Settings can be edited below even when no directory is open.</p>
      <button type="button" className="set-btn" onClick={onAddFolder}>Add / open folder</button>
    </div>}

    <section className="nawa-combined-section" aria-labelledby={`${id}-rag-title`}>
      <h2 id={`${id}-rag-title`}>Directory RAG</h2>
      <div className="nawa-rag-actions">
        <button type="button" className="set-btn" aria-controls={ragSettingsId}
          onClick={() => show(ragSettings)}>Embedding settings</button>
      </div>
      {folder && <RagToolbar folder={folder} inSidebar />}
      <details id={ragSettingsId} ref={ragSettings} className="nawa-inline-settings">
        <summary>Embedding &amp; RAG settings</summary>
        <RagSettings />
      </details>
    </section>

    <section className="nawa-combined-section" aria-labelledby={`${id}-analytics-title`}>
      <h2 id={`${id}-analytics-title`}>Structured Data Analysis</h2>
      <div className="nawa-data-actions">
        <button type="button" className="set-btn" aria-controls={analyticsSettingsId}
          onClick={() => show(analyticsSettings)}>Analysis settings</button>
      </div>
      {folder && <AnalyticsToolbar folder={folder} inSidebar />}
      <details id={analyticsSettingsId} ref={analyticsSettings} className="nawa-inline-settings">
        <summary>Analysis settings</summary>
        <AnalyticsSettings />
      </details>
    </section>
  </div>
}
