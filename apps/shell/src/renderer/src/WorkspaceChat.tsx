import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AgentLoop, composeSkills, type AgentMessage } from '@genoffice/agent-core'
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
import { ChangeNotice } from './history/ChangeNotice'
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
  const hide = () => transition(async () => { if (alive.current) props.onClose() })
  if (!session) return <section className="ws-chat workspace-chat-main" aria-label="Nawa conversation history">
    <header className="ws-chat-head"><NawaIcon size={27} /><h2>Nawa assistant</h2></header>
    <div className="ws-chat-notice" role={error ? 'alert' : 'status'}>{error || (loading ? 'Opening conversation history…' : 'No conversation loaded.')}</div>
    {error && <button type="button" className="ws-chat-close" onClick={() => setRetry(value => value + 1)}>Retry opening history</button>}
    <button type="button" className="ws-chat-close" onClick={props.onClose}>Hide chat</button>
  </section>
  return <DirectoryChat key={`${session.id}:${mountVersion}`} {...props} session={session}
    controls={controls} transitioning={transitioning} parentError={error}
    onNew={() => { void newChat().catch(() => undefined) }} onHide={() => { void hide().catch(() => undefined) }}
    historyOpen={historyOpen} toggleHistory={() => setHistoryOpen(value => !value)}
    onSaved={() => { if (alive.current) setHistoryVersion(value => value + 1) }}
    historyPanel={historyOpen ? <HistoryPanel folder={props.folder} currentId={session.id} version={historyVersion}
      databasePath={databasePath} onOpen={openChat} onRename={renameChat} onDelete={deleteChat} onClose={() => setHistoryOpen(false)} /> : null} />
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
}

function DirectoryChat({ folder, folderName, scopePaths, scopeDirs = [], onOpenFile, session, controls,
  transitioning, parentError, onNew, onHide, historyOpen, toggleHistory, onSaved, historyPanel }: DirectoryChatProps) {
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
    const scan = activeScan.current; activeScan.current = null
    if (scan) void window.nawaHistory.cancelScan(scan).catch(() => undefined)
    const loop = loopRef.current; loopRef.current = null
    try { if (loop?.busy) loop.reset() } catch (cause) { console.warn('Nawa: cleanup failed.', cause) }
  }, [])
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
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
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
        active.current = null; loopRef.current = null; setBusy(false); setActivity([]); persistFinished()
      }
      const loop = new AgentLoop({
        transport: createShellTransport(() => settings),
        skill: composeSkills('directory', '', [createDirectorySkill({ selection: selected })]),
        maxTurns: 24, maxHistory: 40,
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

  return <section className="ws-chat workspace-chat-main" aria-label={`Chat with ${folderName}`}>
    <header className="ws-chat-head"><NawaIcon size={27} /><div className="workspace-chat-heading">
      <span className="workspace-eyebrow">Nawa assistant · SQLite history</span><h1 className="ws-chat-title" title={data.title}>{data.title}</h1>
      <div className="nawa-history-conversation-folder" title={data.folder || 'Workspace selection'}>{data.folderName}</div>
    </div>
      <button type="button" className="ws-chat-close" disabled={transitioning} onClick={onNew}>New chat</button>
      <button type="button" className="ws-chat-close" aria-expanded={historyOpen} onClick={toggleHistory}>History</button>
      <button type="button" className="ws-chat-close" disabled={transitioning} onClick={onHide}>Hide chat</button></header>
    {parentError && <div className="ws-chat-notice" role="alert">{parentError}</div>}
    {historyPanel}
    {!historyOpen && <>
      <ChangeNotice report={comparison} checking={checking} error={checkError} recheck={() => void checkChanges()} />
      <div className="ws-chat-scope" aria-label="Main-panel selection"><div className="workspace-scope-toolbar">
        <strong>Selected in main panel</strong><span className="ws-chat-meta">{selection.files.length} files · {selection.directories.length} folders</span></div>
        {!selection.files.length && !selection.directories.length && <p className="workspace-scope-help">Nothing selected. Select individual files to let the assistant read their contents.</p>}
        <div className="nawa-selection-items">{selection.directories.map(path => <div key={path} className="nawa-selection-item" title={path}><FolderGlyph size={18} /><span>{displayPath(selection, path)}</span><small>Names only</small></div>)}
          {selection.files.map(path => <div key={path} className="nawa-selection-item" title={path}><DocumentIcon ext={path.split('.').pop() || ''} size={18} /><button type="button" onClick={() => onOpenFile(path)}>{displayPath(selection, path)}</button><small>Can read</small></div>)}</div>
        {folder && <div className="nawa-opened-folder" title={folder}>Opened: {folder} <span>· names only for AI</span></div>}
        <p className="workspace-scope-help">Opening history does not reselect files. Selection changes stop the current response.</p></div>
    </>}
    {!!activity.length && <div className="ws-chat-notice" role="status">{activity.slice(-2).join(' · ')}</div>}
    <div ref={logRef} className="ws-chat-log" role="log" aria-live="polite">
      {messages.length > visibleMessages && <button type="button" className="ws-chat-close" onClick={() => setVisibleMessages(value => value + 100)}>Show earlier messages ({messages.length - visibleMessages} more)</button>}
      {!messages.length && <div className="ws-chat-empty"><h2>Ask Nawa</h2><p>Select files to discuss their contents, or ask about folder listings.</p><p>New chat saves this conversation and starts another. Find previous conversations under History.</p></div>}
      {messages.slice(-visibleMessages).map(message => !message.text && !message.streaming ? null : <div key={message.id} className={`ws-chat-msg ws-chat-${message.role}${message.error ? ' ws-chat-error' : ''}`}>
        <span className="workspace-message-role">{message.role === 'user' ? 'You' : 'Nawa'}{message.modelLabel && <small className="nawa-message-model">{message.modelLabel}</small>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString()}</time></span>
        {message.streaming && !message.text ? 'Thinking…' : message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}</div>)}
    </div>
    {buffer.error && <div className="ws-chat-notice" role="alert">Not saved: {buffer.error}<button type="button" className="ws-chat-close" onClick={() => void buffer.flush().catch(() => undefined)}>Retry saving</button></div>}
    {notice && <div className="ws-chat-notice" role="status">{notice}</div>}
    <ChatModelPicker loadSettings={loadSettings} initialId={modelId} onChange={id => {
      modelRef.current = id; buffer.edit(record => record.modelId === id ? record : { ...record, modelId: id })
    }} disabled={busy || transitioning} />
    <form className="ws-chat-input-row" onSubmit={event => { event.preventDefault(); void send() }}>
      <textarea ref={inputRef} aria-label="Message Nawa" className="ws-chat-input" value={input} rows={3} placeholder="Ask about this selection…"
        onChange={event => buffer.edit(record => ({ ...record, draft: event.target.value }))}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
          else if (event.key === 'Escape' && busy) { event.preventDefault(); stop() }
        }} />
      {busy ? <button type="button" className="ws-chat-send" onClick={() => stop()}>Stop</button>
        : <button type="submit" className="ws-chat-send" disabled={!input.trim() || transitioning}>Send</button>}
    </form>
    <div className="nawa-history-save-status" role="status">{buffer.error ? 'Save needs attention' : buffer.dirty ? 'Saving locally…' : 'Saved locally'} · {data.messages.length} messages</div>
    <div className="workspace-privacy-note">Hashes are computed locally, including unselected files inside the tracked folders. Hashing does not grant AI access: only explicitly selected files can be sent to your model. History is stored locally, not encrypted by this feature.</div>
  </section>
}
