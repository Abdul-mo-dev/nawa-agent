import { WorkflowController } from './directory-actions/workflow-controller'

import { WorkflowCard } from './directory-actions/WorkflowCard'
import { directoryInspectionSkill } from './directory-actions/inspection-skill'
import { analyticsSkill } from './analytics/skill'
import { prepareMyAgentKnowledgeSkill } from './rag/myagent-skill'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AgentLoop, type AgentMessage, type AgentTransport } from '@genoffice/agent-core'
import { applyChatModel, chatModelLabel } from '@genoffice/ai-provider/browser'
import { AiComposer, Markdown, ChatModelPicker } from '@genoffice/ui'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/chat-model-picker.css'
import type { ConversationRecord, HistoryComparison, HistoryMessage } from '../../shared/conversation-api'
import type { DirectoryActivity } from '../../shared/directory-activity'
import type { DirectoryCitation, DirectoryValidation } from '../../shared/directory-evidence'
import { directoryRoute, routedDirectorySkill } from './directory-actions/routing'
import { workbookOverviewMetadata } from './directory-actions/workbook-metadata'
import { directoryCommitText } from '../../shared/directory-actions-api'
import { isWithin, pathKey } from './explorer/model'
import { historicalIntent, historyCandidates, restoreCompletedHistory } from './directory-actions/evidence'
import { ActivityTimeline } from './directory-actions/ActivityTimeline'
import { WORKSHEET_BOUNDS_GUIDANCE } from './directory-actions/inspection-evidence'
import { activityTargets, activityToolName, diagnosticText, finishActivity, finishActivityStep, startActivityStep, TextFrameBuffer } from './directory-actions/activity'
import { createDirectorySkill } from './ai/directory-skill'
import { displayPath, selectionKey, selectionSnapshot, type DirectorySelection } from './ai/directory-selection'
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
import './directory-chat.css'

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

/** Unchanged transcript rows do not re-render Markdown for every streamed token. */
const DirectoryMessage = memo(function DirectoryMessage({ message, onReview, onCitation }: { message: HistoryMessage; onReview?: () => void; onCitation: (citation: DirectoryCitation) => void }) {
  const { s } = useSidebarText()
  // Activity has its own quiet row, never an empty message attributed to Nawa.
  // This also fixes the display of activity-only records already saved in history.
  if (!message.text && !message.activity) return null
  return <>
    {message.activity && <ActivityTimeline activity={message.activity} onReview={onReview} />}
    {message.text && <div className={`ws-chat-msg ws-chat-${message.role}${message.error ? ' ws-chat-error' : ''}`}
      aria-label={message.role === 'user' ? s('You') : 'Nawa'}
      title={[message.modelLabel, new Date(message.createdAt).toLocaleString()].filter(Boolean).join(' · ')}>
      <div dir="auto">{message.role === 'assistant' ? <Markdown text={message.text} nav={{ scheme: 'RAG:',
        isAllowed: href => !!message.citations?.some(c => c.id === href),
        onNavigate: href => { const citation = message.citations?.find(c => c.id === href); if (citation) onCitation(citation) },
      }} /> : message.text}</div>
    </div>}
  </>
})

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
  const [citation, setCitation] = useState<DirectoryCitation | null>(null)
  const [citationCurrent, setCitationCurrent] = useState<boolean | null>(null)
  const openCitation = useCallback((value: DirectoryCitation) => setCitation(value), [])
  useEffect(() => {
    let live = true; setCitationCurrent(null)
    if (citation) void window.nawaDirectory.checkCitation(citation.path, citation.sourceHash).then(value => { if (live) setCitationCurrent(value) }).catch(() => { if (live) setCitationCurrent(false) })
    return () => { live = false }
  }, [citation])
  const openReview = useCallback(() => setReviewOpen(true), [])
  const followTail = useRef(true)
  const buffer = useMemo(() => new ConversationBuffer(session, window.nawaHistory), [session])
  const data = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot)
  const messages = data.messages, input = data.draft, modelId = data.modelId
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [comparison, setComparison] = useState<HistoryComparison | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [visibleMessages, setVisibleMessages] = useState(100)
  const selection = useMemo(() => selectionSnapshot(folder, scopePaths, scopeDirs), [folder, scopePaths, scopeDirs])
  const scopeKey = selectionKey(selection)
  const [responseSelection, setResponseSelection] = useState<DirectorySelection | null>(null)
  const modelRef = useRef(modelId)
  modelRef.current = modelId
  const logRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null)
  const loopRef = useRef<AgentLoop | null>(null)
  const approvals = useMemo(() => new ApprovalController(), [])
  const workflow = useMemo(() => new WorkflowController(), [])
  const approvalState = useSyncExternalStore(approvals.subscribe, approvals.getSnapshot, approvals.getSnapshot)
  const workflowState = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot)
  const needsReview = !!approvalState || !!workflowState?.interaction
  usePanelActivity('ai', 'conversation', buffer.error ? { kind: 'error', text: s('Save needs attention') } : needsReview ? { kind: 'attention', text: s('Approval needed') } : busy ? { kind: 'busy', text: s('Response in progress') } : null)
  const actionClient = useRef<DirectoryActionClient | null>(null)
  const activityRecord = useRef<{ messageId: string; value: DirectoryActivity } | null>(null)
  const parentTool = useRef<string | undefined>(undefined)
  const textFrames = useRef<TextFrameBuffer | null>(null)
  const active = useRef<number | null>(null), epoch = useRef(0), alive = useRef(true)
  const activeScan = useRef<string | null>(null), comparisonScan = useRef<string | null>(null)
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved
  const loadSettings = useCallback(() => window.aiOffice.getAiSettings(), [])
  const updateMessages = useCallback((change: (messages: HistoryMessage[]) => HistoryMessage[]) => {
    buffer.edit(record => ({ ...record, messages: change(record.messages) }))
  }, [buffer])
  const updateActivity = useCallback((change: (value: DirectoryActivity) => DirectoryActivity) => {
    const entry = activityRecord.current
    if (!entry) return
    const value = change(entry.value)
    activityRecord.current = { ...entry, value }
    updateMessages(previous => previous.map(message => message.id === entry.messageId ? { ...message, activity: value } : message))
  }, [updateMessages])
  const cancelComparison = useCallback(() => {
    const id = comparisonScan.current; comparisonScan.current = null
    if (id) void window.nawaHistory.cancelScan(id).catch(() => undefined)
  }, [])
  const invalidateRun = useCallback(() => {
    textFrames.current?.flush(); textFrames.current = null
    if (activityRecord.current && ['running', 'waiting'].includes(activityRecord.current.value.status))
      updateActivity(value => finishActivity(value, 'cancelled'))
    epoch.current++; active.current = null
    if (alive.current) setResponseSelection(null)
    actionClient.current?.cancel(); actionClient.current = null
    approvals.cancel()
    const scan = activeScan.current; activeScan.current = null
    if (scan) void window.nawaHistory.cancelScan(scan).catch(() => undefined)
    const loop = loopRef.current; loopRef.current = null
    try { if (loop?.busy) loop.reset() } catch (cause) { console.warn('Nawa: cleanup failed.', cause) }
  }, [approvals, updateActivity])
  const sealPartial = useCallback(() => {
    const current = buffer.getSnapshot().messages
    if (current.some(message => message.streaming)) updateMessages(previous => previous.map(message => message.streaming
      ? { ...message, streaming: false, error: true, text: message.text || 'Stopped before a response was completed.' } : message))
    updateMessages(previous => previous.map(message => message.request?.outcome === 'running'
      ? { ...message, request: { ...message.request, outcome: 'cancelled' } } : message))
  }, [buffer, updateMessages])
  const stop = useCallback((reason = 'Stopped. The partial response is saved in this conversation.') => {
    invalidateRun(); sealPartial()
    if (alive.current) { setBusy(false); setNotice(reason) }
    void buffer.flush().catch(cause => { if (alive.current) setNotice(messageText(cause)) })
  }, [buffer, invalidateRun, sealPartial])
  const checkChanges = useCallback(async () => {
    cancelComparison()
    const scanId = crypto.randomUUID(); comparisonScan.current = scanId
    setChecking(true); setCheckError(null)
    try {
      let result: HistoryComparison
      if (!buffer.getSnapshot().baselineId) {
        const baseline = await window.nawaHistory.capture({ id: session.id, scanId, scope: selection })
        if (!alive.current || comparisonScan.current !== scanId) return
        buffer.edit(record => ({ ...record, baselineId: baseline.id }))
        await buffer.flush()
        result = { status: baseline.complete ? 'unchanged' : 'incomplete', since: baseline.startedAt, checkedAt: baseline.finishedAt,
          added: 0, removed: 0, modified: 0, unverified: baseline.issues.length, changes: [], issues: baseline.issues, complete: baseline.complete, truncated: false }
      } else result = await window.nawaHistory.compare({ id: session.id, scanId })
      if (alive.current && comparisonScan.current === scanId) setComparison(result)
    } catch (cause) { if (alive.current && comparisonScan.current === scanId) setCheckError(messageText(cause)) }
    finally {
      if (alive.current && comparisonScan.current === scanId) { comparisonScan.current = null; setChecking(false) }
    }
  }, [cancelComparison, session.id, buffer, selection])
  useEffect(() => {
    alive.current = true
    controls.current = {
      model: () => buffer.getSnapshot().modelId,
      leave: async () => { invalidateRun(); cancelComparison(); sealPartial(); setBusy(false); await buffer.flush() },
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
  useEffect(() => {
    if (active.current !== null) stop('Model changed. Send again to use the current model.')
  }, [modelId, stop])
  useEffect(() => {
    if (active.current === null || !activityRecord.current) return
    const waiting = !!approvalState || !!workflowState?.interaction
    const status = waiting ? 'waiting' : 'running'
    if (['running', 'waiting'].includes(activityRecord.current.value.status) && activityRecord.current.value.status !== status)
      updateActivity(value => ({ ...value, status }))
  }, [approvalState, workflowState?.interaction, updateActivity])
  useEffect(() => {
    if (followTail.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])
  const persistFinished = () => {
    const entry = activityRecord.current
    if (entry) updateActivity(value => startActivityStep(value, { id: 'history.save', tool: 'save_conversation', kind: 'storage', status: 'running', startedAt: Date.now(), summary: 'Saving conversation', targets: [] }))
    void buffer.flush().then(() => {
      if (!alive.current) return
      if (entry && activityRecord.current?.value.id === entry.value.id) {
        updateActivity(value => finishActivityStep(value, 'history.save', 'completed', 'Conversation saved', buffer.lastSave))
        void buffer.saveOnce().catch(() => undefined)
      }
      savedCallback.current()
    }).catch(cause => {
      if (!alive.current) return
      if (entry && activityRecord.current?.value.id === entry.value.id) updateActivity(value => finishActivityStep(value, 'history.save', 'failed', 'Conversation save failed', messageText(cause)))
      setNotice(messageText(cause))
    })
  }

  const send = async () => {
    const question = buffer.getSnapshot().draft.trim()
    if (!question || active.current !== null || transitioning || !alive.current) return
    invalidateRun(); cancelComparison(); setChecking(false)
    const runId = ++epoch.current, capturedScope = scopeKey, capturedModel = modelId
    const selected = selectionSnapshot(selection.opened, selection.files, selection.directories)
    const route = directoryRoute(question, selected)
    const previousMessages = buffer.getSnapshot().messages
    active.current = runId; setBusy(true); setResponseSelection(selected); setNotice(null)
    // Selection is immutable for this request. Explorer changes (including a commit
    // refresh removing a renamed/deleted item) belong to the next request.
    const current = () => alive.current && active.current === runId && epoch.current === runId &&
      modelRef.current === capturedModel
    const startedAt = Date.now(), userMessageId = crypto.randomUUID(), assistantMessageId = crypto.randomUUID()
    const trace: DirectoryActivity = { id: crypto.randomUUID(), model: capturedModel, selectedFiles: selected.files.length,
      startedAt, status: 'running', steps: [], omitted: 0 }
    activityRecord.current = { messageId: assistantMessageId, value: trace }; parentTool.current = undefined
    buffer.edit(record => ({ ...record, draft: record.draft.trim() === question ? '' : record.draft,
      messages: [...record.messages, { id: userMessageId, role: 'user', text: question, createdAt: startedAt, contextKey: capturedScope, request: { id: trace.id, phase: 'user', outcome: 'running' } },
        { id: assistantMessageId, role: 'assistant', text: '', createdAt: startedAt, streaming: true, contextKey: capturedScope, activity: trace, request: { id: trace.id, phase: 'intermediate', outcome: 'running' } }] }))
    let restored: AgentMessage[] = [], validation: DirectoryValidation = { evidence: [], durationMs: 0, sourceCount: 0 }
    let preparedCatalog: { path: string; content: string } | undefined
    try {
      const rawSettings = await loadSettings()
      if (!current()) return
      activeScan.current = null
      const settings = applyChatModel(rawSettings, capturedModel), label = chatModelLabel(settings, capturedModel)
      updateActivity(value => ({ ...value, model: label }))
      const blank = (): HistoryMessage => ({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', text: '',
        streaming: true, contextKey: capturedScope, modelLabel: label, request: { id: trace.id, phase: 'intermediate', outcome: 'running' } })
      const transport = (): AgentTransport => {
        const base = createShellTransport(() => settings)
        return { stream(request, callbacks) {
          const id = `model:${crypto.randomUUID()}`, startedAt = Date.now()
          let firstEventMs: number | undefined, calls = 0, stopReason: string | undefined, ended = false
          const received = () => { firstEventMs ??= Date.now() - startedAt }
          if (current()) updateActivity(value => startActivityStep(value, { id, parentId: parentTool.current, tool: 'model_request', kind: 'model',
            status: 'running', startedAt, summary: 'Calling chat model', targets: [] }))
          const end = (status: 'completed' | 'failed' | 'cancelled', error?: string) => {
            if (ended || !current()) return
            ended = true
            updateActivity(value => finishActivityStep(value, id, status, status === 'completed' ? 'Model response received' : status === 'failed' ? 'Model request failed' : 'Model request stopped',
              { firstEventMs, returnedToolCalls: calls, advertisedTools: request.tools.length, stopReason, error }))
          }
          try {
            const handle = base.stream(request, { ...callbacks,
              onDelta: text => { received(); callbacks.onDelta(text) },
              onReasoning: text => { received(); callbacks.onReasoning?.(text) },
              onToolCall: call => { received(); calls++; callbacks.onToolCall(call) },
              onStopReason: reason => { stopReason = reason; callbacks.onStopReason?.(reason) },
              onDone: () => { end('completed'); callbacks.onDone() },
              onError: error => { end('failed', error); callbacks.onError(error) },
            })
            return { cancel() { end('cancelled'); handle.cancel() } }
          } catch (cause) { end('failed', messageText(cause)); throw cause }
        } }
      }
      const finish = (text: string, error = false, incomplete = false) => {
        if (!current()) return
        textFrames.current?.flush(); textFrames.current = null
        updateActivity(value => {
          if (error) value = startActivityStep(value, { id: 'response.error', tool: 'assistant_response', kind: 'preparation',
            status: 'failed', startedAt: Date.now(), finishedAt: Date.now(), summary: 'Response did not complete', targets: [], output: diagnosticText(text) })
          return finishActivity(value, incomplete ? 'incomplete' : error ? 'failed' : 'completed')
        })
        updateMessages(previous => previous.map((message, index) => {
          if (message.request?.id !== trace.id) return message
          const final = index === previous.length - 1 && message.streaming
          return { ...message, ...(final ? { text: text || message.text || 'The model did not finish a text answer.', streaming: false, error } : {}),
            citations: message.role === 'assistant' ? files.citationSnapshot() : undefined,
            request: { ...message.request, outcome: incomplete ? 'incomplete' : error ? 'failed' : 'completed',
              phase: final ? 'final' : message.request.phase,
              ...(final && !error && !incomplete ? { evidence: validation.evidence, catalog: preparedCatalog } : {}) } }
        }))
        actionClient.current?.cancel(); actionClient.current = null
        active.current = null; loopRef.current = null; setBusy(false); setResponseSelection(null); persistFinished()
      }
      const files = new DirectoryActionClient({
        api: window.nawaDirectory, selection: selected, approvals, current, workflow, settings: () => settings,
        context: () => JSON.stringify({ question, priorMessages: restored.slice(-8).map(m => ({ role: m.role, text: 'text' in m ? m.text.slice(0, 2000) : '' })) }),
        transport,
        activity: text => {
          if (!current() || !parentTool.current) return
          const id = parentTool.current
          updateActivity(value => ({ ...value, steps: value.steps.map(step => step.id === id
            ? { ...step, summary: diagnosticText(text, 360) } : step) }))
        },
        toolActivity: event => {
          if (!current()) return
          if (event.type === 'approval') {
            const id = `approval:${event.id}:${event.phase}`
            if (event.approved === undefined) updateActivity(value => startActivityStep({ ...value, status: 'waiting' }, {
              id, parentId: parentTool.current, tool: event.phase === 'save' ? 'approve_save' : event.phase === 'action' ? 'approve_file_action' : 'approve_preparation', kind: 'approval',
              status: 'waiting', startedAt: Date.now(), summary: event.phase === 'save' ? 'Review changes before saving' : event.phase === 'action' ? 'Approve file action' : 'Approve preparation', targets: [event.path],
            }))
            else updateActivity(value => ({ ...finishActivityStep(value, id, event.approved ? 'completed' : 'cancelled',
              event.approved ? 'Approved' : 'Declined'), status: 'running' }))
          } else if (event.type === 'start') updateActivity(value => startActivityStep(value, {
            id: `native:${event.call.id}`, parentId: parentTool.current, tool: event.call.name, kind: 'native',
            status: 'running', startedAt: Date.now(), summary: `Native editor: ${event.call.name}`, targets: activityTargets(event.call.input), input: diagnosticText(event.call.input, 1200),
          }))
          else updateActivity(value => finishActivityStep(value, `native:${event.call.id}`, event.execution.isError ? 'failed' : 'completed', event.execution.summary, event.execution.output))
        },
        committed: result => {
          if (preparedCatalog && (pathKey(preparedCatalog.path) === pathKey(result.path) || result.operation === 'delete-folder' && isWithin(preparedCatalog.path, result.path))) preparedCatalog = undefined
          // Record the actual commit even if deleting a selected file triggers a listing refresh.
          const receipt: HistoryMessage = {
            id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', modelLabel: 'Nawa file action',
            request: { id: trace.id, phase: 'receipt', outcome: 'running' },
            text: directoryCommitText(result),
          }
          updateMessages(previous => previous.at(-1)?.streaming
            ? previous.at(-1)?.activity
              ? [...previous.slice(0, -1), { ...previous[previous.length - 1], streaming: false }, receipt, blank()]
              : [...previous.slice(0, -1), receipt, previous[previous.length - 1]] : [...previous, receipt])
          retainUntilSaved(buffer)
        },
      })
      actionClient.current = files
      const candidates = ['metadata', 'tools'].includes(route.intent) ? [] : historyCandidates(previousMessages, capturedScope).filter(candidate => candidate.evidence.length > 0 &&
        (route.intent !== 'overview' || candidate.evidence.every(source => source.path === route.target)))
      if (candidates.length) {
        updateActivity(value => startActivityStep(value, { id: 'prepare.history', tool: 'history_evidence', kind: 'validation', status: 'running', startedAt: Date.now(), summary: 'Checking prior sources', targets: [] }))
        const accepted = await files.restoreEvidence(candidates)
        if (!current()) return
        restored = restoreCompletedHistory(previousMessages, capturedScope, accepted)
        preparedCatalog = previousMessages.filter(message => message.request && accepted.includes(message.request.id) && message.request.catalog?.path === route.target).at(-1)?.request?.catalog
        updateActivity(value => finishActivityStep(value, 'prepare.history', 'completed', 'Prior sources checked', { acceptedRequests: accepted.length, checkedRequests: candidates.length }))
      }
      updateActivity(value => startActivityStep(value, { id: 'prepare.tools', tool: 'knowledge_tool_catalog', kind: 'preparation',
        status: 'running', startedAt: Date.now(), summary: 'Finding available file tools', targets: [] }))
      const knowledgeSkill = await prepareMyAgentKnowledgeSkill(files, question, route.prepareKnowledge)
      if (!current()) return
      updateActivity(value => finishActivityStep(value, 'prepare.tools', knowledgeSkill.preparation.status === 'ready' ? 'completed' : knowledgeSkill.preparation.status === 'unavailable' ? 'failed' : 'skipped',
        knowledgeSkill.preparation.available ? 'MyAgent tools ready' : knowledgeSkill.preparation.status === 'unavailable' ? 'MyAgent tools unavailable' : 'MyAgent preparation not needed', knowledgeSkill.preparation))
      if (route.intent === 'overview' && preparedCatalog) {
        const content = workbookOverviewMetadata(preparedCatalog.content, files.citationSnapshot().filter(citation => citation.path === route.target && citation.locator === 'spreadsheet_catalog_search'))
        preparedCatalog = content ? { path: preparedCatalog.path, content } : undefined
      }
      if (['table', 'overview'].includes(route.intent) && route.target && knowledgeSkill.tools.some(tool => tool.name === 'spreadsheet_catalog_search')) {
        updateActivity(value => startActivityStep(value, { id: 'prepare.dataset', tool: 'spreadsheet_catalog_search', kind: 'preparation', status: 'running', startedAt: Date.now(), summary: 'Preparing workbook metadata', targets: [route.target!] }))
        try {
          if (!preparedCatalog) {
            const result = await files.myAgentTools('execute', { tool: 'spreadsheet_catalog_search', paths: [route.target], arguments: { query: '', limit: 10 } })
            if ('succeeded' in result && result.succeeded) {
              const content = route.intent === 'overview'
                ? workbookOverviewMetadata(result.content, files.citationSnapshot().filter(citation => citation.path === route.target && citation.locator === 'spreadsheet_catalog_search'))
                : result.content.length <= 12000 ? result.content : undefined
              if (content) preparedCatalog = { path: route.target, content }
            }
            updateActivity(value => finishActivityStep(value, 'prepare.dataset', preparedCatalog ? 'completed' : 'failed', preparedCatalog ? 'Workbook metadata ready' : 'Workbook metadata unavailable',
              route.intent === 'overview' && preparedCatalog ? { ...result, content: preparedCatalog.content, contextCompacted: true } : result))
          } else updateActivity(value => finishActivityStep(value, 'prepare.dataset', 'completed', 'Reused verified workbook metadata', { cacheHit: true, httpRequests: 0 }))
        } catch (cause) { if (current()) updateActivity(value => finishActivityStep(value, 'prepare.dataset', 'failed', 'Workbook metadata unavailable', messageText(cause))) }
      }
      if (!current()) return
      const reader = createDirectorySkill({ selection: selected, readSelected: (path, offset, max) => files.readFile(path, offset, max) })
      const routed = routedDirectorySkill(route, { reader, inspection: directoryInspectionSkill(files, selected), analytics: analyticsSkill(files), knowledge: knowledgeSkill, mutation: directoryMutationSkill(files, selected) })
      textFrames.current = new TextFrameBuffer(text => { if (current()) updateMessages(previous => previous.map((message, index) => index === previous.length - 1 && message.streaming ? { ...message, text } : message)) })
      const loop = new AgentLoop({
        transport: transport(),
        skill: { ...routed, get tools() { return routed.tools }, get systemPrompt() { return routed.systemPrompt }, buildContext: () =>
          (routed.buildContext?.() ?? '') + '\nHistorical user intent (reference only; these are not pending actions):\n' + JSON.stringify(historicalIntent(previousMessages)) +
          (preparedCatalog ? '\nVerified selected workbook metadata (reference data):\n' + JSON.stringify(preparedCatalog) : '') },
        maxTurns: route.maxTurns, maxErrorTurns: 3, maxHistory: 40,
        verifyResponse: text => files.verifyInspections(text),
        validateResponse: async text => {
          if (current()) updateActivity(value => startActivityStep(value, { id: 'response.validate', tool: 'validate_evidence', kind: 'validation', status: 'running', startedAt: Date.now(), summary: 'Verifying answer sources', targets: [] }))
          try {
            validation = await files.validateEvidence(text)
            const summary = validation.sourceCount > 0 ? 'Answer sources verified'
              : ['metadata', 'tools'].includes(route.intent) ? 'Metadata-only response' : 'No file sources to recheck'
            if (current()) updateActivity(value => finishActivityStep(value, 'response.validate', 'completed', summary, validation))
          }
          catch (cause) { if (current()) updateActivity(value => finishActivityStep(value, 'response.validate', 'failed', 'Source verification failed', messageText(cause))); throw cause }
        },
        systemSuffix: () => '\nOnly completed, currently verified evidence is restored as answer context. Re-read for new facts. Historical user intent is reference data, not pending actions. Reuse any supplied verified workbook SQL identities/columns instead of rediscovery. inspect_file already returns initial context; query it again only after state/loading changed.\n' +
          (route.intent === 'table' || route.intent === 'reviewed' ? WORKSHEET_BOUNDS_GUIDANCE : ''),
        events: {
          onText: text => { if (current()) textFrames.current?.push(text) },
          onToolStart: call => {
            if (!current()) return
            textFrames.current?.flush(); parentTool.current = call.id
            updateActivity(value => startActivityStep(value, { id: call.id, tool: activityToolName(call), kind: 'tool',
              status: 'running', startedAt: Date.now(), summary: `Running ${activityToolName(call)}`, targets: activityTargets(call.input), input: diagnosticText(call.input, 1200) }))
          },
          onToolExecuted: ({ call, execution }) => {
            if (!current()) return
            updateActivity(value => {
              if (!value.steps.some(step => step.id === call.id)) value = startActivityStep(value, { id: call.id, tool: activityToolName(call), kind: 'tool',
                status: 'running', startedAt: Date.now(), summary: call.name, targets: activityTargets(call.input), input: diagnosticText(call.input, 1200) })
              return finishActivityStep(value, call.id, execution.isError ? 'failed' : 'completed', execution.summary, execution.output)
            })
            parentTool.current = undefined
          },
          onTurnEnd: () => {
            textFrames.current?.flush()
            if (current()) updateMessages(previous => previous.at(-1)?.streaming && !previous.at(-1)?.text
              ? previous : [...previous.map(message => message.streaming ? { ...message, streaming: false } : message), blank()])
          },
          onDone: ({ text, cancelled, turnLimit, truncated }) => {
            if (!current()) return
            finish(text || (cancelled ? 'Stopped.' : ''), cancelled, !!turnLimit || !!truncated || !text.trim())
            if (turnLimit) setNotice('The agent reached its tool-turn limit.')
            else if (truncated) setNotice('The model reached its output limit. This answer is incomplete.')
          },
          onError: error => finish(error, true),
        },
      })
      loop.restore(restored); loopRef.current = loop
      buffer.edit(record => ({ ...record, lastChatAt: startedAt,
        messages: record.messages.map(message => message.id === userMessageId || message.id === assistantMessageId
          ? { ...message, modelLabel: label } : message) }))
      // Persist request identity before making the model request.
      await buffer.flush()
      if (!current()) return
      savedCallback.current(); loop.run(question)
    } catch (cause) {
      if (!current()) return
      updateActivity(value => finishActivityStep(value, value.steps.find(step => step.status === 'running')?.id ?? '', 'failed', messageText(cause), messageText(cause)))
      updateActivity(value => finishActivity(value, 'failed'))
      invalidateRun(); sealPartial(); setBusy(false); setNotice(messageText(cause))
      updateMessages(previous => previous.map(message => message.request?.id === trace.id ? { ...message, request: { ...message.request, outcome: 'failed' } } : message))
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
    <PanelDialog open={!!citation} title={s('Source evidence')} className="directory-evidence-dialog" onClose={() => setCitation(null)}>
      {citation && <><p><bdi>{citation.path}</bdi></p><p>{citation.locator}</p>
        <p role="status">{s(citationCurrent === null ? 'Checking source version…' : citationCurrent ? 'Source version matches this evidence.' : 'The source changed or is unavailable. This is an earlier excerpt.')}</p>
        {citation.excerpt && <blockquote>{citation.excerpt}</blockquote>}
        <button type="button" className="set-btn" onClick={() => onOpenFile(citation.path)}>{s('Open file')}</button></>}
    </PanelDialog>
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
        <p className="workspace-scope-help">{s('Opening history does not reselect files. Each response uses the selection when sent. Selection changes apply to the next message.')}</p>
      </details>
      {busy && responseSelection && selectionKey(responseSelection) !== scopeKey && <p className="workspace-scope-help" role="status">{s('This response continues with {files} files and {folders} folders selected when sent. Your new selection applies to the next message.', { files: responseSelection.files.length, folders: responseSelection.directories.length })}</p>}
      <div className="ws-chat-log" role="log" aria-live="polite">
        {messages.length > visibleMessages && <button type="button" className="ws-chat-close" onClick={() => setVisibleMessages(value => value + 100)}>{s('Show earlier messages ({count} more)', { count: messages.length - visibleMessages })}</button>}
        {!messages.length && <div className="ws-chat-empty"><h2>{s('Ask Nawa')}</h2><p>{s('Select files to ask questions or request changes. Every file change requires your approval.')}</p></div>}
        {messages.slice(-visibleMessages).map(message => <DirectoryMessage key={message.id} message={message}
          onCitation={openCitation}
          onReview={needsReview && activityRecord.current?.messageId === message.id ? openReview : undefined} />)}
      </div>
      <details className="workspace-privacy-note"><summary>{s('Storage and file checks')}</summary><p>{s('Only selected files can be read by the assistant. Used sources are verified before the answer. Check again compares tracked folders on demand. Chat history is stored locally without encryption.')}</p></details>
    </div>
    <footer className="ws-chat-footer">
      {!busy && messages.at(-1)?.request?.outcome === 'incomplete' && <button type="button" className="set-btn" onClick={() => {
        const original = messages.find(message => message.role === 'user' && message.request?.id === messages.at(-1)?.request?.id)
        buffer.edit(record => ({ ...record, draft: `Continue the incomplete answer to: ${original?.text ?? ''}\nVerify sources again before answering. Partial answer (unverified):\n${messages.at(-1)?.text.slice(0, 4000) ?? ''}` }))
        void send()
      }}>{s('Continue answer')}</button>}
      {(needsReview || workflowState) && <div className="nawa-chat-review-launch"><span role="status">{s(needsReview ? 'Approval needed' : 'Assistant activity')}</span><button type="button" className="set-btn" onClick={() => setReviewOpen(true)}>{s('Review')}</button></div>}
      {parentError && <div className="ws-chat-notice" role="alert">{parentError}</div>}
      {buffer.error && <div className="ws-chat-notice" role="alert">{s('Save needs attention')}: {buffer.error}<button type="button" className="ws-chat-close" onClick={() => void buffer.flush().catch(() => undefined)}>{s('Retry saving')}</button></div>}
      {notice && <div className="ws-chat-notice" role="status">{notice}</div>}
      <ChatModelPicker translate={s} emptyHint={s('Add saved models in Models.')} loadSettings={loadSettings} initialId={modelId} onChange={id => {
        modelRef.current = id; buffer.edit(record => record.modelId === id ? record : { ...record, modelId: id })
      }} disabled={busy || transitioning} />
      <fieldset className="ws-chat-composer" disabled={transitioning}>
        <AiComposer value={input} busy={busy} textareaRef={inputRef} iconOnly
          placeholder={s('Ask about this selection…')} ariaLabel={s('Message Nawa')}
          hintIdle={s('Enter to send')} hintBusy={s('Esc to stop')} sendLabel={s('Send')} stopLabel={s('Stop')}
          onChange={draft => buffer.edit(record => ({ ...record, draft }))}
          onSend={() => { followTail.current = true; void send() }} onStop={() => stop()} />
      </fieldset>
      <div className="nawa-history-save-status" role="status">{s(buffer.error ? 'Save needs attention' : buffer.dirty ? 'Saving locally…' : 'Saved locally')} · {s('{count} messages', { count: data.messages.length })}</div>
    </footer>
  </section>
}
