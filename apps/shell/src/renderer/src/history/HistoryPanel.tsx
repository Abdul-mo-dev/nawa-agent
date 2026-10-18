import { useEffect, useState } from 'react'
import { CHAT_LABELS, exportConversation } from '@genoffice/ui'
import { useI18n } from '../locale'
import type { ConversationSummary } from '../../../shared/conversation-api'
import { useSidebarText } from '../explorer/sidebar-i18n'

export function HistoryPanel({
  folder,
  currentId,
  version,
  databasePath,
  onOpen,
  onRename,
  onDelete,
  onArchive,
  onRestore,
  onPurge,
  onClose,
  recentlyDeletedId,
}: {
  folder: string | null
  currentId: string
  version: number
  databasePath: string
  onOpen: (id: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onArchive: (id: string, archived: boolean) => Promise<void>
  onRestore: (id: string) => Promise<void>
  onPurge: (id: string) => Promise<void>
  onClose: () => void
  recentlyDeletedId?: string | null
}) {
  const { s } = useSidebarText()
  const { lang } = useI18n(),
    labels = CHAT_LABELS[lang]
  const [view, setView] = useState<'active' | 'archived' | 'trash'>('active')
  const [refresh, setRefresh] = useState(0)
  const [deletedId, setDeletedId] = useState<string | null>(recentlyDeletedId ?? null)
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
    const timer = setTimeout(
      () => {
        setLoading(true)
        void window.nawaHistory
          .list({ ...(allFolders ? {} : { folder }), query, offset, view })
          .then((result) => {
            if (!alive) return
            setRows((previous) =>
              offset
                ? [
                    ...previous,
                    ...result.conversations.filter(
                      (row) => !previous.some((old) => old.id === row.id),
                    ),
                  ]
                : result.conversations,
            )
            setTotal(result.total)
            setError(null)
          })
          .catch((cause) => {
            if (alive) setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (alive) setLoading(false)
          })
      },
      query ? 150 : 0,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [folder, allFolders, query, offset, version, view, refresh])
  const perform = async (work: () => Promise<void>) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await work()
      setRenameId(null)
      setDeleteId(null)
      setOffset(0)
      setRefresh((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="nawa-history-panel" aria-label={s('Conversation history')}>
      <div className="nawa-history-heading">
        <strong>{s('Conversation history')}</strong>
        <button type="button" className="ws-chat-close" onClick={onClose}>
          {s('Close history')}
        </button>
      </div>
      <div className="nawa-history-filters">
        <input
          type="search"
          aria-label={labels.search}
          placeholder={labels.search}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOffset(0)
          }}
        />
        <select
          aria-label={labels.history}
          value={view}
          onChange={(event) => {
            setView(event.target.value as typeof view)
            setOffset(0)
            setRows([])
            setDeleteId(null)
            setRenameId(null)
          }}
        >
          <option value="active">{labels.active}</option>
          <option value="archived">{labels.archived}</option>
          <option value="trash">{labels.trash}</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={allFolders}
            onChange={(event) => {
              setAllFolders(event.target.checked)
              setOffset(0)
            }}
          />{' '}
          {s('All folders')}
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {deletedId && (
        <div role="status">
          {labels.trash}{' '}
          <button
            type="button"
            className="ws-chat-close"
            disabled={pending}
            onClick={() =>
              void perform(async () => {
                await onRestore(deletedId)
                setDeletedId(null)
              })
            }
          >
            {labels.undo}
          </button>
        </div>
      )}
      <div className="nawa-history-rows" aria-busy={loading}>
        {!rows.length && !loading && <p>{s('No saved conversations here yet.')}</p>}
        {rows.map((row) => (
          <div
            className={`nawa-history-row${row.id === currentId ? ' is-active' : ''}`}
            key={row.id}
          >
            <button
              type="button"
              className="nawa-history-open"
              disabled={pending || view === 'trash'}
              aria-current={row.id === currentId ? 'true' : undefined}
              onClick={() => void perform(() => onOpen(row.id))}
            >
              <strong>{row.title}</strong>
              <span>
                {new Date(row.updatedAt).toLocaleString()} · {row.messageCount} {s('messages')}
              </span>
              {allFolders && (
                <span title={row.folder || 'Workspace'}>{row.folder || 'Workspace selection'}</span>
              )}
            </button>
            <div className="nawa-history-row-actions">
              {view === 'trash' ? (
                <>
                  <button
                    type="button"
                    className="ws-chat-close"
                    disabled={pending}
                    onClick={() => void perform(() => onRestore(row.id))}
                  >
                    {labels.restore}
                  </button>
                  <button
                    type="button"
                    className="ws-chat-close"
                    disabled={pending}
                    onClick={() => setDeleteId(row.id)}
                  >
                    {labels.permanent}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ws-chat-close"
                    disabled={pending}
                    onClick={() => {
                      setRenameId(row.id)
                      setTitle(row.title)
                      setDeleteId(null)
                    }}
                  >
                    {labels.rename}
                  </button>
                  <button
                    type="button"
                    className="ws-chat-close"
                    disabled={pending}
                    onClick={() => void perform(() => onArchive(row.id, view !== 'archived'))}
                  >
                    {view === 'archived' ? labels.restore : labels.archive}
                  </button>
                  <button
                    type="button"
                    className="ws-chat-close"
                    disabled={pending}
                    onClick={() =>
                      void perform(async () => {
                        await onDelete(row.id)
                        setDeletedId(row.id)
                      })
                    }
                  >
                    {labels.trash}
                  </button>
                  {(['md', 'json'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      className="ws-chat-close"
                      disabled={pending}
                      onClick={() =>
                        void perform(async () => {
                          const record = await window.nawaHistory.get(row.id)
                          exportConversation(
                            record.title,
                            record.messages,
                            format,
                            format === 'json' ? await window.nawaHistory.export(row.id) : undefined,
                          )
                        })
                      }
                    >
                      {format === 'md' ? labels.export : labels.exportJson}
                    </button>
                  ))}
                </>
              )}
            </div>
            {renameId === row.id && (
              <form
                className="nawa-history-inline"
                onSubmit={(event) => {
                  event.preventDefault()
                  void perform(() => onRename(row.id, title.trim()))
                }}
              >
                <input
                  autoFocus
                  aria-label={s('Conversation title')}
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <button type="submit" className="ws-chat-send" disabled={pending || !title.trim()}>
                  {s('Save title')}
                </button>
                <button type="button" className="ws-chat-close" onClick={() => setRenameId(null)}>
                  {s('Cancel')}
                </button>
              </form>
            )}
            {deleteId === row.id && (
              <div
                className="nawa-history-inline"
                role="group"
                aria-label={s('Delete conversation confirmation')}
              >
                <p>{labels.permanentHint}</p>
                <button type="button" className="ws-chat-close" onClick={() => setDeleteId(null)}>
                  {s('Cancel')}
                </button>
                <button
                  type="button"
                  className="ws-chat-send"
                  disabled={pending}
                  onClick={() => void perform(() => onPurge(row.id))}
                >
                  {labels.permanent}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {rows.length < total && (
        <button
          type="button"
          className="ws-chat-close"
          disabled={loading}
          onClick={() => setOffset(rows.length)}
        >
          {s('Load more conversations')}
        </button>
      )}
      <div className="nawa-history-storage">
        <span title={databasePath}>
          {s('Saved locally in SQLite ·')} {total} {s('conversations')}
        </span>
        <button
          type="button"
          className="ws-chat-close"
          onClick={() => void perform(() => window.nawaHistory.revealDatabase())}
        >
          {s('Show database')}
        </button>
      </div>
    </div>
  )
}
