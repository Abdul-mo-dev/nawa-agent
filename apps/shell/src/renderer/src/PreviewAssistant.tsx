import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AgentLoop, type AgentMessage } from '@genoffice/agent-core'
import {
  applyChatModel,
  agentPolicyOf,
  modelSupportsVision,
  type AiSettings,
} from '@genoffice/ai-provider/browser'
import { AiComposer, AiTypingIndicator, ChatModelPicker, Markdown } from '@genoffice/ui'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/chat-model-picker.css'
import type { ConversationRecord, HistoryMessage } from '../../shared/conversation-api'
import type { FilePreview } from '../../shared/file-preview'
import { aiLangDirective, useI18n } from './locale'
import { previewText } from './file-preview-labels'
import { createPreviewSkill } from './ai/preview-skill'
import { createShellTransport } from './ai/transport'
import {
  ConversationBuffer,
  flushDetachedBuffers,
  initializeHistory,
  retainUntilSaved,
} from './history/conversation-buffer'
import { NawaIcon } from './explorer/Icons'
import './directory-chat.css'

export function PreviewAssistant({ preview }: { preview: FilePreview }) {
  const { lang } = useI18n(),
    t = previewText(lang)
  const [record, setRecord] = useState<ConversationRecord | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setRecord(null)
    setError('')
    void (async () => {
      await flushDetachedBuffers()
      await initializeHistory()
      // A file path is an isolated history key; no folder scanning or access is granted.
      const list = await window.nawaHistory.list({ folder: preview.path })
      const next = list.conversations[0]
        ? await window.nawaHistory.get(list.conversations[0].id)
        : await window.nawaHistory.create({ folder: preview.path, folderName: preview.name })
      if (live) setRecord(next)
    })().catch((cause) => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      live = false
    }
  }, [preview.path, preview.name, attempt])
  return record ? (
    <PreviewConversation
      key={record.id}
      preview={preview}
      record={record}
      onNew={async () => {
        const next = await window.nawaHistory.create({
          folder: preview.path,
          folderName: preview.name,
        })
        setRecord(next)
      }}
    />
  ) : (
    <aside className="preview-assistant" aria-label={t.assistant}>
      <p role={error ? 'alert' : 'status'}>{error || t.loading}</p>
      {error && (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t.retry}
        </button>
      )}
    </aside>
  )
}

function PreviewConversation({
  preview,
  record,
  onNew,
}: {
  preview: FilePreview
  record: ConversationRecord
  onNew(): Promise<void>
}) {
  const { lang } = useI18n(),
    t = previewText(lang)
  const langRef = useRef(lang)
  langRef.current = lang
  const previewRef = useRef(preview)
  previewRef.current = preview
  const buffer = useMemo(() => new ConversationBuffer(record, window.nawaHistory), [record])
  const data = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [historyError, setHistoryError] = useState('')
  const loopRef = useRef<AgentLoop | null>(null)
  const settingsRef = useRef<AiSettings | null>(null)
  const visionRef = useRef(false)
  const modelRef = useRef('')
  const alive = useRef(true),
    generation = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const patchReply = (text: string, done = false, error = false) => {
    buffer.edit((current) => ({
      ...current,
      messages: current.messages.map((message, i) =>
        i === current.messages.length - 1 && message.role === 'assistant'
          ? { ...message, text, streaming: !done, error }
          : message,
      ),
    }))
  }
  const save = () => {
    void buffer.flush().catch((cause) => {
      if (alive.current) setHistoryError(String(cause))
    })
  }
  useEffect(() => {
    alive.current = true
    const timer = setInterval(() => {
      void buffer.saveOnce().catch((cause) => {
        if (alive.current) setHistoryError(String(cause))
      })
    }, 1500)
    return () => {
      // This ref is a request counter, not a captured DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      loopRef.current?.cancel()
      alive.current = false
      clearInterval(timer)
      buffer.edit((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
      }))
      retainUntilSaved(buffer)
    }
  }, [buffer])
  useEffect(() => {
    if (follow.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [data.messages, notice])
  const send = async () => {
    const question = buffer.getSnapshot().draft.trim()
    if (!question || busy) return
    const sequence = ++generation.current
    setBusy(true)
    setNotice('')
    follow.current = true
    try {
      const settings = applyChatModel(
        await window.aiOffice.getAiSettings(),
        buffer.getSnapshot().modelId,
      )
      if (!alive.current || sequence !== generation.current) return
      settingsRef.current = settings
      visionRef.current = modelSupportsVision(settings)
      const modelKey = `${buffer.getSnapshot().modelId}:${visionRef.current}`
      if (modelRef.current !== modelKey) {
        loopRef.current = null
        modelRef.current = modelKey
      }
      if (!loopRef.current) {
        const loop = new AgentLoop({
          transport: createShellTransport(() => settingsRef.current!),
          skill: createPreviewSkill(
            () => previewRef.current,
            (path, hash) => window.nawaFilePreview.recognizeText(path, hash),
            () => visionRef.current,
          ),
          ...agentPolicyOf(settings),
          maxTurns: Math.min(12, agentPolicyOf(settings).maxTurns),
          systemSuffix: () => aiLangDirective(langRef.current),
          events: {
            onText: (text) => {
              if (alive.current) patchReply(text)
            },
            onToolStart: () => {
              if (alive.current) setNotice(previewText(langRef.current).working)
            },
            onToolExecuted: ({ execution }) => {
              if (alive.current) setNotice(execution.isError ? execution.output : '')
            },
            onDone: (result) => {
              if (!alive.current) return
              patchReply(
                result.text || (result.cancelled ? '' : previewText(langRef.current).noReply),
                true,
              )
              setBusy(false)
              setNotice('')
              save()
            },
            onError: (error) => {
              if (alive.current) {
                patchReply(error, true, true)
                setBusy(false)
                setNotice('')
                save()
              }
            },
          },
        })
        loop.restore(
          buffer
            .getSnapshot()
            .messages.filter((message) => !message.error && !message.streaming)
            .map((message) => ({ role: message.role, text: message.text }) as AgentMessage),
        )
        loopRef.current = loop
      }
      const now = Date.now()
      buffer.edit((current) => ({
        ...current,
        draft: '',
        lastChatAt: now,
        messages: [
          ...current.messages,
          {
            id: crypto.randomUUID(),
            role: 'user',
            text: question,
            createdAt: now,
            snapshotHash: preview.sourceHash,
          },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '',
            createdAt: now,
            streaming: true,
            snapshotHash: preview.sourceHash,
          },
        ],
      }))
      const image = visionRef.current ? preview.visionImage : undefined
      loopRef.current.run(
        question,
        image
          ? [
              {
                mime: image.slice(5, image.indexOf(';')),
                base64: image.slice(image.indexOf(',') + 1),
              },
            ]
          : undefined,
      )
    } catch (cause) {
      if (!alive.current || sequence !== generation.current) return
      setNotice(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  const stop = () => {
    generation.current++
    loopRef.current?.cancel()
    setBusy(false)
    setNotice('')
    save()
  }
  return (
    <aside
      className="preview-assistant ws-chat workspace-chat-main"
      aria-label={t.assistant}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
    >
      <header className="preview-assistant-header">
        <NawaIcon size={22} />
        <strong>{t.assistant}</strong>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            save()
            void onNew().catch((cause) => setNotice(String(cause)))
          }}
        >
          {t.newChat}
        </button>
      </header>
      <div className="preview-assistant-file" title={preview.path}>
        {t.connected}: <bdi>{preview.name}</bdi>
      </div>
      <div
        className="ws-chat-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        <div className="ws-chat-log" role="log" aria-live="polite">
          {!data.messages.length && (
            <div className="ws-chat-empty">
              <h2>{t.empty}</h2>
              <p>{preview.image ? t.imageHelp : t.messageHelp}</p>
            </div>
          )}
          {data.messages.map((message: HistoryMessage) => (
            <div
              key={message.id}
              className={`ws-chat-msg ws-chat-${message.role}${message.error ? ' ws-chat-error' : ''}`}
              dir="auto"
            >
              {message.role === 'assistant' ? (
                message.text ? (
                  <Markdown text={message.text} />
                ) : message.streaming ? (
                  <AiTypingIndicator label={t.working} />
                ) : null
              ) : (
                message.text
              )}
            </div>
          ))}
        </div>
      </div>
      {notice && (
        <p className="preview-assistant-notice" role="status">
          {notice}
        </p>
      )}
      {historyError && (
        <p role="alert">
          {historyError}
          <button
            type="button"
            onClick={() => {
              setHistoryError('')
              save()
            }}
          >
            {t.retry}
          </button>
        </p>
      )}
      <div className="ws-chat-composer">
        <AiComposer
          value={data.draft}
          busy={busy}
          placeholder={t.ask}
          hintIdle=""
          hintBusy={t.working}
          sendLabel={t.send}
          stopLabel={t.stop}
          iconOnly
          onChange={(draft) => buffer.edit((current) => ({ ...current, draft }))}
          onSend={() => {
            void send()
          }}
          onStop={stop}
          footerStart={
            <ChatModelPicker
              loadSettings={() => window.aiOffice.getAiSettings()}
              initialId={data.modelId}
              storageKey={`nawa.preview-model:${preview.path}`}
              onChange={(modelId) =>
                buffer.edit((current) =>
                  current.modelId === modelId ? current : { ...current, modelId },
                )
              }
              disabled={busy}
            />
          }
        />
      </div>
    </aside>
  )
}
