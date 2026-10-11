import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentLoop, createKnowledgeBaseSkill, type AgentMessage } from '@genoffice/agent-core'
import {
  AiComposer,
  AiTypingIndicator,
  ChatModelPicker,
  createFileNav,
  Markdown,
} from '@genoffice/ui'
import { agentPolicyOf } from '@genoffice/ai-provider/browser'
import { useI18n } from './locale'
import { useSidebarText } from './explorer/sidebar-i18n'
import { createShellTransport } from './ai/transport'
import { loadKnowledgeBaseRequest } from './ai/knowledge-base-request'

/**
 * The home screen's knowledge-base ask panel: chat with the reader's starred
 * corpus without opening a document. First app-side consumer of the shell's
 * kb:* gateway — the loop, streaming and rendering reuse what every editor's
 * AI panel uses (AgentLoop + the shell transport + Markdown with a filenav
 * nav), so answers cite the folder and file they came from and clicking a
 * citation opens that file in the app that owns it.
 *
 * The conversation lives in memory only; it does not survive a restart (the
 * editor panels persist through project-store — wiring that here is a
 * deliberate later step, not an oversight).
 */

interface AskMessage {
  role: 'user' | 'assistant'
  text: string
  /** short labels of the tools this answer used, in order */
  toolNotes: string[]
  streaming?: boolean
  isError?: boolean
}

const MODEL_STORAGE_KEY = 'nawa:knowledge-base-chat-model'

export function KbAskPanel({
  onOpenPath,
}: {
  onOpenPath: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { s } = useSidebarText()
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [corpusCount, setCorpusCount] = useState<number | null>(null)
  const [modelId, setModelId] = useState(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY) || ''
    } catch {
      return ''
    }
  })
  const loopRef = useRef<AgentLoop<unknown> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const history = useRef<{ corpusKey: string; messages: readonly AgentMessage[] } | null>(null)
  const loadSettings = useCallback(() => window.aiOffice.getAiSettings(), [])

  useEffect(() => {
    alive.current = true
    const initialGeneration = generation.current
    // one corpus snapshot per mount; sends refresh it again (see ask()).
    // A bridge without the kb channel (defensive: the shell always exposes
    // it) leaves the corpus empty, which keeps the panel on its guidance.
    if (typeof window.aiOffice?.kbList !== 'function') {
      setCorpusCount(0)
    } else
      void window.aiOffice
        .kbList()
        .then((files) => {
          if (alive.current && generation.current === initialGeneration)
            setCorpusCount(files.length)
        })
        .catch(() => {
          if (alive.current && generation.current === initialGeneration) setCorpusCount(0)
        })
    return () => {
      alive.current = false
      generation.current++
      busyRef.current = false
      loopRef.current?.reset()
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const patchLast = (
    patch: Partial<AskMessage> | ((last: AskMessage) => Partial<AskMessage>),
  ): void => {
    setMessages((prev) => {
      if (prev.length === 0 || prev[prev.length - 1]!.role !== 'assistant') return prev
      const last = prev[prev.length - 1]!
      const delta = typeof patch === 'function' ? patch(last) : patch
      return [...prev.slice(0, -1), { ...last, ...delta }]
    })
  }

  const finishLast = (): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]!
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
    busyRef.current = false
    setBusy(false)
  }

  const ask = async (): Promise<void> => {
    const instruction = draft.trim()
    if (!instruction || busyRef.current || !alive.current) return
    const requestGeneration = ++generation.current
    const current = () => alive.current && generation.current === requestGeneration
    busyRef.current = true
    setDraft('')
    setBusy(true)
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: instruction, toolNotes: [] },
      { role: 'assistant', text: '', toolNotes: [], streaming: true },
    ])
    try {
      // Both operations must finish before building the prompt; rejected refreshes
      // must never reuse an old corpus or send with null/stale provider settings.
      const prepared = await loadKnowledgeBaseRequest(window.aiOffice, modelId)
      if (!current()) return
      setCorpusCount(prepared.corpus.length)
      if (prepared.corpus.length === 0) {
        patchLast({ text: t('askEmptyCorpus') })
        history.current = null
        finishLast()
        return
      }
      const loop = new AgentLoop({
        transport: createShellTransport(() => prepared.settings),
        ...agentPolicyOf(prepared.settings),
        skill: createKnowledgeBaseSkill({
          listFiles: () => prepared.corpus,
          search: (query, limit) => window.aiOffice.kbSearch({ q: query, limit }),
          read: (path, offset) => window.aiOffice.kbRead(path, offset),
        }),
        systemSuffix: () =>
          '\nEarlier answers are conversation reference only. Search and read current sources again before using file facts in this answer.',
        events: {
          onText: (text) => {
            if (current()) patchLast({ text })
          },
          onToolStart: (call) => {
            if (current())
              patchLast((last) => ({
                toolNotes: [
                  ...last.toolNotes,
                  call.name === 'search_knowledge_base' ? t('askToolSearch') : t('askToolRead'),
                ],
              }))
          },
          onDone: (result) => {
            if (!current()) return
            if (!result.cancelled && !result.turnLimit && !result.truncated && result.text.trim())
              history.current = {
                corpusKey: prepared.corpusKey,
                messages: structuredClone(loop.messages),
              }
            if (result.turnLimit || result.truncated)
              patchLast((last) => ({
                text: `${last.text}\n\n${s('The model reached its output or tool-turn limit. This answer is incomplete.')}`.trim(),
                isError: true,
              }))
            else if (!result.text.trim())
              patchLast({
                text: result.cancelled ? s('Stopped.') : t('askUnknownError'),
                isError: !result.cancelled,
              })
            finishLast()
          },
          onError: (error) => {
            if (!current()) return
            patchLast((last) => ({
              text: [last.text, error].filter(Boolean).join('\n\n'),
              isError: true,
            }))
            finishLast()
          },
        },
      })
      if (history.current?.corpusKey === prepared.corpusKey) loop.restore(history.current.messages)
      else history.current = null
      loopRef.current = loop
      loop.run(instruction)
    } catch (cause) {
      if (!current()) return
      patchLast({
        text: cause instanceof Error ? cause.message : t('askUnknownError'),
        isError: true,
      })
      finishLast()
    }
  }

  const fileNav = createFileNav((path) => onOpenPath(path))

  return (
    <div className="kb-ask">
      <div className="kb-ask-head">
        <h2>{t('askTitle')}</h2>
        <p className="kb-ask-sub">
          {corpusCount === null
            ? ''
            : corpusCount === 0
              ? t('askEmptyCorpusHint')
              : t('askCorpusCount', { n: String(corpusCount) })}
        </p>
      </div>
      <div className="kb-ask-thread" ref={scrollRef}>
        {messages.length === 0 && corpusCount !== null && corpusCount > 0 && (
          <p className="kb-ask-hint">{t('askIntro')}</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`kb-ask-msg kb-ask-${m.role}${m.isError ? ' kb-ask-error' : ''}`}>
            {m.role === 'assistant' && m.toolNotes.length > 0 && (
              <div className="kb-ask-tools">
                {m.toolNotes.map((note, j) => (
                  <span key={j} className="kb-ask-tool-note">
                    {note}
                    {m.streaming && j === m.toolNotes.length - 1 ? '…' : ''}
                  </span>
                ))}
              </div>
            )}
            {m.text ? (
              m.role === 'assistant' ? (
                <Markdown text={m.text} navs={[fileNav]} />
              ) : (
                m.text
              )
            ) : m.streaming ? (
              <AiTypingIndicator label={t('askHintBusy')} />
            ) : null}
          </div>
        ))}
        {busy && messages[messages.length - 1]?.text === '' && messages.length > 0 && null}
      </div>
      <ChatModelPicker
        loadSettings={loadSettings}
        onChange={setModelId}
        disabled={busy}
        translate={s}
        storageKey={MODEL_STORAGE_KEY}
      />
      <AiComposer
        value={draft}
        busy={busy}
        placeholder={t('askPlaceholder')}
        hintIdle={t('askHintIdle')}
        hintBusy={t('askHintBusy')}
        sendLabel={t('askSend')}
        stopLabel={t('askStop')}
        ariaLabel={t('askPlaceholder')}
        onChange={setDraft}
        onSend={() => void ask()}
        onStop={() => {
          generation.current++
          loopRef.current?.reset()
          patchLast((last) => ({ text: last.text || s('Stopped.') }))
          finishLast()
        }}
      />
    </div>
  )
}
