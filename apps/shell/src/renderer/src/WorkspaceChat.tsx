import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentLoop, composeSkills, type AgentMessage } from '@genoffice/agent-core'
import { applyChatModel, chatModelLabel } from '@genoffice/ai-provider/browser'
import { Markdown, ChatModelPicker } from '@genoffice/ui'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/chat-model-picker.css'
import {
  clearMessages, draftKey, loadMessages, saveMessages, type WorkspaceMessage,
} from './workspace-chat-state'
import { createDirectorySkill } from './ai/directory-skill'
import { displayPath, selectionKey, selectionSnapshot } from './ai/directory-selection'
import { createShellTransport } from './ai/transport'
import { DocumentIcon, FolderGlyph, NawaIcon } from './explorer/Icons'
import './workspace-selection.css'

interface WorkspaceChatProps {
  folder: string | null
  folderName: string
  scopePaths: string[]
  scopeDirs?: string[]
  onOpenFile: (path: string) => void
  onClose: () => void
}

export function WorkspaceChat(props: WorkspaceChatProps) {
  return <DirectoryChat key={props.folder ?? 'nawa-main-selection'} {...props} />
}

function DirectoryChat({
  folder, folderName, scopePaths, scopeDirs = [], onOpenFile, onClose,
}: WorkspaceChatProps) {
  const conversation = folder ?? 'nawa-main-selection'
  const [messages, setMessages] = useState<WorkspaceMessage[]>(() => {
    try { return loadMessages(localStorage, conversation) } catch { return [] }
  })
  const [input, setInput] = useState(() => {
    try { return localStorage.getItem(draftKey(conversation)) ?? '' } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activity, setActivity] = useState<string[]>([])
  const [confirmNewChat, setConfirmNewChat] = useState(false)
  const [modelId, setModelId] = useState(() => {
    try { return localStorage.getItem(`nawa.chat-model:${conversation}`) || '' } catch { return '' }
  })

  const selection = useMemo(
    () => selectionSnapshot(folder, scopePaths, scopeDirs),
    [folder, scopePaths, scopeDirs],
  )
  const scopeKey = selectionKey(selection)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const cancelNewChatRef = useRef<HTMLButtonElement>(null)
  const focusFrame = useRef<number | null>(null)
  const confirmationOpen = useRef(false)
  const loopRef = useRef<AgentLoop | null>(null)
  const epoch = useRef(0)
  const active = useRef<number | null>(null)
  const alive = useRef(true)
  const scopeRef = useRef(scopeKey)
  const modelRef = useRef(modelId)
  scopeRef.current = scopeKey
  modelRef.current = modelId

  const loadSettings = useCallback(() => window.aiOffice.getAiSettings(), [])

  const focusComposer = useCallback(() => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null
      if (alive.current) inputRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const dismissConfirmation = useCallback(() => {
    confirmationOpen.current = false
    setConfirmNewChat(false)
  }, [])

  const invalidateRun = useCallback(() => {
    // Invalidate callbacks before aborting: transport cancellation can emit events.
    epoch.current++
    active.current = null
    const loop = loopRef.current
    loopRef.current = null
    // An idle loop is not reused. Dropping it avoids cancelling a completed handle.
    try {
      if (loop?.busy) loop.reset()
    } catch (error) {
      console.warn('Nawa: directory-chat cleanup failed.', error)
    }
  }, [])

  const stop = useCallback((reason = 'Stopped. The partial response is kept.') => {
    invalidateRun()
    if (!alive.current) return
    setBusy(false)
    setActivity([])
    setNotice(reason)
    setMessages(previous => previous.map(message => message.streaming
      ? { ...message, streaming: false, error: true, text: message.text || 'Stopped.' }
      : message))
  }, [invalidateRun])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      confirmationOpen.current = false
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
      invalidateRun()
    }
  }, [invalidateRun])

  useEffect(() => {
    // A changed selection/model cannot continue using the previous allowlist.
    dismissConfirmation()
    if (active.current !== null) {
      stop('Selection or model changed. Send again to use the current selection.')
    }
  }, [scopeKey, modelId, stop, dismissConfirmation])

  useEffect(() => {
    try { saveMessages(localStorage, conversation, messages) } catch { /* Optional storage. */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [conversation, messages])

  useEffect(() => {
    try { localStorage.setItem(draftKey(conversation), input) } catch { /* Optional storage. */ }
  }, [conversation, input])

  useEffect(() => {
    if (confirmNewChat) cancelNewChatRef.current?.focus({ preventScroll: true })
  }, [confirmNewChat])

  const send = async () => {
    const question = input.trim()
    if (!question || active.current !== null || !alive.current) return
    dismissConfirmation()
    invalidateRun()
    const runId = ++epoch.current
    const capturedScope = scopeKey
    const capturedModel = modelId
    const snapshot = selectionSnapshot(selection.opened, selection.files, selection.directories)
    active.current = runId
    setBusy(true)
    setNotice(null)
    setActivity([])
    const current = () => alive.current && active.current === runId && epoch.current === runId &&
      scopeRef.current === capturedScope && modelRef.current === capturedModel

    try {
      const settings = applyChatModel(await loadSettings(), capturedModel)
      if (!current()) return
      const label = chatModelLabel(settings, capturedModel)
      // Preserve follow-ups only for the same selection, never a different file scope.
      const contextKey = capturedScope
      const restored: AgentMessage[] = messages
        .filter(message => message.contextKey === contextKey && !message.streaming && !message.error && !!message.text)
        .map(message => ({ role: message.role, text: message.text }))
      const blank = (): WorkspaceMessage => ({
        role: 'assistant', text: '', streaming: true, contextKey, modelLabel: label,
      })
      const finish = (text: string, error = false) => {
        if (!current()) return
        setMessages(previous => previous.map((message, index) =>
          index === previous.length - 1 && message.streaming
            ? { ...message, text: text || message.text || 'Done.', streaming: false, error }
            : message))
        active.current = null
        setBusy(false)
        setActivity([])
      }

      const loop = new AgentLoop({
        transport: createShellTransport(() => settings),
        skill: composeSkills('directory', '', [createDirectorySkill({ selection: snapshot })]),
        maxTurns: 24,
        maxHistory: 40,
        events: {
          onText: text => {
            if (current()) setMessages(previous => previous.map((message, index) =>
              index === previous.length - 1 && message.streaming ? { ...message, text } : message))
          },
          onToolStart: call => {
            if (current()) setActivity(previous => [...previous.slice(-4), `Running ${call.name}…`])
          },
          onToolExecuted: ({ execution }) => {
            if (current()) setActivity(previous => [...previous.slice(-4), execution.summary])
          },
          onTurnEnd: () => {
            if (current()) setMessages(previous => [
              ...previous.map(message => message.streaming ? { ...message, streaming: false } : message),
              blank(),
            ])
          },
          onDone: ({ text, cancelled, turnLimit }) => {
            if (!current()) return
            finish(text || (cancelled ? 'Stopped.' : ''), cancelled)
            if (turnLimit) setNotice('The agent reached its tool-turn limit.')
          },
          onError: error => finish(error, true),
        },
      })
      loop.restore(restored)
      loopRef.current = loop
      setInput('')
      setMessages(previous => [
        ...previous, { role: 'user', text: question, contextKey, modelLabel: label }, blank(),
      ])
      loop.run(question)
    } catch (error) {
      if (!current()) return
      const text = error instanceof Error ? error.message : String(error)
      invalidateRun()
      setBusy(false)
      setActivity([])
      setMessages(previous => previous.map(message => message.streaming
        ? { ...message, text: message.text || text, streaming: false, error: true }
        : message))
      setNotice(text)
    }
  }

  const requestNewChat = () => {
    if (!messages.length && !input.trim() && active.current === null) {
      focusComposer()
      return
    }
    // Use an ordinary React panel, not a blocking browser/native confirmation.
    confirmationOpen.current = true
    setConfirmNewChat(true)
  }

  const cancelNewChat = () => {
    dismissConfirmation()
    focusComposer()
  }

  const clearConversation = () => {
    if (!confirmationOpen.current) return
    dismissConfirmation()
    invalidateRun()
    try {
      clearMessages(localStorage, conversation)
      localStorage.setItem(draftKey(conversation), '')
    } catch { /* Optional storage. */ }
    setBusy(false)
    setMessages([])
    setInput('')
    setActivity([])
    setNotice(null)
    // Preserve the opened directory, Explorer selection, and selected model.
    focusComposer()
  }

  return (
    <section className="ws-chat workspace-chat-main" aria-label={`Chat with ${folderName}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && confirmationOpen.current) {
          event.preventDefault()
          event.stopPropagation()
          cancelNewChat()
        }
      }}>
      <header className="ws-chat-head">
        <NawaIcon size={27} />
        <div className="workspace-chat-heading">
          <span className="workspace-eyebrow">Nawa assistant</span>
          <h1 className="ws-chat-title">{folderName}</h1>
        </div>
        <button type="button" className="ws-chat-close" onClick={requestNewChat}
          aria-expanded={confirmNewChat}
          disabled={!busy && !messages.length && !input.trim()}>New chat</button>
        <button type="button" className="ws-chat-close" onClick={onClose}>Hide chat</button>
      </header>

      {confirmNewChat && (
        <div className="ws-chat-notice nawa-new-chat-confirmation" role="group"
          aria-label="New chat confirmation"
          style={{ display: 'block', flexShrink: 0 }}>
          <p style={{ margin: '0 0 8px' }}>
            {busy ? 'Stop the current response and clear this conversation?' : 'Clear this conversation and start a new chat?'}
            {' '}The current draft will also be cleared. Selected files, folders, and model will stay unchanged.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button ref={cancelNewChatRef} type="button" className="ws-chat-close"
              onClick={cancelNewChat}>Cancel</button>
            <button type="button" className="ws-chat-send"
              onClick={clearConversation}>Clear chat</button>
          </div>
        </div>
      )}

      <div className="ws-chat-scope" aria-label="Main-panel selection">
        <div className="workspace-scope-toolbar">
          <strong>Selected in main panel</strong>
          <span className="ws-chat-meta">
            {selection.files.length} {selection.files.length === 1 ? 'file' : 'files'}
            {' · '}{selection.directories.length} {selection.directories.length === 1 ? 'folder' : 'folders'}
          </span>
        </div>
        {!selection.files.length && !selection.directories.length && (
          <p className="workspace-scope-help">Nothing selected. Select files in the main panel to allow reading their contents.</p>
        )}
        <div className="nawa-selection-items">
          {selection.directories.map(path => (
            <div key={path} className="nawa-selection-item" title={path}>
              <FolderGlyph size={18} /><span>{displayPath(selection, path)}</span><small>Names only</small>
            </div>
          ))}
          {selection.files.map(path => (
            <div key={path} className="nawa-selection-item" title={path}>
              <DocumentIcon ext={path.split('.').pop() || ''} size={18} />
              <button type="button" onClick={() => onOpenFile(path)}>{displayPath(selection, path)}</button>
              <small>Can read</small>
            </div>
          ))}
        </div>
        {folder && <div className="nawa-opened-folder" title={folder}>Opened: {folder} <span>· names only</span></div>}
        <p className="workspace-scope-help">Folder selection permits listing names, not reading files. Selection changes stop the current response.</p>
      </div>

      {!!activity.length && <div className="ws-chat-notice" role="status">{activity.slice(-2).join(' · ')}</div>}
      <div ref={logRef} className="ws-chat-log" role="log" aria-live="polite">
        {!messages.length && (
          <div className="ws-chat-empty"><h2>Ask Nawa</h2><p>List the opened or selected folders. Select individual files to summarize, compare, or ask about their contents.</p></div>
        )}
        {messages.map((message, index) => !message.text && !message.streaming ? null : (
          <div key={index} className={`ws-chat-msg ws-chat-${message.role}${message.error ? ' ws-chat-error' : ''}`}>
            <span className="workspace-message-role">
              {message.role === 'user' ? 'You' : 'Nawa'}
              {message.role === 'assistant' && message.modelLabel && <small className="nawa-message-model">{message.modelLabel}</small>}
            </span>
            {message.streaming && !message.text ? 'Thinking…' : message.role === 'assistant'
              ? <Markdown text={message.text} /> : message.text}
          </div>
        ))}
      </div>
      {notice && <div className="ws-chat-notice" role="status">{notice}</div>}
      <ChatModelPicker loadSettings={loadSettings} onChange={setModelId}
        storageKey={`nawa.chat-model:${conversation}`} disabled={busy} />
      <form className="ws-chat-input-row" onSubmit={event => { event.preventDefault(); void send() }}>
        <textarea ref={inputRef} aria-label="Message Nawa" className="ws-chat-input"
          value={input} rows={3} placeholder="Ask about this selection…"
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            } else if (event.key === 'Escape' && busy && !confirmationOpen.current) {
              event.preventDefault()
              stop()
            }
          }} />
        {busy
          ? <button type="button" className="ws-chat-send" onClick={() => stop()}>Stop</button>
          : <button type="submit" className="ws-chat-send" disabled={!input.trim()}>Send</button>}
      </form>
      <div className="workspace-privacy-note">The configured model can see folder names and metadata. Only explicitly selected files may be read. Previous messages from a different selection are not sent again.</div>
    </section>
  )
}
