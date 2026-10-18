import { useEffect, useState } from 'react'
import { ChatConversationSelector } from '@genoffice/ui'
import type { ConversationSummary } from '../../../shared/conversation-api'
import '../directory-actions/approvals.css'
import { useSidebarText } from '../explorer/sidebar-i18n'

export function HistoryDropdown({
  folder,
  currentId,
  title,
  version,
  disabled,
  onOpen,
}: {
  folder: string | null
  currentId: string
  title: string
  version: number
  disabled: boolean
  onOpen(id: string): Promise<void>
}) {
  const { s } = useSidebarText()
  const [rows, setRows] = useState<ConversationSummary[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    void (async () => {
      let offset = 0,
        total = Infinity
      const result: ConversationSummary[] = []
      while (offset < total) {
        const page = await window.nawaHistory.list({ folder, offset })
        if (!live) return
        result.push(...page.conversations)
        total = page.total
        if (!page.conversations.length) break
        offset += page.conversations.length
      }
      if (live) setRows([...new Map(result.map((row) => [row.id, row])).values()])
    })()
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [folder, version])
  const rowLabel = (row: ConversationSummary) =>
    `${row.title} — ${new Date(row.updatedAt).toLocaleString()}`
  const selected = rows.find((row) => row.id === currentId)
  return (
    <div>
      <label className="nawa-history-dropdown">
        <ChatConversationSelector
          label={s('Directory conversation history')}
          title={selected ? rowLabel(selected) : title}
          value={currentId}
          disabled={disabled || (loading && !rows.length)}
          onSelect={(id) => {
            if (id !== currentId) void onOpen(id).catch((cause) => setError(String(cause)))
          }}
          options={[
            ...(!rows.some((row) => row.id === currentId) ? [{ id: currentId, title }] : []),
            ...rows.map((row) => ({ id: row.id, title: row.title })),
          ]}
        />
      </label>
      {error && (
        <div className="ws-chat-notice" role="alert">
          {s('History:')} {error}
        </div>
      )}
    </div>
  )
}
