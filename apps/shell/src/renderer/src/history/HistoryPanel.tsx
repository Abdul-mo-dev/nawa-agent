import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../shared/conversation-api'
import { useSidebarText } from '../explorer/sidebar-i18n'

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
  const { s } = useSidebarText()
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
  return <div className="nawa-history-panel" aria-label={s("Conversation history")}>
    <div className="nawa-history-heading"><strong>{s("Conversation history")}</strong><button type="button" className="ws-chat-close" onClick={onClose}>{s("Close history")}</button></div>
    <div className="nawa-history-filters">
      <input type="search" aria-label={s("Search conversation titles")} placeholder={s("Search conversations…")} value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
      <label><input type="checkbox" checked={allFolders} onChange={event => { setAllFolders(event.target.checked); setOffset(0) }} /> {s("All folders")}</label>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="nawa-history-rows" aria-busy={loading}>
      {!rows.length && !loading && <p>{s("No saved conversations here yet.")}</p>}
      {rows.map(row => <div className={`nawa-history-row${row.id === currentId ? ' is-active' : ''}`} key={row.id}>
        <button type="button" className="nawa-history-open" disabled={pending} aria-current={row.id === currentId ? 'true' : undefined}
          onClick={() => void perform(() => onOpen(row.id))}>
          <strong>{row.title}</strong><span>{new Date(row.updatedAt).toLocaleString()} · {row.messageCount} {s("messages")}</span>
          {allFolders && <span title={row.folder || 'Workspace'}>{row.folder || 'Workspace selection'}</span>}
        </button>
        <div className="nawa-history-row-actions"><button type="button" className="ws-chat-close" disabled={pending} onClick={() => { setRenameId(row.id); setTitle(row.title); setDeleteId(null) }}>{s("Rename")}</button>
          <button type="button" className="ws-chat-close" disabled={pending} onClick={() => { setDeleteId(row.id); setRenameId(null) }}>{s("Delete")}</button></div>
        {renameId === row.id && <form className="nawa-history-inline" onSubmit={event => { event.preventDefault(); void perform(() => onRename(row.id, title.trim())) }}>
          <input autoFocus aria-label={s("Conversation title")} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
          <button type="submit" className="ws-chat-send" disabled={pending || !title.trim()}>{s("Save title")}</button>
          <button type="button" className="ws-chat-close" onClick={() => setRenameId(null)}>{s("Cancel")}</button>
        </form>}
        {deleteId === row.id && <div className="nawa-history-inline" role="group" aria-label={s("Delete conversation confirmation")}>
          <p>{s("Delete this conversation? Your files and other chats will not be deleted.")}</p>
          <button type="button" className="ws-chat-close" onClick={() => setDeleteId(null)}>{s("Cancel")}</button>
          <button type="button" className="ws-chat-send" disabled={pending} onClick={() => void perform(() => onDelete(row.id))}>{s("Delete conversation")}</button>
        </div>}
      </div>)}
    </div>
    {rows.length < total && <button type="button" className="ws-chat-close" disabled={loading} onClick={() => setOffset(rows.length)}>{s("Load more conversations")}</button>}
    <div className="nawa-history-storage"><span title={databasePath}>{s("Saved locally in SQLite ·")} {total} {s("conversations")}</span>
      <button type="button" className="ws-chat-close" onClick={() => void perform(() => window.nawaHistory.revealDatabase())}>{s("Show database")}</button></div>
  </div>
}
