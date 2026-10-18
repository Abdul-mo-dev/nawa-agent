import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import { ChatMessageActions, CHAT_LABELS } from './ChatMessageActions'
import { ChatConversationSelector } from './ChatPanelHeader'
import {
  exportConversation,
  isFinalAnswer,
  questionIndex,
  turnEnd,
  type ConversationMessage,
} from './conversation'

interface Message extends ConversationMessage {
  id?: string | undefined
  streaming?: boolean | undefined
  undelivered?: boolean | undefined
  isError?: boolean | undefined
  error?: string | undefined
  instruction?: string | undefined
  tools?:
    | readonly { summary: string; isError?: boolean | undefined; mutated?: boolean | undefined }[]
    | undefined
}
interface Version<T> {
  id: string
  parent?: string
  sourceMessageId?: string | undefined
  kind?: 'edit' | 'retry' | 'regenerate' | 'delete'
  explanationOnly?: boolean
  label: string
  messages: T[]
  draft: string
}
interface Chat<T> {
  id: string
  title: string
  source?: string
  actions?: Array<{ id: string; summary: string }>
  archived?: boolean
  trashed?: boolean
  active: string
  versions: Version<T>[]
}
interface Session<T> {
  schema: 1
  revision: number
  active: string
  chats: Chat<T>[]
}
type Loop = {
  reset(): void
  restore(messages: ConversationMessage[]): void
  prepareAnswerRegeneration(answer: string): void
}
const storageKey = (key: string) => `nawa.editor-conversations:v1:${key}`
const newId = () => crypto.randomUUID()
interface NativeStore {
  loadManagedConversation?(args: {
    projectId: string
    chatId: string
  }): Promise<{ revision: number; state: unknown } | null>
  saveManagedConversation?(args: {
    projectId: string
    chatId: string
    revision: number
    state: unknown
  }): Promise<{ revision: number }>
}

/** Shared editor adapter. Legacy project logs remain intact; managed paths take precedence on reopen. */
export function useEditorConversations<T extends Message>(args: {
  messages: readonly T[]
  draft: string
  busy: boolean
  lang: Lang
  getKey(): string | null
  replace(messages: T[]): void
  setDraft(text: string): void
  loop(): Loop | null
  send(message: T, text: string, displayText: string): void
  beforeSwitch(): void
}) {
  const latest = useRef(args)
  latest.current = args
  const [session, setSession] = useState<Session<T> | null>(null)
  const working = useRef<Session<T> | null>(null),
    boundKey = useRef<string | null>(null)
  const [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const pendingNative = useRef(0)
  const [view, setView] = useState<'active' | 'archived' | 'trash'>('active')
  const [rename, setRename] = useState<string | null>(null),
    [name, setName] = useState('')
  const [purge, setPurge] = useState<string | null>(null),
    [deleted, setDeleted] = useState<string | null>(null)
  const ids = useRef(new WeakMap<object, string>())
  const nativeLoads = useRef(
    new Map<string, Promise<{ revision: number; state: unknown } | null>>(),
  )
  const nativeRevisions = useRef(new Map<string, number>())
  const nativeContent = useRef(new Map<string, string>())
  const nativeQueue = useRef(Promise.resolve())
  const labels = CHAT_LABELS[args.lang]
  const nativeApi = () => (window as unknown as { projectApi?: NativeStore }).projectApi
  const nativeIds = (key: string) => {
    const [projectId, chatId] = key.split(':')
    return { projectId: projectId!, chatId: chatId! }
  }
  const loadNative = (key: string) => {
    let pending = nativeLoads.current.get(key)
    if (!pending) {
      pending = (nativeApi()?.loadManagedConversation?.(nativeIds(key)) ?? Promise.resolve(null))
        .then((value) => {
          nativeRevisions.current.set(key, value?.revision ?? 0)
          return value
        })
        .catch((cause) => {
          nativeLoads.current.delete(key)
          throw cause
        })
      nativeLoads.current.set(key, pending)
    }
    return pending
  }
  const saveNative = (document: Session<T>, key: string) => {
    const api = nativeApi()
    if (!api?.saveManagedConversation) return
    const json = JSON.stringify(document)
    if (nativeContent.current.get(key) === json) return
    nativeContent.current.set(key, json)
    pendingNative.current++
    setSaving(true)
    nativeQueue.current = nativeQueue.current
      .then(async () => {
        const stored = await loadNative(key)
        if (stored && (stored.state as Session<T>).revision > document.revision)
          throw new Error(
            'A newer conversation is saved in another window. Reopen the file before editing history.',
          )
        const result = await api.saveManagedConversation!({
          ...nativeIds(key),
          revision: nativeRevisions.current.get(key) ?? 0,
          state: document,
        })
        nativeRevisions.current.set(key, result.revision)
        setError('')
      })
      .catch((cause) => {
        nativeContent.current.delete(key)
        setError(cause instanceof Error ? cause.message : labels.failed)
      })
      .finally(() => {
        pendingNative.current--
        if (!pendingNative.current) setSaving(false)
      })
  }
  const snapshot = (messages: readonly T[]): T[] =>
    messages.map((message) => {
      let id = message.id ?? ids.current.get(message)
      if (!id) {
        id = newId()
        ids.current.set(message, id)
      }
      // Document undo handles belong to the live file state and cannot travel between chat paths.
      return JSON.parse(
        JSON.stringify({ ...message, id }, (key, value) =>
          ['snapshot', 'snapshotId', 'autoApplied', 'rollback', 'plan'].includes(key)
            ? undefined
            : value,
        ),
      ) as T
    })
  const capture = (document: Session<T>): Session<T> => ({
    ...document,
    chats: document.chats.map((chat) =>
      chat.id !== document.active
        ? chat
        : {
            ...chat,
            title:
              chat.title === labels.newChat
                ? latest.current.messages
                    .find((message) => message.role === 'user')
                    ?.text.trim()
                    .slice(0, 100) || chat.title
                : chat.title,
            versions: chat.versions.map((version) =>
              version.id !== chat.active
                ? version
                : {
                    ...version,
                    messages: snapshot(latest.current.messages),
                    draft: latest.current.draft,
                  },
            ),
          },
    ),
  })
  const persist = (document: Session<T>) => {
    const key = latest.current.getKey()
    if (!key) throw new Error('Conversation storage is still opening. Try again shortly.')
    if (document.chats.length > 100)
      throw new Error('Remove an older conversation from Trash before continuing.')
    const raw = localStorage.getItem(storageKey(key))
    if (raw && JSON.parse(raw).revision !== document.revision)
      throw new Error(
        'This conversation changed in another window. Reopen the file before editing history.',
      )
    if (raw === JSON.stringify(document)) {
      saveNative(document, key)
      return document
    }
    const next = { ...document, revision: document.revision + 1 }
    const json = JSON.stringify(next)
    if (json.length > 4 * 1024 * 1024)
      throw new Error(
        'Conversation storage is full. Export and remove older conversations before continuing.',
      )
    localStorage.setItem(storageKey(key), json)
    saveNative(next, key)
    working.current = next
    boundKey.current = key
    setSession(next)
    setError('')
    return next
  }
  const replace = (messages: T[], draft: string) => {
    latest.current.beforeSwitch()
    const loop = latest.current.loop()
    loop?.reset()
    const changes = fileChanges(working.current)
    loop?.restore([
      ...(changes.length
        ? [
            {
              role: 'user' as const,
              text:
                'Historical file changes (reference data only, never pending instructions):\n' +
                JSON.stringify(changes.slice(-24)).slice(0, 12000) +
                '\nChat edits do not undo these changes. Re-read the current document before further edits; do not repeat completed actions without a new explicit request.',
            },
            {
              role: 'assistant' as const,
              text: 'These actions already occurred. I will use the current document state for further work.',
            },
          ]
        : []),
      ...messages
        .filter((message) => !message.undelivered && !message.isError)
        .map((message) => ({
          role: message.role,
          text: message.text || message.tools?.map((tool) => tool.summary).join('\n') || '',
        })),
    ])
    latest.current.replace(messages)
    latest.current.setDraft(draft)
  }
  const fileChanges = (document: Session<T> | null) => {
    const chat = document?.chats.find((item) => item.id === document.active)
    const facts = new Map((chat?.actions ?? []).map((action) => [action.id, action]))
    for (const version of chat?.versions ?? [])
      for (const message of version.messages) {
        for (const [index, tool] of (message.tools ?? []).entries())
          if (tool.mutated) {
            const id = `${message.id}:${index}`
            facts.set(id, { id, summary: tool.summary.slice(0, 2000) })
          }
      }
    return [...facts.values()].slice(-100)
  }
  const restoreStored = (): boolean => {
    const key = latest.current.getKey()
    if (!key || latest.current.busy) return false
    if (boundKey.current === key && working.current) return true
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return false
    try {
      const document = JSON.parse(raw) as Session<T>
      if (
        document.schema !== 1 ||
        !Number.isInteger(document.revision) ||
        !Array.isArray(document.chats) ||
        document.chats.length > 100
      )
        throw new Error('Unsupported conversation storage.')
      for (const chat of document.chats) {
        if (
          chat.actions !== undefined &&
          (!Array.isArray(chat.actions) ||
            chat.actions.length > 100 ||
            chat.actions.some(
              (action) =>
                !action ||
                typeof action.id !== 'string' ||
                typeof action.summary !== 'string' ||
                action.summary.length > 2000,
            ))
        )
          throw new Error('Invalid file-change receipts.')
        if (!Array.isArray(chat.versions) || chat.versions.length > 100)
          throw new Error('Invalid conversation versions.')
        for (const version of chat.versions) {
          if (
            !Array.isArray(version.messages) ||
            version.messages.some(
              (message) =>
                !message ||
                !['user', 'assistant'].includes(message.role) ||
                typeof message.text !== 'string',
            )
          )
            throw new Error('Invalid saved messages.')
          version.messages = version.messages.map((message) => ({
            ...message,
            streaming: false,
            ...(message.tools
              ? {
                  tools: message.tools.map((tool) => ({
                    ...tool,
                    running: false,
                    ...((tool as { running?: boolean }).running ? { isError: true } : {}),
                  })),
                }
              : {}),
            ...(message.streaming
              ? { isError: true, error: 'Response was interrupted. Try again.' }
              : {}),
          }))
        }
      }
      const chat = document.chats.find((item) => item.id === document.active && !item.trashed)
      const version = chat?.versions.find((item) => item.id === chat.active)
      if (!chat || !version) throw new Error('Saved conversation is unavailable.')
      working.current = document
      boundKey.current = key
      setSession(document)
      replace(version.messages, version.draft)
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed)
      return true
    }
  }
  const restorePersistent = async () => {
    const key = latest.current.getKey()
    if (!key) return false
    try {
      const stored = await loadNative(key)
      const raw = localStorage.getItem(storageKey(key))
      const journal = raw ? (JSON.parse(raw) as Session<T>) : null
      const durable = stored?.state as Session<T> | undefined
      if (durable && (!journal || durable.revision > journal.revision))
        localStorage.setItem(storageKey(key), JSON.stringify(durable))
      const restored = restoreStored()
      if (restored && working.current) saveNative(working.current, key)
      return restored
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed)
      return restoreStored()
    }
  }
  const ensure = (checkpoint = false): Session<T> => {
    if (latest.current.busy && !checkpoint)
      throw new Error('Stop the current response before changing conversation history.')
    const key = latest.current.getKey()
    if (boundKey.current !== key) {
      working.current = null
      restoreStored()
    }
    if (working.current) return capture(working.current)
    const id = newId(),
      version = newId()
    return {
      schema: 1,
      revision: 0,
      active: id,
      chats: [
        {
          id,
          title:
            latest.current.messages
              .find((message) => message.role === 'user')
              ?.text.trim()
              .slice(0, 100) || labels.newChat,
          active: version,
          versions: [
            {
              id: version,
              label: labels.original,
              messages: snapshot(latest.current.messages),
              draft: latest.current.draft,
            },
          ],
        },
      ],
    }
  }
  const attempt = (work: () => void) => {
    try {
      work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed)
    }
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (latest.current.busy && latest.current.getKey())
        attempt(() => {
          persist(ensure(true))
        })
    }, 750)
    const flush = () => {
      try {
        if (!working.current || latest.current.getKey() !== boundKey.current) return
        const document = capture(working.current),
          key = storageKey(boundKey.current!)
        const current = localStorage.getItem(key)
        if (current && JSON.parse(current).revision !== document.revision) return
        const json = JSON.stringify({ ...document, revision: document.revision + 1 })
        if (json.length <= 4 * 1024 * 1024) {
          localStorage.setItem(key, json)
          working.current = JSON.parse(json)
          saveNative(working.current!, boundKey.current!)
        }
      } catch {
        /* The live panel reports storage errors during checkpoints. */
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', flush)
      flush()
    }
    // Checkpoints read the current adapter through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (args.busy) return
    const timer = window.setTimeout(
      () =>
        attempt(() => {
          const key = latest.current.getKey()
          if (!key) return
          if (boundKey.current !== key && restoreStored()) return
          persist(ensure())
        }),
      500,
    )
    return () => clearTimeout(timer)
    // Only settled transcript/draft changes schedule a checkpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.messages, args.draft, args.busy])
  const revise = (
    index: number,
    kind: 'edit' | 'retry' | 'regenerate' | 'delete',
    text?: string,
  ) => {
    const document = ensure(),
      chat = document.chats.find((item) => item.id === document.active)!
    const start = questionIndex(latest.current.messages, index),
      user = latest.current.messages[start]
    if (!user) throw new Error('Question no longer exists.')
    if (chat.versions.length >= 100)
      throw new Error('Branch into a new chat before creating more versions.')
    const messages = snapshot(latest.current.messages.slice(0, start)),
      id = newId()
    const answer = latest.current.messages
      .slice(start + 1, turnEnd(latest.current.messages, start))
      .filter((message) => message.role === 'assistant')
      .map((message) => message.text)
      .join('\n\n')
    const hasChanges = latest.current.messages
      .slice(start + 1, turnEnd(latest.current.messages, start))
      .some((message) => (message.tools?.length ?? 0) > 0)
    const draft = kind === 'delete' ? latest.current.draft : (text ?? user.text)
    const next = {
      ...chat,
      active: id,
      versions: [
        ...chat.versions,
        {
          id,
          parent: chat.active,
          sourceMessageId: snapshot([user])[0]?.id,
          kind,
          explanationOnly: kind === 'regenerate' || (kind === 'retry' && hasChanges),
          label:
            kind === 'edit'
              ? labels.edit
              : kind === 'retry'
                ? labels.retry
                : kind === 'regenerate'
                  ? labels.regenerate
                  : labels.remove,
          messages,
          draft,
        },
      ],
    }
    persist({
      ...document,
      chats: document.chats.map((item) => (item.id === chat.id ? next : item)),
    })
    replace(messages, draft)
    if (kind !== 'delete') {
      if (kind === 'regenerate' || (kind === 'retry' && hasChanges))
        latest.current.loop()?.prepareAnswerRegeneration(answer)
      latest.current.send(user, text ?? user.instruction ?? user.text, text ?? user.text)
    }
  }
  const switchChat = (chatId: string, versionId?: string) => {
    const document = ensure(),
      chat = document.chats.find((item) => item.id === chatId && !item.trashed)
    const version = chat?.versions.find((item) => item.id === (versionId ?? chat.active))
    if (!chat || !version) throw new Error('Conversation no longer exists.')
    persist({
      ...document,
      active: chat.id,
      chats: document.chats.map((item) =>
        item.id === chat.id ? { ...item, active: version.id } : item,
      ),
    })
    replace(version.messages, version.draft)
    setOpen(false)
  }
  const newChat = () => {
    const document = ensure(),
      id = newId(),
      version = newId()
    if (document.chats.length >= 100)
      throw new Error('Export and remove an older conversation before creating another.')
    persist({
      ...document,
      active: id,
      chats: [
        ...document.chats,
        {
          id,
          title: labels.newChat,
          active: version,
          versions: [
            { id: version, label: labels.original, messages: [], draft: latest.current.draft },
          ],
        },
      ],
    })
    replace([], latest.current.draft)
  }
  const actions = (index: number, renderMessage?: (editor: ReactNode) => ReactNode) => {
    const message = args.messages[index]
    if (!message) return null
    const hasReply = args.messages
      .slice(index + 1, turnEnd(args.messages, index))
      .some(
        (item) =>
          item.role === 'assistant' && !!(item.text.trim() || item.tools?.length || item.error),
      )
    const exchangeActions = message.role === 'assistant' || !hasReply
    const finalAnswer = isFinalAnswer(
      args.messages,
      index,
      (item) => !!(item.text.trim() || item.tools?.length || item.error),
    )
    if (
      message.role === 'assistant' &&
      (!finalAnswer || (args.busy && turnEnd(args.messages, index) === args.messages.length))
    )
      return null
    return (
      <ChatMessageActions
        key={index}
        renderMessage={renderMessage}
        text={message.text}
        lang={args.lang}
        disabled={args.busy}
        deleteCount={
          args.messages
            .slice(questionIndex(args.messages, index))
            .filter((item) => item.role === 'user').length
        }
        onEdit={message.role === 'user' ? (text) => revise(index, 'edit', text) : undefined}
        onRetry={
          message.role === 'user' &&
          (message.undelivered ||
            args.messages
              .slice(index + 1, turnEnd(args.messages, index))
              .some((item) => item.error || item.isError))
            ? () => revise(index, 'retry')
            : undefined
        }
        onRegenerate={
          message.role === 'assistant' &&
          !!message.text.trim() &&
          !message.isError &&
          !message.error &&
          finalAnswer
            ? () => revise(index, 'regenerate')
            : undefined
        }
        onDelete={
          exchangeActions && questionIndex(args.messages, index) >= 0
            ? () => revise(index, 'delete')
            : undefined
        }
        onBranch={
          !exchangeActions
            ? undefined
            : () => {
                const document = ensure(),
                  chat = document.chats.find((item) => item.id === document.active)!,
                  id = newId(),
                  version = newId()
                if (document.chats.length >= 100) throw new Error('Conversation storage is full.')
                const messages = snapshot(
                  args.messages.slice(
                    0,
                    turnEnd(args.messages, index) < 0 ? index + 1 : turnEnd(args.messages, index),
                  ),
                )
                persist({
                  ...document,
                  active: id,
                  chats: [
                    ...document.chats,
                    {
                      id,
                      title: `${chat.title} (branch)`,
                      source: chat.id,
                      actions: fileChanges(document),
                      active: version,
                      versions: [{ id: version, label: labels.original, messages, draft: '' }],
                    },
                  ],
                })
                replace(messages, '')
              }
        }
      />
    )
  }
  const updateChat = (id: string, change: (chat: Chat<T>) => Chat<T> | null) => {
    let document = ensure()
    document = {
      ...document,
      chats: document.chats.flatMap((chat) =>
        chat.id === id ? [change(chat)].filter((item): item is Chat<T> => !!item) : [chat],
      ),
    }
    if (!document.chats.some((chat) => chat.id === document.active && !chat.trashed)) {
      const next = document.chats.find((chat) => !chat.trashed && !chat.archived)
      if (next) document.active = next.id
      else {
        const cid = newId(),
          vid = newId()
        document.active = cid
        document.chats.push({
          id: cid,
          title: labels.newChat,
          active: vid,
          versions: [{ id: vid, label: labels.original, messages: [], draft: '' }],
        })
      }
    }
    persist(document)
    const active = document.chats.find((chat) => chat.id === document.active)!,
      version = active.versions.find((item) => item.id === active.active)!
    replace(version.messages, version.draft)
  }
  const active = session?.chats.find((chat) => chat.id === session.active),
    version = active?.versions.find((item) => item.id === active.active)
  const toolbar = (
    <>
      <div className="chat-session-toolbar">
        <div className="nawa-chat-conversation-row">
          <ChatConversationSelector
            label={labels.history}
            value={active?.id ?? ''}
            title={active?.title ?? labels.newChat}
            disabled={args.busy}
            options={
              session?.chats
                .filter((chat) => !chat.trashed && (!chat.archived || chat.id === session.active))
                .map((chat) => ({ id: chat.id, title: chat.title })) ?? [
                { id: '', title: labels.newChat },
              ]
            }
            onSelect={(id) => attempt(() => switchChat(id))}
          />
          <button
            type="button"
            disabled={args.busy}
            aria-expanded={open}
            onClick={() =>
              attempt(() => {
                persist(ensure())
                setOpen(!open)
              })
            }
          >
            {labels.history}
          </button>
        </div>
        <span role="status">
          {error
            ? args.lang === 'ar'
              ? 'يتطلب الحفظ الانتباه'
              : args.lang === 'ja'
                ? '保存を確認してください'
                : 'Save needs attention'
            : saving
              ? args.lang === 'ar'
                ? 'جارٍ الحفظ…'
                : args.lang === 'ja'
                  ? '保存中…'
                  : 'Saving…'
              : args.lang === 'ar'
                ? 'محفوظ محلياً'
                : args.lang === 'ja'
                  ? 'ローカルに保存済み'
                  : 'Saved locally'}
        </span>
        {active && active.versions.length > 1 && (
          <select
            aria-label={labels.versions}
            value={active.active}
            disabled={args.busy}
            onChange={(event) => attempt(() => switchChat(active.id, event.target.value))}
          >
            {active.versions.map((item, index) => (
              <option key={item.id} value={item.id}>
                {index + 1} / {active.versions.length} · {item.label}
              </option>
            ))}
          </select>
        )}
        {version?.parent && (
          <button
            type="button"
            disabled={args.busy}
            onClick={() => attempt(() => switchChat(active!.id, version.parent))}
          >
            {labels.undoChat}
          </button>
        )}
        {active?.source && (
          <button
            type="button"
            disabled={args.busy}
            onClick={() => attempt(() => switchChat(active.source!))}
          >
            {labels.original} · {labels.currentFiles}
          </button>
        )}
        <button
          type="button"
          onClick={() => exportConversation(active?.title ?? labels.newChat, args.messages, 'md')}
        >
          {labels.export}
        </button>
      </div>
      {error && (
        <p className="chat-message-edit" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() =>
              attempt(() => {
                const key = latest.current.getKey()
                if (key) nativeContent.current.delete(key)
                persist(ensure(true))
              })
            }
          >
            {labels.retry}
          </button>
        </p>
      )}
      {version?.explanationOnly && (
        <span className="chat-session-source">{labels.explanation}</span>
      )}
      {fileChanges(session).length > 0 && (
        <details className="chat-session-source">
          <summary>
            {labels.fileChanges} · {fileChanges(session).length}
          </summary>
          <ul>
            {fileChanges(session).map((action) => (
              <li key={action.id}>{action.summary}</li>
            ))}
          </ul>
        </details>
      )}
      {open && (
        <div className="chat-history-panel chat-message-edit">
          <input
            type="search"
            aria-label={labels.search}
            placeholder={labels.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label={labels.history}
            value={view}
            onChange={(event) => setView(event.target.value as typeof view)}
          >
            <option value="active">{labels.active}</option>
            <option value="archived">{labels.archived}</option>
            <option value="trash">{labels.trash}</option>
          </select>
          {deleted && (
            <button
              type="button"
              disabled={args.busy}
              onClick={() =>
                attempt(() => {
                  updateChat(deleted, (chat) => ({ ...chat, trashed: false }))
                  setDeleted(null)
                })
              }
            >
              {labels.undo}
            </button>
          )}
          {session?.chats
            .filter(
              (chat) =>
                (view === 'trash'
                  ? chat.trashed
                  : !chat.trashed && (view === 'archived' ? chat.archived : !chat.archived)) &&
                `${chat.title}\n${chat.versions.map((item) => item.messages.map((message) => message.text).join('\n')).join('\n')}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
            )
            .map((chat) => (
              <div className="chat-history-row" key={chat.id}>
                <button
                  type="button"
                  disabled={args.busy || chat.trashed}
                  onClick={() => attempt(() => switchChat(chat.id))}
                >
                  {chat.title}
                </button>
                {chat.trashed ? (
                  <>
                    <button
                      type="button"
                      disabled={args.busy}
                      onClick={() =>
                        attempt(() => updateChat(chat.id, (item) => ({ ...item, trashed: false })))
                      }
                    >
                      {labels.restore}
                    </button>
                    <button type="button" disabled={args.busy} onClick={() => setPurge(chat.id)}>
                      {labels.permanent}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={args.busy}
                      onClick={() => {
                        setRename(chat.id)
                        setName(chat.title)
                      }}
                    >
                      {labels.rename}
                    </button>
                    <button
                      type="button"
                      disabled={args.busy}
                      onClick={() =>
                        attempt(() =>
                          updateChat(chat.id, (item) => ({ ...item, archived: !item.archived })),
                        )
                      }
                    >
                      {chat.archived ? labels.restore : labels.archive}
                    </button>
                    <button
                      type="button"
                      disabled={args.busy}
                      onClick={() =>
                        attempt(() => {
                          updateChat(chat.id, (item) => ({ ...item, trashed: true }))
                          setDeleted(chat.id)
                        })
                      }
                    >
                      {labels.trash}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        exportConversation(
                          chat.title,
                          chat.versions.find((item) => item.id === chat.active)!.messages,
                          'json',
                          chat,
                        )
                      }
                    >
                      {labels.exportJson}
                    </button>
                  </>
                )}
                {rename === chat.id && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      attempt(() => {
                        updateChat(chat.id, (item) => ({ ...item, title: name.trim() }))
                        setRename(null)
                      })
                    }}
                  >
                    <input
                      aria-label={labels.title}
                      value={name}
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <button type="submit" disabled={!name.trim() || args.busy}>
                      {labels.saveTitle}
                    </button>
                    <button type="button" onClick={() => setRename(null)}>
                      {labels.cancel}
                    </button>
                  </form>
                )}
                {purge === chat.id && (
                  <div role="group" aria-label={labels.permanent}>
                    <p>{labels.permanentHint}</p>
                    <button type="button" onClick={() => setPurge(null)}>
                      {labels.cancel}
                    </button>
                    <button
                      type="button"
                      disabled={args.busy}
                      onClick={() =>
                        attempt(() => {
                          updateChat(chat.id, () => null)
                          setPurge(null)
                        })
                      }
                    >
                      {labels.permanent}
                    </button>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </>
  )
  const rebind = () => {
    const key = latest.current.getKey()
    if (!key || key === boundKey.current || !working.current) return
    const document = capture(working.current),
      raw = localStorage.getItem(storageKey(key))
    const target = raw ? (JSON.parse(raw) as Session<T>) : null
    persist({
      ...document,
      revision: target?.revision ?? document.revision,
      chats: [
        ...(target?.chats.filter((chat) => !document.chats.some((item) => item.id === chat.id)) ??
          []),
        ...document.chats,
      ],
    })
  }
  return {
    toolbar,
    actions,
    restoreStored,
    restorePersistent,
    rebind,
    newChat: () => {
      try {
        newChat()
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : labels.failed)
        return false
      }
    },
    retryAt: (index: number) => revise(index, 'retry'),
    retry: () => {
      const start = questionIndex(args.messages, args.messages.length - 1)
      if (start >= 0) revise(start, 'regenerate')
    },
  }
}
