import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../shared/conversation-api'

export function HistoryPanel({ folder, currentId, version, databasePath, onOpen, onRename, onDelete, onClose }: {
  folder: string | null
  currentId: string
  version: number
  databasePath: string
  onOpen: (id: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}) {
  const [allFolders, setAllFolders] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<ConversationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      setLoading(true)
      void window.nawaHistory.list({ ...(allFolders ? {} : { folder }), query, offset }).then(result => {
        if (!alive) return
        setRows(previous => offset ? [...previous, ...result.conversations.filter(row => !previous.some(old => old.id === row.id))] : result.conversations)
        setTotal(result.total); setError(null)
      }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
        .finally(() => { if (alive) setLoading(false) })
    }, query ? 150 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [folder, allFolders, query, offset, version])
  const perform = async (work: () => Promise<void>) => {
    if (pending) return
    setPending(true); setError(null)
    try { await work(); setRenameId(null); setDeleteId(null); setOffset(0) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <div className="nawa-history-panel" aria-label="Conversation history">
    <div className="nawa-history-heading"><strong>Conversation history</strong><button type="button" className="ws-chat-close" onClick={onClose}>Close history</button></div>
    <div className="nawa-history-filters">
      <input type="search" aria-label="Search conversation titles" placeholder="Search conversations…" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
      <label><input type="checkbox" checked={allFolders} onChange={event => { setAllFolders(event.target.checked); setOffset(0) }} /> All folders</label>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="nawa-history-rows" aria-busy={loading}>
      {!rows.length && !loading && <p>No saved conversations here yet.</p>}
      {rows.map(row => <div className={`nawa-history-row${row.id === currentId ? ' is-active' : ''}`} key={row.id}>
        <button type="button" className="nawa-history-open" disabled={pending} aria-current={row.id === currentId ? 'true' : undefined}
          onClick={() => void perform(() => onOpen(row.id))}>
          <strong>{row.title}</strong><span>{new Date(row.updatedAt).toLocaleString()} · {row.messageCount} messages</span>
          {allFolders && <span title={row.folder || 'Workspace'}>{row.folder || 'Workspace selection'}</span>}
        </button>
        <div className="nawa-history-row-actions"><button type="button" className="ws-chat-close" disabled={pending} onClick={() => { setRenameId(row.id); setTitle(row.title); setDeleteId(null) }}>Rename</button>
          <button type="button" className="ws-chat-close" disabled={pending} onClick={() => { setDeleteId(row.id); setRenameId(null) }}>Delete</button></div>
        {renameId === row.id && <form className="nawa-history-inline" onSubmit={event => { event.preventDefault(); void perform(() => onRename(row.id, title.trim())) }}>
          <input autoFocus aria-label="Conversation title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
          <button type="submit" className="ws-chat-send" disabled={pending || !title.trim()}>Save title</button>
          <button type="button" className="ws-chat-close" onClick={() => setRenameId(null)}>Cancel</button>
        </form>}
        {deleteId === row.id && <div className="nawa-history-inline" role="group" aria-label="Delete conversation confirmation">
          <p>Delete this conversation? Your files and other chats will not be deleted.</p>
          <button type="button" className="ws-chat-close" onClick={() => setDeleteId(null)}>Cancel</button>
          <button type="button" className="ws-chat-send" disabled={pending} onClick={() => void perform(() => onDelete(row.id))}>Delete conversation</button>
        </div>}
      </div>)}
    </div>
    {rows.length < total && <button type="button" className="ws-chat-close" disabled={loading} onClick={() => setOffset(rows.length)}>Load more conversations</button>}
    <div className="nawa-history-storage"><span title={databasePath}>Saved locally in SQLite · {total} conversations</span>
      <button type="button" className="ws-chat-close" onClick={() => void perform(() => window.nawaHistory.revealDatabase())}>Show database</button></div>
  </div>
}
