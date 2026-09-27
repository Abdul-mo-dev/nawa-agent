import { WorkflowController } from './directory-actions/workflow-controller'

import { WorkflowCard } from './directory-actions/WorkflowCard'
import { directoryInspectionSkill } from './directory-actions/inspection-skill'
import { analyticsSkill } from './analytics/skill'
import { prepareMyAgentKnowledgeSkill } from './rag/myagent-skill'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AgentLoop, DEFAULT_MAX_TURNS, composeSkills, type AgentMessage } from '@genoffice/agent-core'
import { applyChatModel, chatModelLabel } from '@genoffice/ai-provider/browser'
import { Markdown, ChatModelPicker } from '@genoffice/ui'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/chat-model-picker.css'
import type { ConversationRecord, HistoryComparison, HistoryMessage } from '../../shared/conversation-api'
import { createDirectorySkill } from './ai/directory-skill'
import { displayPath, selectionKey, selectionSnapshot } from './ai/directory-selection'
import { createShellTransport } from './ai/transport'
import { DocumentIcon, FolderGlyph, NawaIcon } from './explorer/Icons'
import { ConversationBuffer, flushDetachedBuffers, initializeHistory, retainUntilSaved } from './history/conversation-buffer'
import { HistoryPanel } from './history/HistoryPanel'
import { HistoryDropdown } from './history/HistoryDropdown'
import { ApprovalCard } from './directory-actions/ApprovalCard'
import { ApprovalController, DirectoryActionClient, directoryMutationSkill } from './directory-actions/controller'
import { ChangeNotice } from './history/ChangeNotice'
import { PanelDialog } from './explorer/PanelDialog'
import { usePanelActivity } from './explorer/panel-state'
import { useSidebarText } from './explorer/sidebar-i18n'
import './workspace-selection.css'
import './history/history.css'

interface WorkspaceChatProps {
  folder: string | null
  folderName: string
  scopePaths: string[]
  scopeDirs?: string[]
  onOpenFile: (path: string) => void
  onClose: () => void
}
interface SessionControls {
  leave: () => Promise<void>
  model: () => string
}
const emptyControls: SessionControls = { leave: async () => {}, model: () => '' }
const messageText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function WorkspaceChat(props: WorkspaceChatProps) {
  return <HistoryWorkspace key={props.folder ?? 'nawa-main-selection'} {...props} />
}

function HistoryWorkspace(props: WorkspaceChatProps) {
  const { s } = useSidebarText()
  const [session, setSession] = useState<ConversationRecord | null>(null)
  const [mountVersion, setMountVersion] = useState(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [databasePath, setDatabasePath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [transitioning, setTransitioning] = useState(false)
  const [retry, setRetry] = useState(0)
  const controls = useRef<SessionControls>(emptyControls)
  const transitionLock = useRef(false)
  const alive = useRef(true)
  const folderKey = props.folder ?? 'nawa-main-selection'
  const remember = (record: ConversationRecord) => {
    try { localStorage.setItem(`nawa.history-active:${record.folder ?? 'nawa-main-selection'}`, record.id) } catch { /* UI preference only. */ }
  }
  const activate = (record: ConversationRecord) => {
    if (!alive.current) return
    setSession(record); setMountVersion(value => value + 1); remember(record)
    setHistoryVersion(value => value + 1)
  }
  useEffect(() => {
    alive.current = true
    let live = true
    setLoading(true); setError(null)
    void (async () => {
      await flushDetachedBuffers()
      const info = await initializeHistory()
      if (!live) return
      setDatabasePath(info.databasePath)
      const list = await window.nawaHistory.list({ folder: props.folder })
      let id: string | null = null
      try { id = localStorage.getItem(`nawa.history-active:${folderKey}`) } catch { /* Optional preference. */ }
      let record: ConversationRecord | null = null
      if (id) {
        try { record = await window.nawaHistory.get(id) } catch { /* Deleted/missing preference; use latest. */ }
      }
      if (!record) record = list.conversations[0]
        ? await window.nawaHistory.get(list.conversations[0].id)
        : await window.nawaHistory.create({ folder: props.folder, folderName: props.folderName })
      if (live) activate(record)
    })().catch(cause => { if (live) setError(messageText(cause)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; alive.current = false }
    // The wrapper is keyed by folder; changing retry only repeats initialization after an error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry])

  const transition = async (work: () => Promise<void>) => {
    if (transitionLock.current) return
    transitionLock.current = true; setTransitioning(true); setError(null)
    try { await controls.current.leave(); await work() }
    catch (cause) { if (alive.current) setError(messageText(cause)); throw cause }
    finally { transitionLock.current = false; if (alive.current) setTransitioning(false) }
  }
  const newChat = () => transition(async () => {
    const modelId = controls.current.model()
    const record = await window.nawaHistory.create({ folder: props.folder, folderName: props.folderName, modelId })
    activate(record); if (alive.current) setHistoryOpen(false)
  })
  const openChat = (id: string) => transition(async () => {
    activate(await window.nawaHistory.get(id)); if (alive.current) setHistoryOpen(false)
  })
  const renameChat = (id: string, title: string) => transition(async () => {
    await window.nawaHistory.rename(id, title)
    if (session?.id === id) activate(await window.nawaHistory.get(id))
    if (alive.current) setHistoryVersion(value => value + 1)
  })
  const deleteChat = (id: string) => transition(async () => {
    await window.nawaHistory.delete(id)
    if (session?.id === id) {
      const list = await window.nawaHistory.list({ folder: props.folder })
      activate(list.conversations[0] ? await window.nawaHistory.get(list.conversations[0].id)
        : await window.nawaHistory.create({ folder: props.folder, folderName: props.folderName, modelId: controls.current.model() }))
    }
    if (alive.current) setHistoryVersion(value => value + 1)
  })
  if (!session) return <section className="ws-chat workspace-chat-main" aria-label={s("Nawa conversation history")}>
    <header className="ws-chat-head"><NawaIcon size={27} /><h2>{s("Nawa assistant")}</h2></header>
    <div className="ws-chat-notice" role={error ? 'alert' : 'status'}>{error || (loading ? 'Opening conversation history…' : 'No conversation loaded.')}</div>
    {error && <button type="button" className="ws-chat-close" onClick={() => setRetry(value => value + 1)}>{s("Retry opening history")}</button>}
    <button type="button" className="ws-chat-close" onClick={props.onClose}>{s("Hide chat")}</button>
  </section>
  return <DirectoryChat key={`${session.id}:${mountVersion}`} {...props} session={session}
    controls={controls} transitioning={transitioning} parentError={error}
    onNew={() => { void newChat().catch(() => undefined) }} onHide={props.onClose}
    historyOpen={historyOpen} toggleHistory={() => setHistoryOpen(value => !value)}
    onSaved={() => { if (alive.current) setHistoryVersion(value => value + 1) }}
    historyDropdown={<HistoryDropdown folder={props.folder} currentId={session.id} title={session.title} version={historyVersion} disabled={transitioning} onOpen={openChat} />}
    historyPanel={<PanelDialog open={historyOpen} title={s('Manage history')} onClose={() => setHistoryOpen(false)}>{historyOpen && <HistoryPanel folder={props.folder} currentId={session.id} version={historyVersion}
      databasePath={databasePath} onOpen={openChat} onRename={renameChat} onDelete={deleteChat} onClose={() => setHistoryOpen(false)} />}</PanelDialog>} />
}

type DirectoryChatProps = WorkspaceChatProps & {
  session: ConversationRecord
  controls: { current: SessionControls }
  transitioning: boolean
  parentError: string | null
  onNew: () => void
  onHide: () => void
  historyOpen: boolean
  toggleHistory: () => void
  onSaved: () => void
  historyPanel: ReactNode
  historyDropdown: ReactNode
}

function DirectoryChat({ folder, folderName, scopePaths, scopeDirs = [], onOpenFile, session, controls,
  transitioning, parentError, onNew, onHide, historyOpen, toggleHistory, onSaved, historyPanel, historyDropdown }: DirectoryChatProps) {
  const { s } = useSidebarText()
  const [reviewOpen, setReviewOpen] = useState(false)
  const followTail = useRef(true)
  const buffer = useMemo(() => new ConversationBuffer(session, window.nawaHistory), [session])
  const data = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot)
  const messages = data.messages, input = data.draft, modelId = data.modelId
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activity, setActivity] = useState<string[]>([])
  const [comparison, setComparison] = useState<HistoryComparison | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [visibleMessages, setVisibleMessages] = useState(100)
  const selection = useMemo(() => selectionSnapshot(folder, scopePaths, scopeDirs), [folder, scopePaths, scopeDirs])
  const scopeKey = selectionKey(selection)
  const scopeRef = useRef(scopeKey), modelRef = useRef(modelId)
  scopeRef.current = scopeKey; modelRef.current = modelId
  const logRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null)
  const loopRef = useRef<AgentLoop | null>(null)
  const approvals = useMemo(() => new ApprovalController(), [])
  const workflow = useMemo(() => new WorkflowController(), [])
  const approvalState = useSyncExternalStore(approvals.subscribe, approvals.getSnapshot, approvals.getSnapshot)
  const workflowState = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot)
  const needsReview = !!approvalState || !!workflowState?.interaction
  usePanelActivity('ai', 'conversation', buffer.error ? { kind: 'error', text: s('Save needs attention') } : needsReview ? { kind: 'attention', text: s('Approval needed') } : busy ? { kind: 'busy', text: s('Response in progress') } : null)
  const actionClient = useRef<DirectoryActionClient | null>(null)
  const active = useRef<number | null>(null), epoch = useRef(0), alive = useRef(true)
  const activeScan = useRef<string | null>(null), comparisonScan = useRef<string | null>(null)
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved
  const loadSettings = useCallback(() => window.aiOffice.getAiSettings(), [])
  const updateMessages = useCallback((change: (messages: HistoryMessage[]) => HistoryMessage[]) => {
    buffer.edit(record => ({ ...record, messages: change(record.messages) }))
  }, [buffer])
  const cancelComparison = useCallback(() => {
    const id = comparisonScan.current; comparisonScan.current = null
    if (id) void window.nawaHistory.cancelScan(id).catch(() => undefined)
  }, [])
  const invalidateRun = useCallback(() => {
    epoch.current++; active.current = null
    actionClient.current?.cancel(); actionClient.current = null
    approvals.cancel()
    const scan = activeScan.current; activeScan.current = null
    if (scan) void window.nawaHistory.cancelScan(scan).catch(() => undefined)
    const loop = loopRef.current; loopRef.current = null
    try { if (loop?.busy) loop.reset() } catch (cause) { console.warn('Nawa: cleanup failed.', cause) }
  }, [approvals])
  const sealPartial = useCallback(() => {
    const current = buffer.getSnapshot().messages
    if (current.some(message => message.streaming)) updateMessages(previous => previous.map(message => message.streaming
      ? { ...message, streaming: false, error: true, text: message.text || 'Stopped before a response was completed.' } : message))
  }, [buffer, updateMessages])
  const stop = useCallback((reason = 'Stopped. The partial response is saved in this conversation.') => {
    invalidateRun(); sealPartial()
    if (alive.current) { setBusy(false); setActivity([]); setNotice(reason) }
    void buffer.flush().catch(cause => { if (alive.current) setNotice(messageText(cause)) })
  }, [buffer, invalidateRun, sealPartial])
  const checkChanges = useCallback(async () => {
    cancelComparison()
    const scanId = crypto.randomUUID(); comparisonScan.current = scanId
    setChecking(true); setCheckError(null)
    try {
      const result = await window.nawaHistory.compare({ id: session.id, scanId })
      if (alive.current && comparisonScan.current === scanId) setComparison(result)
    } catch (cause) { if (alive.current && comparisonScan.current === scanId) setCheckError(messageText(cause)) }
    finally {
      if (alive.current && comparisonScan.current === scanId) { comparisonScan.current = null; setChecking(false) }
    }
  }, [cancelComparison, session.id])
  useEffect(() => {
    alive.current = true
    controls.current = {
      model: () => buffer.getSnapshot().modelId,
      leave: async () => { invalidateRun(); cancelComparison(); sealPartial(); setBusy(false); setActivity([]); await buffer.flush() },
    }
    // Fixed interval, not a per-token debounce: partial responses are checkpointed even while streaming.
    const timer = setInterval(() => { void buffer.saveOnce().catch(() => undefined) }, 750)
    const onPageHide = () => { invalidateRun(); sealPartial(); retainUntilSaved(buffer) }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      alive.current = false; clearInterval(timer); window.removeEventListener('pagehide', onPageHide)
      invalidateRun(); cancelComparison(); sealPartial(); retainUntilSaved(buffer)
    }
  }, [buffer, controls, invalidateRun, cancelComparison, sealPartial])
  useEffect(() => { void checkChanges() }, [checkChanges])
  useEffect(() => {
    if (active.current !== null) stop('Selection or model changed. Send again to use the current selection.')
  }, [scopeKey, modelId, stop])
  useEffect(() => {
    if (followTail.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])
  const persistFinished = () => {
    void buffer.flush().then(() => {
      if (!alive.current) return
      savedCallback.current(); void checkChanges()
    }).catch(cause => { if (alive.current) setNotice(messageText(cause)) })
  }

  const send = async () => {
    const question = buffer.getSnapshot().draft.trim()
    if (!question || active.current !== null || transitioning || !alive.current) return
    invalidateRun(); cancelComparison(); setChecking(false)
    const runId = ++epoch.current, capturedScope = scopeKey, capturedModel = modelId
    const selected = selectionSnapshot(selection.opened, selection.files, selection.directories)
    active.current = runId; setBusy(true); setNotice('Saving a local file fingerprint before this message…'); setActivity([])
    const current = () => alive.current && active.current === runId && epoch.current === runId &&
      scopeRef.current === capturedScope && modelRef.current === capturedModel
    const scanId = crypto.randomUUID(); activeScan.current = scanId
    try {
      const [rawSettings, fingerprint] = await Promise.all([
        loadSettings(), window.nawaHistory.capture({ id: session.id, scanId, scope: selected }),
      ])
      if (!current()) return
      activeScan.current = null
      const settings = applyChatModel(rawSettings, capturedModel), label = chatModelLabel(settings, capturedModel)
      const fingerprintHash = fingerprint.complete && fingerprint.hash ? fingerprint.hash : undefined
      // History is displayable regardless of selection; model context requires BOTH matching
      // selection and matching verified contents. A changed file invalidates stale prose too.
      const restored: AgentMessage[] = fingerprintHash ? buffer.getSnapshot().messages
        .filter(message => message.contextKey === capturedScope && message.snapshotHash === fingerprintHash &&
          !message.streaming && !message.error && Boolean(message.text))
        .slice(-40).map(message => ({ role: message.role, text: message.text })) : []
      if (!fingerprint.complete) setNotice('Fingerprint check was incomplete. Older answers will not be reused as model context for this message.')
      else if (buffer.getSnapshot().messages.length && !restored.length) setNotice('Files or selection changed, or this is an imported chat. Previous answers remain visible but are not reused as current file context.')
      else setNotice(null)
      const blank = (): HistoryMessage => ({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', text: '',
        streaming: true, contextKey: capturedScope, modelLabel: label, snapshotHash: fingerprintHash })
      const finish = (text: string, error = false) => {
        if (!current()) return
        updateMessages(previous => previous.map((message, index) => index === previous.length - 1 && message.streaming
          ? { ...message, text: text || message.text || 'Done.', streaming: false, error } : message))
        actionClient.current?.cancel(); actionClient.current = null
        active.current = null; loopRef.current = null; setBusy(false); setActivity([]); persistFinished()
      }
      const files = new DirectoryActionClient({
        api: window.nawaDirectory, selection: selected, approvals, current, workflow, settings: () => settings,
        context: () => JSON.stringify({ question, priorMessages: restored.slice(-8).map(m => ({ role: m.role, text: 'text' in m ? m.text.slice(0, 2000) : '' })) }),
        transport: () => createShellTransport(() => settings),
        activity: text => { if (current()) setActivity(previous => [...previous.slice(-3), text]) },
        committed: result => {
          // Record the actual commit even if deleting a selected file triggers a listing refresh.
          const receipt: HistoryMessage = {
            id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', modelLabel: 'Nawa file action',
            text: `${result.operation === 'delete' ? 'Moved to Recycle Bin' : result.operation === 'create' ? 'Created' : 'Updated'}: ${result.path}${result.backupPath ? `\nOriginal backup: ${result.backupPath}` : ''}`,
          }
          updateMessages(previous => previous.at(-1)?.streaming
            ? [...previous.slice(0, -1), receipt, previous[previous.length - 1]] : [...previous, receipt])
          retainUntilSaved(buffer)
        },
      })
      actionClient.current = files
      setActivity(['Checking available file tools…'])
      const knowledgeSkill = await prepareMyAgentKnowledgeSkill(files, question)
      if (!current()) return
      setActivity([])
      const reader = createDirectorySkill({ selection: selected })
      const readerWithEvidence = { ...reader, executeTool: async (call: Parameters<typeof reader.executeTool>[0], signal?: AbortSignal) => {
        const result = await reader.executeTool(call, signal)
        if (current()) files.rememberEvidence(call, result)
        return result
      } }
      const loop = new AgentLoop({
        transport: createShellTransport(() => settings),
        skill: composeSkills('directory', '', [readerWithEvidence, directoryInspectionSkill(files, selected), analyticsSkill(files), knowledgeSkill, directoryMutationSkill(files, selected)]),
        maxTurns: DEFAULT_MAX_TURNS, maxHistory: 40,
        verifyResponse: text => files.verifyInspections(text),
        systemSuffix: () => '\nConversation history refers only to messages with matching selected paths and verified file fingerprints. Do not imply that historical file contents are current. Read selected files again when necessary.',
        events: {
          onText: text => { if (current()) updateMessages(previous => previous.map((message, index) => index === previous.length - 1 && message.streaming ? { ...message, text } : message)) },
          onToolStart: call => { if (current()) setActivity(previous => [...previous.slice(-4), `Running ${call.name}…`]) },
          onToolExecuted: ({ execution }) => { if (current()) setActivity(previous => [...previous.slice(-4), execution.summary]) },
          onTurnEnd: () => { if (current()) updateMessages(previous => [...previous.map(message => message.streaming ? { ...message, streaming: false } : message), blank()]) },
          onDone: ({ text, cancelled, turnLimit }) => {
            if (!current()) return
            finish(text || (cancelled ? 'Stopped.' : ''), cancelled)
            if (turnLimit) setNotice('The agent reached its tool-turn limit.')
          },
          onError: error => finish(error, true),
        },
      })
      loop.restore(restored); loopRef.current = loop
      buffer.edit(record => ({ ...record, draft: record.draft.trim() === question ? '' : record.draft, baselineId: fingerprint.id, lastChatAt: fingerprint.startedAt,
        messages: [...record.messages, { id: crypto.randomUUID(), createdAt: Date.now(), role: 'user', text: question,
          contextKey: capturedScope, modelLabel: label, snapshotHash: fingerprintHash }, blank()] }))
      // Persist the prompt and its baseline together before making the AI request.
      await buffer.flush()
      if (!current()) return
      savedCallback.current(); loop.run(question)
    } catch (cause) {
      if (!current()) return
      invalidateRun(); sealPartial(); setBusy(false); setActivity([]); setNotice(messageText(cause))
      void buffer.flush().catch(() => undefined)
    }
  }

  return <section className="ws-chat workspace-chat-main" aria-label={s('Chat with {folder}', { folder: folderName })}>
    <header className="ws-chat-head">
      <div className="nawa-conversation-picker">{historyDropdown}</div>
      <button type="button" className="ws-chat-close" disabled={transitioning} onClick={onNew}>{s('New chat')}</button>
      <button type="button" className="ws-chat-close" aria-expanded={historyOpen} onClick={toggleHistory}>{s('Manage history')}</button>
      <button type="button" className="ws-chat-close ws-chat-hide" onClick={onHide}>{s('Hide chat')}</button>
    </header>
    {historyPanel}
    <PanelDialog open={reviewOpen} title={s('Review assistant actions')} onClose={() => setReviewOpen(false)}>
      <ApprovalCard controller={approvals} />
      <WorkflowCard controller={workflow} />
      {!approvalState && !workflowState && <p>{s('No actions awaiting review.')}</p>}
    </PanelDialog>
    <div className="ws-chat-scroll" ref={logRef} onScroll={event => {
      const node = event.currentTarget
      followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    }}>
      <ChangeNotice report={comparison} checking={checking} error={checkError} recheck={() => void checkChanges()} />
      <details className="ws-chat-scope" aria-label={s('Selection details')}>
        <summary className="nawa-scope-summary"><strong>{s('Selected files')}</strong><span>{s('{files} files · {folders} folders', { files: selection.files.length, folders: selection.directories.length })}</span></summary>
        {!selection.files.length && !selection.directories.length && <p className="workspace-scope-help">{s('Select files in the workspace to let Nawa read their contents.')}</p>}
        <div className="nawa-selection-items">{selection.directories.map(path => <div key={path} className="nawa-selection-item" title={path}><FolderGlyph size={18} /><bdi>{displayPath(selection, path)}</bdi><small>{s('Names only')}</small></div>)}
          {selection.files.map(path => <div key={path} className="nawa-selection-item" title={path}><DocumentIcon ext={path.split('.').pop() || ''} size={18} /><button type="button" onClick={() => onOpenFile(path)}><bdi>{displayPath(selection, path)}</bdi></button><small>{s('Can read')}</small></div>)}</div>
        {folder && <div className="nawa-opened-folder" title={folder}><bdi>{folder}</bdi> · {s('Names only')}</div>}
        <p className="workspace-scope-help">{s('Opening history does not reselect files. Selection changes stop the current response.')}</p>
      </details>
      <div className="ws-chat-log" role="log" aria-live="polite">
        {messages.length > visibleMessages && <button type="button" className="ws-chat-close" onClick={() => setVisibleMessages(value => value + 100)}>{s('Show earlier messages ({count} more)', { count: messages.length - visibleMessages })}</button>}
        {!messages.length && <div className="ws-chat-empty"><h2>{s('Ask Nawa')}</h2><p>{s('Select files to ask questions or request changes. Every file change requires your approval.')}</p></div>}
        {messages.slice(-visibleMessages).map(message => !message.text && !message.streaming ? null : <div key={message.id} className={`ws-chat-msg ws-chat-${message.role}${message.error ? ' ws-chat-error' : ''}`}>
          <span className="workspace-message-role">{message.role === 'user' ? s('You') : 'Nawa'}{message.modelLabel && <small className="nawa-message-model">{message.modelLabel}</small>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString()}</time></span>
          {message.streaming && !message.text ? s('Thinking…') : message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}</div>)}
      </div>
      {!!activity.length && <div className="ws-chat-notice" role="status">{activity.slice(-2).join(' · ')}</div>}
      <details className="workspace-privacy-note"><summary>{s('Storage and file checks')}</summary><p>{s('Hashes are computed locally, including unselected files inside tracked folders. Only selected files can be sent to your model. Chat history is stored locally without encryption.')}</p></details>
    </div>
    <footer className="ws-chat-footer">
      {(needsReview || workflowState) && <div className="nawa-chat-review-launch"><span role="status">{s(needsReview ? 'Approval needed' : 'Assistant activity')}</span><button type="button" className="set-btn" onClick={() => setReviewOpen(true)}>{s('Review')}</button></div>}
      {parentError && <div className="ws-chat-notice" role="alert">{parentError}</div>}
      {buffer.error && <div className="ws-chat-notice" role="alert">{s('Save needs attention')}: {buffer.error}<button type="button" className="ws-chat-close" onClick={() => void buffer.flush().catch(() => undefined)}>{s('Retry saving')}</button></div>}
      {notice && <div className="ws-chat-notice" role="status">{notice}</div>}
      <ChatModelPicker translate={s} emptyHint={s('Add saved models in Models.')} loadSettings={loadSettings} initialId={modelId} onChange={id => {
        modelRef.current = id; buffer.edit(record => record.modelId === id ? record : { ...record, modelId: id })
      }} disabled={busy || transitioning} />
      <form className="ws-chat-input-row" onSubmit={event => { event.preventDefault(); followTail.current = true; void send() }}>
        <textarea ref={inputRef} aria-label={s('Message Nawa')} className="ws-chat-input" value={input} rows={2} placeholder={s('Ask about this selection…')}
          onChange={event => buffer.edit(record => ({ ...record, draft: event.target.value }))}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); followTail.current = true; void send() }
            else if (event.key === 'Escape' && busy) { event.preventDefault(); event.stopPropagation(); stop() }
          }} />
        {busy ? <button type="button" className="ws-chat-send" onClick={() => stop()}>{s('Stop')}</button>
          : <button type="submit" className="ws-chat-send" disabled={!input.trim() || transitioning}>{s('Send')}</button>}
      </form>
      <div className="nawa-history-save-status" role="status">{s(buffer.error ? 'Save needs attention' : buffer.dirty ? 'Saving locally…' : 'Saved locally')} · {s('{count} messages', { count: data.messages.length })}</div>
    </footer>
  </section>
}
