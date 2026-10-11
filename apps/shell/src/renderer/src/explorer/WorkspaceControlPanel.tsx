import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { AiPanelSideButton } from '@genoffice/ui'
import { useI18n } from '../locale'
import {
  PanelActivityContext,
  PanelVisibility,
  mostImportantActivity,
  type PanelActivity,
} from './panel-state'
import { useSidebarText } from './sidebar-i18n'
import { Icon } from './Icons'
import { ChatHeaderTarget } from './chat-header'
import { IndexSelectedButton, type SelectedFileActions } from './IndexSelectedButton'
import './workspace-control-panel.css'

interface Props {
  visible?: boolean
  drawer?: boolean
  settingsOpen?: boolean
  onActivity?(activity: PanelActivity | undefined): void
  closeLabel: string
  folder: string | null
  selectedFiles?: string[]
  fileActionsRef?: Ref<SelectedFileActions>
  onIndexBusyChange?(busy: boolean): void
  assistant: ReactNode
  onOpenSettings(): void
  onClose(): void
}

export function WorkspaceControlPanel(props: Props) {
  const { s, dir } = useSidebarText()
  const { lang } = useI18n()
  const visible = props.visible !== false
  const [expanded, setExpanded] = useState(false)
  const [newChatTarget, setNewChatTarget] = useState<HTMLDivElement | null>(null)
  const [optionsTarget, setOptionsTarget] = useState<HTMLDivElement | null>(null)
  const headerTarget = useMemo(
    () =>
      newChatTarget && optionsTarget ? { newChat: newChatTarget, options: optionsTarget } : null,
    [newChatTarget, optionsTarget],
  )
  const drawer = !!props.drawer || expanded
  const [activities, setActivities] = useState<Record<string, PanelActivity>>({})
  const publish = useCallback((_tab: unknown, source: string, activity: PanelActivity | null) => {
    setActivities((previous) => {
      if (!activity) {
        if (!previous[source]) return previous
        const next = { ...previous }
        delete next[source]
        return next
      }
      if (previous[source]?.kind === activity.kind && previous[source]?.text === activity.text)
        return previous
      return { ...previous, [source]: activity }
    })
  }, [])
  const overall = mostImportantActivity(Object.values(activities)),
    onActivity = props.onActivity
  useEffect(() => {
    onActivity?.(overall)
  }, [overall, onActivity])
  const pane = useRef<HTMLElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    if (!visible || !drawer || props.settingsOpen) return
    const element = pane.current!
    const previous = document.activeElement as HTMLElement | null
    const surrounding = [
      ...(element.parentElement?.children ?? []),
      ...(element.parentElement?.parentElement?.children ?? []),
    ].filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement &&
        node !== element &&
        !node.contains(element) &&
        !node.classList.contains('nawa-panel-backdrop') &&
        !node.classList.contains('set-overlay'),
    )
    const inert = surrounding.map((node) => [node, node.inert] as const)
    inert.forEach(([node]) => {
      node.inert = true
    })
    if (!document.querySelector('.set-overlay, dialog[open]'))
      element.querySelector<HTMLElement>('.nawa-workspace-settings')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .set-overlay')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0)
      const first = focusable[0],
        last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    element.addEventListener('keydown', keyboard)
    return () => {
      element.removeEventListener('keydown', keyboard)
      inert.forEach(([node, value]) => {
        node.inert = value
      })
      if (previous?.isConnected) previous.focus()
    }
  }, [visible, drawer, props.settingsOpen])
  return (
    <PanelActivityContext.Provider value={publish}>
      {visible && drawer && (
        <div className="nawa-panel-backdrop" onClick={props.onClose} aria-hidden="true" />
      )}
      <aside
        ref={pane}
        hidden={!visible}
        dir={dir}
        className={`ex-inspector nawa-workspace-control-panel nawa-panel-theme${drawer ? ' is-drawer' : ''}${expanded ? ' is-expanded' : ''}`}
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer && visible ? true : undefined}
        aria-label={s('Chat')}
      >
        <div className="nawa-workspace-tabs-header">
          <div className="nawa-workspace-title">
            <strong>{s('Chat')}</strong>
          </div>
          <div ref={setNewChatTarget} className="nawa-workspace-chat-actions" />
          <div className="nawa-workspace-index">
            <PanelVisibility.Provider value={visible}>
              <IndexSelectedButton
                folder={props.folder}
                selectedFiles={props.selectedFiles ?? []}
                onOpenSettings={props.onOpenSettings}
                actionsRef={props.fileActionsRef}
                onBusyChange={props.onIndexBusyChange}
              />
            </PanelVisibility.Provider>
          </div>
          <div ref={setOptionsTarget} className="nawa-workspace-chat-options" />
          <AiPanelSideButton
            lang={lang}
            className="ex-tool"
            onMove={(side) => window.aiOffice.setAiPanelPrefs({ side })}
          />
          <button
            type="button"
            className="ex-tool nawa-workspace-settings"
            aria-label={s('Knowledge settings')}
            title={s('Knowledge settings')}
            onClick={props.onOpenSettings}
          >
            <Icon name="settings" size={16} />
          </button>
          <button
            type="button"
            className="ex-tool nawa-workspace-expand"
            aria-label={s(expanded ? 'Dock panel' : 'Expand panel')}
            title={s(expanded ? 'Dock panel' : 'Expand panel')}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '↙' : '↗'}
          </button>
          <button
            className="ex-tool nawa-workspace-close"
            type="button"
            aria-label={props.closeLabel}
            title={props.closeLabel}
            onClick={props.onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="nawa-workspace-body">
          <section className="nawa-workspace-panel is-ai" aria-label={s('Chat')}>
            <ChatHeaderTarget.Provider value={headerTarget}>
              <PanelVisibility.Provider value={visible}>{props.assistant}</PanelVisibility.Provider>
            </ChatHeaderTarget.Provider>
          </section>
        </div>
      </aside>
    </PanelActivityContext.Provider>
  )
}
