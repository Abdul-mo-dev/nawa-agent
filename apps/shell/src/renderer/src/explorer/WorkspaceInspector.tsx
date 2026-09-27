import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { INSPECTOR_TABS, nextInspectorTab, type InspectorTab } from './inspector-tabs-model'
import './workspace-inspector.css'

interface Props {
  active: InspectorTab
  assistantLabel: string
  detailsLabel: string
  closeLabel: string
  folder: string | null
  assistant: ReactNode
  details: ReactNode
  rag: ReactNode
  analytics: ReactNode
  onChange(tab: InspectorTab): void
  onClose(): void
  onAddFolder(): void
}

/** Lazy first mount; subsequently hide rather than destroy a tab's state/effects. */
export function PreservedInspectorPanel({ active, name, id, labelledBy, children }: {
  active: boolean; name: InspectorTab; id: string; labelledBy: string; children: ReactNode
}) {
  const [visited, setVisited] = useState(active)
  // Updating this component's own state during render prevents a very fast tab switch
  // from dropping a just-opened panel before a passive effect has remembered it.
  if (active && !visited) setVisited(true)
  return <section className={`nawa-inspector-panel is-${name}`} id={id} role="tabpanel"
    aria-labelledby={labelledBy} hidden={!active} tabIndex={active ? 0 : -1}>
    {active || visited ? children : null}
  </section>
}

function TabSymbol({ tab }: { tab: InspectorTab }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    {tab === 'ai' ? <path d="m8 1.5 1.7 4.8 4.8 1.7-4.8 1.7L8 14.5 6.3 9.7 1.5 8l4.8-1.7Z" />
      : tab === 'details' ? <><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.5v.5" /></>
        : tab === 'rag' ? <><circle cx="6.8" cy="6.8" r="4.6" /><path d="m10.2 10.2 3.8 3.8M4.5 5.5h4.6M4.5 8h3" /></>
          : <><path d="M2 2v12h12M5 11V8M8 11V4M11 11V6" /></>}
  </svg>
}

export function WorkspaceInspector(props: Props) {
  const prefix = useId()
  const [focused, setFocused] = useState<InspectorTab>(props.active)
  const buttons = useRef<Partial<Record<InspectorTab, HTMLButtonElement>>>({})
  useEffect(() => { setFocused(props.active) }, [props.active])
  const labels: Record<InspectorTab, string> = {
    ai: props.assistantLabel, details: props.detailsLabel,
    rag: 'Directory RAG', analytics: 'Structured Data Analysis',
  }
  const tabId = (tab: InspectorTab) => `${prefix}-tab-${tab}`
  const panelId = (tab: InspectorTab) => `${prefix}-panel-${tab}`
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, tab: InspectorTab) => {
    const next = nextInspectorTab(tab, event.key, getComputedStyle(event.currentTarget).direction === 'rtl')
    if (!next) return
    event.preventDefault(); event.stopPropagation()
    setFocused(next); buttons.current[next]?.focus()
  }
  const choose = (tab: InspectorTab) => { setFocused(tab); props.onChange(tab) }
  const folderHint = (kind: 'rag' | 'analytics') => <div className="nawa-inspector-empty">
    <TabSymbol tab={kind} /><h2>{labels[kind]}</h2>
    <p>Open a directory from the workspace sidebar to {kind === 'rag' ? 'index its files' : 'import and review its table data'}.</p>
    <p>Home, Recent and Starred are file listings, not an opened directory.</p>
    <button type="button" className="ex-secondary" onClick={props.onAddFolder}>Add / open folder</button>
  </div>
  const content: Record<InspectorTab, ReactNode> = {
    ai: props.assistant, details: props.details,
    rag: props.folder ? props.rag : folderHint('rag'),
    analytics: props.folder ? props.analytics : folderHint('analytics'),
  }
  return <aside className="ex-inspector nawa-workspace-inspector" aria-label={labels[props.active]}>
    <div className="nawa-inspector-header">
      <div className="ex-inspector-tabs nawa-inspector-tablist" role="tablist" aria-label="Workspace panels"
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(props.active) }}>
        {INSPECTOR_TABS.map(tab => <button key={tab} ref={element => { if (element) buttons.current[tab] = element; else delete buttons.current[tab] }}
          type="button" role="tab" id={tabId(tab)} aria-controls={panelId(tab)} aria-selected={props.active === tab}
          tabIndex={focused === tab ? 0 : -1} title={labels[tab]} onKeyDown={event => keyboard(event, tab)} onClick={() => choose(tab)}>
          <TabSymbol tab={tab} /><span>{labels[tab]}</span>
        </button>)}
      </div>
      <button className="ex-tool nawa-inspector-close" type="button" aria-label={props.closeLabel} title={props.closeLabel} onClick={props.onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    {props.active !== 'ai' && <div className="nawa-inspector-context">
      <span title={props.folder ?? undefined}>{props.folder || 'No directory opened'}</span>
      <small>Tab changes do not stop the assistant. Return to {props.assistantLabel} for chat or approvals.</small>
    </div>}
    <div className="nawa-inspector-body">
      {INSPECTOR_TABS.map(tab => <PreservedInspectorPanel key={tab} active={props.active === tab} name={tab}
        id={panelId(tab)} labelledBy={tabId(tab)}>{content[tab]}</PreservedInspectorPanel>)}
    </div>
  </aside>
}
