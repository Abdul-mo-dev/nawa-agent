import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../shared/conversation-api'
import '../directory-actions/approvals.css'

export function HistoryDropdown({ folder, currentId, title, version, disabled, onOpen }: {
  folder: string | null; currentId: string; title: string; version: number; disabled: boolean
  onOpen(id: string): Promise<void>
}) {
  const [rows, setRows] = useState<ConversationSummary[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void (async () => {
      let offset = 0, total = Infinity
      const result: ConversationSummary[] = []
      while (offset < total) {
        const page = await window.nawaHistory.list({ folder, offset })
        if (!live) return
        result.push(...page.conversations); total = page.total
        if (!page.conversations.length) break
        offset += page.conversations.length
      }
      if (live) setRows([...new Map(result.map(row => [row.id, row])).values()])
    })().catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [folder, version])
  return <div>
    <label className="nawa-history-dropdown">Chat
      <select aria-label="Directory conversation history" value={currentId} disabled={disabled || (loading && !rows.length)}
        onChange={event => { const id = event.target.value; if (id !== currentId) void onOpen(id).catch(cause => setError(String(cause))) }}>
        {!rows.some(row => row.id === currentId) && <option value={currentId}>{title}</option>}
        {rows.map(row => <option key={row.id} value={row.id}>{row.title} — {new Date(row.updatedAt).toLocaleString()}</option>)}
      </select>
    </label>
    {error && <div className="ws-chat-notice" role="alert">History: {error}</div>}
  </div>
}
