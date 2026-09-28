import { useCallback, useContext, useId, useState } from 'react'
import { RagToolbar } from '../rag/RagToolbar'
import { RagSettings } from '../rag/RagSettings'
import { AnalyticsToolbar } from '../analytics/AnalyticsToolbar'
import { AnalyticsSettings } from '../analytics/AnalyticsSettings'
import { useSidebarText } from './sidebar-i18n'
import { MyAgentSettings, type MyAgentSettingsSection } from '../myagent/MyAgentSettings'
import { PanelActivityContext, type PanelActivity } from './panel-state'
import { MyAgentDocumentTools } from '../myagent/MyAgentDocumentTools'

type View = 'files' | 'tables' | 'setup'
type SetupArea = 'connection' | 'analysis' | 'tools' | MyAgentSettingsSection
const areas: Array<{ value: SetupArea; label: string; help: string }> = [
  { value: 'connection', label: 'Connection and search', help: 'Choose a search backend, save its connection, and set retrieval limits.' },
  { value: 'tools', label: 'Document tools', help: 'Browse the document tools available from the connected MyAgent server.' },
  { value: 'status', label: 'Server status and readiness', help: 'Check MyAgent readiness or start, stop, and restart its server.' },
  { value: 'models', label: 'Models and embeddings', help: 'Configure the models MyAgent uses for indexing and classification. Nawa’s chat model is separate.' },
  { value: 'folders', label: 'Shared folders', help: 'Choose the directories MyAgent can index. This does not select files for the assistant.' },
  { value: 'extraction', label: 'Extraction and indexing', help: 'Set supported formats, OCR paths, visual extraction, and indexing limits.' },
  { value: 'launch', label: 'Server launch', help: 'Choose the installed Windows service or a local MyAgent executable.' },
  { value: 'analysis', label: 'Table settings', help: 'Configure Nawa’s local table imports and analytical limits.' },
]

export function RagAnalyticsPanel({ folder, selectedFiles, onAddFolder }: { folder: string | null; selectedFiles?: string[]; onAddFolder(): void }) {
  const { s } = useSidebarText(), id = useId()
  const [view, setView] = useState<View>('files'), [area, setArea] = useState<SetupArea>('connection')
  const [searchStatus, setSearchStatus] = useState('Loading…')
  const [tableStatus, setTableStatus] = useState('Loading…')
  const [visited, setVisited] = useState({ setup: false, server: false, analysis: false, tools: false })
  const [connectionPending, setConnectionPending] = useState(false)
  const [serverArea, setServerArea] = useState<MyAgentSettingsSection>('status')
  const [activities, setActivities] = useState<Record<string, PanelActivity>>({})
  const publish = useContext(PanelActivityContext)
  const track = useCallback<typeof publish>((tab, source, activity) => {
    publish(tab, source, activity)
    setActivities(previous => {
      if (!activity) { if (!previous[source]) return previous; const next = { ...previous }; delete next[source]; return next }
      if (previous[source]?.kind === activity.kind && previous[source]?.text === activity.text) return previous
      return { ...previous, [source]: activity }
    })
  }, [publish])
  const openSetup = () => { setView('setup'); setArea('connection'); setVisited(previous => ({ ...previous, setup: true })) }
  const navigate = (next: View) => { setView(next); if (next === 'setup') setVisited(previous => ({ ...previous, setup: true })) }
  const changeArea = (next: SetupArea) => { setArea(next); if (next !== 'connection' && next !== 'analysis' && next !== 'tools') setServerArea(next); setVisited(previous => ({ ...previous, server: previous.server || !['connection', 'analysis', 'tools'].includes(next), analysis: previous.analysis || next === 'analysis', tools: previous.tools || next === 'tools' })) }
  const labels: Record<View, string> = { files: 'Files', tables: 'Tables', setup: 'Setup' }
  const currentArea = areas.find(item => item.value === area)!
  const destination = (source: string): { view: View; area?: SetupArea } => source === 'search-settings' ? { view: 'setup', area: 'connection' } : source === 'myagent-settings' ? { view: 'setup', area: serverArea } : source === 'analysis-settings' ? { view: 'setup', area: 'analysis' } : ['tables', 'review'].includes(source) ? { view: 'tables' } : { view: 'files' }
  return <PanelActivityContext.Provider value={track}><div className="nawa-rag-analytics-panel">
    <nav className="nawa-knowledge-nav" aria-label={s('Knowledge navigation')}>{(['files', 'tables', 'setup'] as const).map(item => <button type="button" key={item} aria-current={view === item ? 'page' : undefined} aria-controls={`${id}-${item}`} onClick={() => navigate(item)}>{s(labels[item])}</button>)}</nav>
    {Object.entries(activities).map(([source, activity]) => {
      const target = destination(source)
      return target.view !== view || target.area && target.area !== area ? <button key={source} type="button" className={`nawa-knowledge-notice is-${activity.kind}`} onClick={() => { navigate(target.view); if (target.area) changeArea(target.area) }}>{s(labels[target.view])} · {activity.text}</button> : null
    })}
    {!folder && <div className="nawa-panel-state"><p>{s('Open a directory to get started.')}</p><button type="button" className="set-btn" onClick={onAddFolder}>{s('Add / open folder')}</button></div>}
    <section id={`${id}-files`} hidden={view !== 'files'} className="nawa-knowledge-view" aria-label={s('File search actions')}>
      <div className="nawa-knowledge-heading"><h3>{s('File search')}</h3><span className="nawa-capability-status">{folder ? s(searchStatus) : s('No directory opened')}</span></div>
      <p className="nawa-knowledge-help">{s('Only selected files can be read by the assistant.')}</p>
      <RagToolbar folder={folder} selectedFiles={selectedFiles} inSidebar onStatus={setSearchStatus} onSetup={openSetup}/>
    </section>
    <section id={`${id}-tables`} hidden={view !== 'tables'} className="nawa-knowledge-view" aria-label={s('Table analysis actions')}>
      <div className="nawa-knowledge-heading"><h3>{s('Table analysis')}</h3><span className="nawa-capability-status">{folder ? s(tableStatus) : s('No directory opened')}</span></div>
      <AnalyticsToolbar folder={folder} inSidebar onStatus={setTableStatus}/>
      <button type="button" className="set-btn" onClick={() => { navigate('setup'); changeArea('analysis') }}>{s('Table settings')}</button>
    </section>
    <section id={`${id}-setup`} hidden={view !== 'setup'} className="nawa-knowledge-view" aria-label={s('Knowledge setup')}>
      <label className="nawa-rag-field"><span>{s('Settings area')}</span><select className="set-input" aria-label={s('Settings area')} value={area} onChange={event => changeArea(event.target.value as SetupArea)}>{areas.map(item => <option key={item.value} value={item.value}>{s(item.label)}</option>)}</select></label>
      <div hidden={area !== 'connection'}>{visited.setup && <RagSettings onDirtyChanged={setConnectionPending} suspended={activities['myagent-settings']?.kind === 'busy'} allowKeyGeneration selectedFiles={selectedFiles} compact/>}</div>
      <div hidden={['connection', 'analysis', 'tools'].includes(area)}>{visited.server && <MyAgentSettings activityTab="ragAnalytics" section={serverArea} connectionPending={connectionPending}/>}</div>
      <div hidden={area !== 'tools'}>{visited.tools && <MyAgentDocumentTools active={view === 'setup' && area === 'tools'} disabled={connectionPending || activities['myagent-settings']?.kind === 'busy'} selectedFiles={selectedFiles}/>}</div>
      <div hidden={area !== 'analysis'}>{visited.analysis && <AnalyticsSettings compact/>}</div>
      {area !== 'tools' && <details className="nawa-knowledge-help"><summary>{s('Help')}</summary><p>{s(currentArea.help)}</p></details>}
      <button type="button" className="set-btn nawa-knowledge-back" onClick={() => navigate('files')}>{s('Back to files')}</button>
    </section>
  </div></PanelActivityContext.Provider>
}
