import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '../locale'
import { AiModelPane } from '../SettingsModal'
import { RagAnalyticsPanel } from './RagAnalyticsPanel'
import { WORKSPACE_TABS, nextWorkspaceTab, type WorkspaceTab } from './workspace-tabs-model'
import './workspace-control-panel.css'

interface Props {
  active: WorkspaceTab
  assistantLabel: string
  closeLabel: string
  folder: string | null
  assistant: ReactNode
  onChange(tab: WorkspaceTab): void
  onClose(): void
  onAddFolder(): void
}

function PreservedPanel({ active, name, id, labelledBy, children }: {
  active: boolean; name: WorkspaceTab; id: string; labelledBy: string; children: ReactNode
}) {
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  return <section className={`nawa-workspace-panel is-${name}`} id={id} role="tabpanel"
    aria-labelledby={labelledBy} hidden={!active} tabIndex={active ? 0 : -1}>
    {active || visited ? children : null}
  </section>
}

function Symbol({ tab }: { tab: WorkspaceTab }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    {tab === 'ai' ? <path d="m8 1.5 1.7 4.8 4.8 1.7-4.8 1.7L8 14.5 6.3 9.7 1.5 8l4.8-1.7Z" />
      : tab === 'ragAnalytics' ? <><circle cx="5.7" cy="5.7" r="3.6" /><path d="m8.4 8.4 2.6 2.6M2 14h12M10.5 12V7M13 12V9" /></>
        : <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M5 6h6M5 9h4" /></>}
  </svg>
}

export function WorkspaceControlPanel(props: Props) {
  const { t } = useI18n()
  const prefix = useId()
  const [focused, setFocused] = useState<WorkspaceTab>(props.active)
  const buttons = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement>>>({})
  useEffect(() => { setFocused(props.active) }, [props.active])
  const labels: Record<WorkspaceTab, string> = {
    ai: props.assistantLabel,
    ragAnalytics: 'RAG & Analytics',
    provider: 'AI Provider',
  }
  const tabId = (tab: WorkspaceTab) => `${prefix}-tab-${tab}`
  const panelId = (tab: WorkspaceTab) => `${prefix}-panel-${tab}`
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, tab: WorkspaceTab) => {
    const next = nextWorkspaceTab(tab, event.key, getComputedStyle(event.currentTarget).direction === 'rtl')
    if (!next) return
    event.preventDefault(); event.stopPropagation()
    setFocused(next); buttons.current[next]?.focus()
  }
  const choose = (tab: WorkspaceTab) => { setFocused(tab); props.onChange(tab) }
  const content: Record<WorkspaceTab, ReactNode> = {
    ai: props.assistant,
    ragAnalytics: <RagAnalyticsPanel folder={props.folder} onAddFolder={props.onAddFolder} />,
    provider: <div className="nawa-provider-panel"><AiModelPane t={t} /></div>,
  }
  return <aside className="ex-inspector nawa-workspace-control-panel" aria-label={labels[props.active]}>
    <div className="nawa-workspace-tabs-header">
      <div className="ex-inspector-tabs nawa-workspace-tablist" role="tablist" aria-label="Workspace panels"
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(props.active) }}>
        {WORKSPACE_TABS.map(tab => <button key={tab} ref={element => { if (element) buttons.current[tab] = element; else delete buttons.current[tab] }}
          type="button" role="tab" id={tabId(tab)} aria-controls={panelId(tab)} aria-selected={props.active === tab}
          tabIndex={focused === tab ? 0 : -1} title={labels[tab]} onKeyDown={event => keyboard(event, tab)} onClick={() => choose(tab)}>
          <Symbol tab={tab} /><span>{labels[tab]}</span>
        </button>)}
      </div>
      <button className="ex-tool nawa-workspace-close" type="button" aria-label={props.closeLabel} title={props.closeLabel} onClick={props.onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    {props.active === 'ragAnalytics' && <div className="nawa-workspace-context"><span title={props.folder ?? undefined}>{props.folder || 'No directory opened'}</span><small>Indexing and table import use the opened workspace directory. Chat access still requires individually selected files.</small></div>}
    {props.active === 'provider' && <div className="nawa-workspace-context"><span>Chat model provider</span><small>These are the same model settings used by the Nawa assistant.</small></div>}
    <div className="nawa-workspace-body">
      {WORKSPACE_TABS.map(tab => <PreservedPanel key={tab} active={props.active === tab} name={tab}
        id={panelId(tab)} labelledBy={tabId(tab)}>{content[tab]}</PreservedPanel>)}
    </div>
  </aside>
}
