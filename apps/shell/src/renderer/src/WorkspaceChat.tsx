import { useEffect, useRef, useState } from 'react'
import type { AgentMessage } from '@genoffice/agent-core'

/** one chat turn shown in the directory panel (answers stay in the chat) */
interface WsMessage {
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  streaming?: boolean
}

const HISTORY_KEY_PREFIX = 'home-ws-chat:'
const HISTORY_LIMIT = 40
const MAX_SCOPE_FILES = 6
const CHARS_PER_FILE = 12_000

function historyKey(folder: string | null): string {
  return `${HISTORY_KEY_PREFIX}${folder ?? 'root'}`
}

function loadHistory(folder: string | null): WsMessage[] {
  try {
    const raw = localStorage.getItem(historyKey(folder))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (m): m is WsMessage =>
          !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'),
      )
      .filter((m) => typeof m.text === 'string' && !m.streaming)
      .slice(-HISTORY_LIMIT)
  } catch {
    return []
  }
}

const SYSTEM_PROMPT = `You are the Nawa directory assistant. The user selected files from one folder; their contents are pasted into each question under "=== file name ===" headers.
- Answer from the file contents, not from file names. Say when the contents do not contain the answer.
- Keep answers short and cite the file name for each fact.
- You cannot edit files here: to change a file the user opens it (an Open action exists next to every file). Never claim you edited anything.`

export function WorkspaceChat({
  folder,
  folderName,
  scopePaths,
  onOpenFile,
  onClose,
}: {
  /** selected directory (null = save-folder root) */
  folder: string | null
  folderName: string
  /** checked file paths that scope the chat */
  scopePaths: string[]
  onOpenFile: (path: string) => void
  onClose: () => void
}) {
  const [messages, setMessages] = useState<WsMessage[]>(() => loadHistory(folder))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef<string | null>(null)
  const folderRef = useRef(folder)
  folderRef.current = folder

  // switching folders swaps the conversation (each directory keeps its own)
  useEffect(() => {
    if (requestRef.current) {
      void window.aiOffice.aiStreamCancel(requestRef.current).catch(() => {})
      requestRef.current = null
    }
    setBusy(false)
    setNotice(null)
    setMessages(loadHistory(folder))
    setInput('')
  }, [folder])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [messages])

  useEffect(() => {
    try {
      localStorage.setItem(
        historyKey(folder),
        JSON.stringify(messages.filter((m) => !m.streaming).slice(-HISTORY_LIMIT)),
      )
    } catch {
      /* ignore */
    }
  }, [messages, folder])

  useEffect(() => {
    const off = window.aiOffice.onAiStreamChunk((chunk) => {
      if (chunk.requestId !== requestRef.current) return
      if (chunk.type === 'delta' || chunk.type === 'reasoning') {
        const text = chunk.text ?? ''
        if (!text) return
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + text }
          }
          return next
        })
      } else if (chunk.type === 'done') {
        requestRef.current = null
        setBusy(false)
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false }
          }
          return next
        })
      } else if (chunk.type === 'error') {
        requestRef.current = null
        setBusy(false)
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          const text = chunk.error || 'The request failed.'
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text, error: true, streaming: false }
          } else {
            next.push({ role: 'assistant', text, error: true })
          }
          return next
        })
      }
      // pings and tool calls carry nothing for this tool-less chat
    })
    return off
  }, [])

  const stop = () => {
    if (requestRef.current) {
      void window.aiOffice.aiStreamCancel(requestRef.current).catch(() => {})
      requestRef.current = null
    }
    setBusy(false)
    setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.streaming)))
  }

  const send = async () => {
    const question = input.trim()
    if (!question || busy) return
    const scope = scopePaths.slice(0, MAX_SCOPE_FILES)
    if (scope.length === 0) {
      setNotice('Check files in this folder to scope the chat to them.')
      return
    }
    setNotice(null)
    setInput('')
    setBusy(true)
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: question },
      { role: 'assistant', text: '', streaming: true },
    ])
    try {
      const settings = await window.aiOffice.getAiSettings()
      // read the scoped files (capped slices, parsed locally in main)
      const sections: string[] = []
      const skipped: string[] = []
      for (const path of scope) {
        const name = path.split(/[/\\]/).pop() ?? path
        try {
          const read = await window.aiOffice.readWorkspaceFile(path, CHARS_PER_FILE)
          if (read.ok && read.text != null) {
            const total = read.totalChars ?? read.text.length
            const cut =
              read.text.length < total
                ? `\n[…${total - read.text.length} more characters not shown]`
                : ''
            sections.push(`=== ${name} ===\n${read.text}${cut}`)
          } else {
            skipped.push(name)
          }
        } catch {
          skipped.push(name)
        }
      }
      if (skipped.length > 0) {
        setNotice(
          `${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}).`,
        )
      }
      const past: AgentMessage[] = messages
        .filter((m) => !m.streaming && m.text)
        .slice(-10)
        .map((m) => ({ role: m.role, text: m.text }) as AgentMessage)
      const requestId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `ws-${Date.now()}`
      requestRef.current = requestId
      await window.aiOffice.aiStream({
        requestId,
        settings,
        system: SYSTEM_PROMPT,
        messages: [
          ...past,
          {
            role: 'user',
            text: `Files in scope (${sections.length}):\n\n${sections.join('\n\n')}\n\nQuestion: ${question}`,
          } as AgentMessage,
        ],
      })
    } catch (err) {
      requestRef.current = null
      setBusy(false)
      const text = err instanceof Error ? err.message : String(err)
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          next[next.length - 1] = { ...last, text, error: true, streaming: false }
        }
        return next
      })
    }
  }

  return (
    <aside className="ws-chat" aria-label="Directory chat">
      <div className="ws-chat-head">
        <div className="ws-chat-title" title={folder ?? ''}>
          Chat · {folderName}
        </div>
        <button type="button" className="ws-chat-close" onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </div>
      <div className="ws-chat-scope">
        {scopePaths.length === 0 ? (
          <span className="ws-chat-scope-empty">
            No files checked — check files to chat with them.
          </span>
        ) : (
          <>
            <span className="ws-chat-scope-count">
              {scopePaths.length} file{scopePaths.length === 1 ? '' : 's'} in scope
              {scopePaths.length > MAX_SCOPE_FILES ? ` (first ${MAX_SCOPE_FILES} read)` : ''}
            </span>
            <div className="ws-chat-files">
              {scopePaths.slice(0, MAX_SCOPE_FILES).map((p) => {
                const name = p.split(/[/\\]/).pop() ?? p
                return (
                  <span key={p} className="ws-chat-file" title={p}>
                    {name}
                    <button type="button" onClick={() => onOpenFile(p)} title={`Open ${name}`}>
                      Open
                    </button>
                  </span>
                )
              })}
            </div>
          </>
        )}
      </div>
      <div ref={logRef} className="ws-chat-log">
        {messages.length === 0 && (
          <div className="ws-chat-empty">
            Ask about the checked files. Answers stay here — nothing is opened or changed.
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'assistant' && !m.text && !m.streaming ? null : (
            <div
              key={i}
              className={`ws-chat-msg ws-chat-${m.role}${m.error ? ' ws-chat-error' : ''}`}
            >
              {m.streaming && !m.text ? '…' : m.text}
            </div>
          ),
        )}
      </div>
      {notice && <div className="ws-chat-notice">{notice}</div>}
      <div className="ws-chat-input-row">
        <textarea
          className="ws-chat-input"
          value={input}
          rows={2}
          placeholder={scopePaths.length === 0 ? 'Check files first…' : 'Ask about these files…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button type="button" className="ws-chat-send" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="ws-chat-send"
            onClick={() => void send()}
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </div>
    </aside>
  )
}
