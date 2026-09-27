import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '../locale'
import { AiModelPane } from '../SettingsModal'
import { RagAnalyticsPanel } from './RagAnalyticsPanel'
import { WORKSPACE_TABS, nextWorkspaceTab, type WorkspaceTab } from './workspace-tabs-model'
import { PanelActivityContext, PanelVisibility, mostImportantActivity, type PanelActivity } from './panel-state'
import { useSidebarText } from './sidebar-i18n'
import './workspace-control-panel.css'

interface Props {
  active: WorkspaceTab
  visible?: boolean
  drawer?: boolean
  onActivity?(activity: PanelActivity | undefined): void
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
    <PanelVisibility.Provider value={active}>{active || visited ? children : null}</PanelVisibility.Provider>
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
  const { s, dir } = useSidebarText()
  const visible = props.visible !== false
  const [expanded, setExpanded] = useState(false)
  const drawer = !!props.drawer || expanded
  const [activities, setActivities] = useState<Record<string, { tab: WorkspaceTab; activity: PanelActivity }>>({})
  const publish = useCallback((tab: WorkspaceTab, source: string, activity: PanelActivity | null) => {
    setActivities(previous => {
      const key = `${tab}:${source}`
      if (!activity) { if (!previous[key]) return previous; const next = { ...previous }; delete next[key]; return next }
      if (previous[key]?.activity.kind === activity.kind && previous[key]?.activity.text === activity.text) return previous
      return { ...previous, [key]: { tab, activity } }
    })
  }, [])
  const overall = mostImportantActivity(Object.values(activities).map(value => value.activity))
  const activityFor = (tab: WorkspaceTab) => mostImportantActivity(Object.values(activities).filter(value => value.tab === tab).map(value => value.activity))
  const onActivity = props.onActivity
  useEffect(() => { onActivity?.(overall) }, [overall, onActivity])
  const pane = useRef<HTMLElement>(null)
  const close = useRef(props.onClose); close.current = props.onClose
  useEffect(() => {
    if (!visible || !drawer) return
    const element = pane.current!
    const previous = document.activeElement as HTMLElement | null
    const surrounding = [...(element.parentElement?.children ?? []), ...(element.parentElement?.parentElement?.children ?? [])]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== element && !node.contains(element) && !node.classList.contains('nawa-panel-backdrop'))
    const inert = surrounding.map(node => [node, node.inert] as const)
    inert.forEach(([node]) => { node.inert = true })
    element.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
        .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    element.addEventListener('keydown', keyboard)
    return () => {
      element.removeEventListener('keydown', keyboard)
      inert.forEach(([node, value]) => { node.inert = value })
      if (previous?.isConnected) previous.focus()
    }
  }, [visible, drawer])
  const prefix = useId()
  const [focused, setFocused] = useState<WorkspaceTab>(props.active)
  const buttons = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement>>>({})
  useEffect(() => { setFocused(props.active) }, [props.active])
  const labels: Record<WorkspaceTab, string> = {
    ai: s('Chat'),
    ragAnalytics: s('Knowledge'),
    provider: s('Models'),
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
  return <PanelActivityContext.Provider value={publish}>
    {visible && drawer && <div className="nawa-panel-backdrop" onClick={props.onClose} aria-hidden="true" />}
    <aside ref={pane} hidden={!visible} dir={dir} className={`ex-inspector nawa-workspace-control-panel nawa-panel-theme${drawer ? ' is-drawer' : ''}${expanded ? ' is-expanded' : ''}`}
      role={drawer ? 'dialog' : undefined} aria-modal={drawer && visible ? true : undefined} aria-label={labels[props.active]}>
    <div className="nawa-workspace-tabs-header">
      <div className="ex-inspector-tabs nawa-workspace-tablist" role="tablist" aria-label={s('Workspace panels')}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(props.active) }}>
        {WORKSPACE_TABS.map(tab => <button key={tab} ref={element => { if (element) buttons.current[tab] = element; else delete buttons.current[tab] }}
          type="button" role="tab" id={tabId(tab)} aria-controls={panelId(tab)} aria-selected={props.active === tab}
          aria-label={labels[tab]} aria-description={activityFor(tab)?.text}
          tabIndex={focused === tab ? 0 : -1} title={labels[tab]} onKeyDown={event => keyboard(event, tab)} onClick={() => choose(tab)}>
          <Symbol tab={tab} /><span>{labels[tab]}</span>
          {activityFor(tab) && <span className="nawa-tab-dot" aria-hidden="true" />}
        </button>)}
      </div>
      <button type="button" className="ex-tool nawa-workspace-expand" aria-label={s(expanded ? 'Dock panel' : 'Expand panel')} title={s(expanded ? 'Dock panel' : 'Expand panel')} onClick={() => setExpanded(value => !value)}>{expanded ? '↙' : '↗'}</button>
      <button className="ex-tool nawa-workspace-close" type="button" aria-label={props.closeLabel} title={props.closeLabel} onClick={props.onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    <div className="nawa-workspace-context">
      <span title={props.folder ?? undefined}>{props.active === 'provider' ? s('Global model settings') : props.folder ? <bdi>{props.folder.split(/[\\/]/).filter(Boolean).at(-1)}</bdi> : s('No directory opened')}</span>
      {props.active === 'provider' && <small>{s('Applies across directories. Choose a model for this conversation in Chat.')}</small>}
    </div>
    {WORKSPACE_TABS.filter(tab => tab !== props.active).map(tab => {
      const activity = activityFor(tab)
      return activity && <button key={tab} type="button" className={`nawa-panel-activity is-${activity.kind}`} title={activity.text} onClick={() => choose(tab)}>{labels[tab]} · {activity.text}</button>
    })}
    <div className="nawa-workspace-body">
      {WORKSPACE_TABS.map(tab => <PreservedPanel key={tab} active={visible && props.active === tab} name={tab}
        id={panelId(tab)} labelledBy={tabId(tab)}>{content[tab]}</PreservedPanel>)}
    </div>
  </aside></PanelActivityContext.Provider>
}
