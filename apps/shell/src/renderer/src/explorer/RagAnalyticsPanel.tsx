import { useState } from 'react'
import { RagToolbar } from '../rag/RagToolbar'
import { RagSettings } from '../rag/RagSettings'
import { AnalyticsToolbar } from '../analytics/AnalyticsToolbar'
import { AnalyticsSettings } from '../analytics/AnalyticsSettings'
import { useSidebarText } from './sidebar-i18n'

export function RagAnalyticsPanel({ folder, onAddFolder }: { folder: string | null; onAddFolder(): void }) {
  const { s } = useSidebarText()
  const [expanded, setExpanded] = useState<'search' | 'tables' | null>(null)
  const [searchStatus, setSearchStatus] = useState('Loading…')
  const [tableStatus, setTableStatus] = useState('Loading…')
  return <div className="nawa-rag-analytics-panel">
    {!folder && <div className="nawa-panel-state"><p>{s('Open a directory to get started.')}</p><button type="button" className="set-btn" onClick={onAddFolder}>{s('Add / open folder')}</button></div>}
    <p>{s('Only selected files can be read by the assistant.')}</p>
    <details className="nawa-knowledge-card" open={expanded === 'search'}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => value === 'search' ? null : 'search') }}>
        {s('File search')}<span className="nawa-capability-status">{folder ? s(searchStatus) : s('No directory opened')}</span>
      </summary>
      <p>{s('Search document contents')}</p>
      <RagToolbar folder={folder} inSidebar onStatus={setSearchStatus} />
      <details className="nawa-inline-settings"><summary>{s('Search settings')}</summary><RagSettings /></details>
    </details>
    <details className="nawa-knowledge-card" open={expanded === 'tables'}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => value === 'tables' ? null : 'tables') }}>
        {s('Table analysis')}<span className="nawa-capability-status">{folder ? s(tableStatus) : s('No directory opened')}</span>
      </summary>
      <p>{s('Analyze reviewed tables')}</p>
      <AnalyticsToolbar folder={folder} inSidebar onStatus={setTableStatus} />
      <details className="nawa-inline-settings"><summary>{s('Analysis settings')}</summary><AnalyticsSettings /></details>
    </details>
  </div>
}
