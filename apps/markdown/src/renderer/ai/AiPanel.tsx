import { AiPanelResizer } from '@genoffice/ui'
import { ChatPanelHeader } from '@genoffice/ui'
import { useEditorConversations } from '@genoffice/ui'
import {
  registerDirectoryEditor,
  directoryWorkflowActive,
  directoryModelSettings,
  directoryProgress,
  directoryPartial,
} from '@genoffice/agent-core'
import { ChatModelPicker } from '@genoffice/ui'
import { setRendererChatModel, getRendererChatModel } from '@genoffice/ai-provider/browser'
import '@genoffice/ui/chat-model-picker.css'
import { AiPanelSideButton, useAiPanelWidth } from '@genoffice/ui'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { AgentLoop, composeSkills, streamText, type AgentSkill } from '@genoffice/agent-core'
import { imageGenerationAvailable, type AiSettings } from '@genoffice/ai-provider/browser'
import {
  AiComposer,
  AiQueueStrip,
  AI_QUEUE_LABELS,
  AiScopeQuote,
  AiTypingIndicator,
  createFileNav,
  Markdown,
  useChatRunQueue,
  type AiScopeQuoteData,
} from '@genoffice/ui'
import type { Editor } from '@tiptap/core'
import { aiLangDirective, t as tGlobal, useI18n } from '../i18n/locale'
import { clearAiHighlights } from '../editor/aiHighlight'
import { setInactiveSelectionShown } from '../editor/inactiveSelection'
import { createMarkdownSkill, MARKDOWN_RULES } from './markdown-skill'
import { createSourceSkill, type SourceAiAccess } from './source-skill'
import {
  buildDocWriterRequest,
  countMarkdownBlocks,
  DOC_MAX_CHARS,
  extractMarkdown,
  type DocWriteResult,
  type DocWriteSpec,
} from './doc-writer'
import { createSearchSkill } from './search-skill'
import { createElectronTransport, loadChatModelSettings } from './transport'
import { EditQueueCard } from './EditQueueCard'
import {
  buildQueueInstruction,
  buildQueueSummary,
  liveItems,
  resolveQueue,
  type EditQueueItem,
} from './edit-queue'
import { DOC_NAV_SCHEME, navigateToBlock, parseDocNavHref } from './doc-nav'

// Word-parity count (docs word-count.ts): Asian chars one by one + non-Asian words
const ASIAN_RE =
  /[ᄀ-ᇿ⺀-⿟、-〿぀-ヿ㄀-ㄯ㄰-㆏㇀-ㇿ㐀-䶿一-鿿가-힯豈-﫿！-｠￠-￦]|[\uD840-\uD87F][\uDC00-\uDFFF]/g
const NON_ASIAN_WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['-][A-Za-z0-9À-ɏ]+)*/g

function countWords(text: string): number {
  return (text.match(ASIAN_RE) ?? []).length + (text.match(NON_ASIAN_WORD_RE) ?? []).length
}

const PANEL_WIDTH_KEY = 'markdown-ai-panel-width'
const MAX_SNAPSHOTS = 20
const TOOL_OUTPUT_MAX_CHARS = 2000
/** progress chip refresh while a write streams */
const CHIP_UPDATE_MS = 400

interface ToolActivity {
  name: string
  summary: string
  mutated?: boolean | undefined
  /** still executing: rendered as a spinner chip, replaced in place when the tool finishes */
  running?: boolean
  isError?: boolean
  output?: string
}

interface ChatEntry {
  instruction?: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  isError?: boolean
  /** the run failed and this user message was rolled back out of the model context */
  undelivered?: boolean
  tools?: ToolActivity[]
  /** the selection this user message targeted, frozen at send */
  scope?: AiScopeQuoteData
}

/** longest selection excerpt echoed on a user bubble */
const SCOPE_TEXT_MAX = 200

/** structured, not the serialized file text: a body starting with `---` must
 *  never be re-parsed as a frontmatter block on rollback */
export interface DocSnapshot {
  /** Literal source buffer when the open file is text/configuration/code. */
  source?: string
  /** document body as markdown */
  body: string
  /** raw frontmatter block (fences included), kept byte-for-byte */
  frontmatter: string
}

interface Snapshot {
  label: string
  time: string
  doc: DocSnapshot
}

/** Ribbon preset instruction; a new nonce triggers one auto-send */
export interface AiPreset {
  text: string
  nonce: number
}

export interface MarkdownAiDeps {
  source?: SourceAiAccess
  getEditor(): Editor | null
  /** inner YAML of the properties block, read synchronously (write-then-read within one run) */
  getFrontmatter(): string
  /** replace the properties block; empty string removes it */
  setFrontmatter(inner: string): void
  /** document body + frontmatter, for pre-mutation snapshots */
  getSnapshot(): DocSnapshot
  /** rollback: replace the document (body and frontmatter) with a snapshot */
  restoreSnapshot(snapshot: DocSnapshot): void
  /** fired when a run with at least one mutation finishes (auto-save hook) */
  onRunDone(mutated: boolean): void
}

export function AiPanel({
  deps,
  filePath,
  preset,
  onCollapse,
  editQueue = [],
  onQueueEditInstruction,
  onQueueRemove,
  onQueueClear,
  onQueueFocus,
  onQueueConsume,
}: {
  deps: MarkdownAiDeps
  filePath: string | null
  preset?: AiPreset | null
  onCollapse: () => void
  /** queued selection-scoped edits (owned by App, which also owns the anchors) */
  editQueue?: EditQueueItem[]
  onQueueEditInstruction?: (qid: string, instruction: string) => void
  onQueueRemove?: (qid: string) => void
  onQueueClear?: () => void
  onQueueFocus?: (qid: string) => void
  onQueueConsume?: (qids: string[]) => void
}): ReactElement {
  const { lang, t } = useI18n()
  const [chat, setChat] = useState<ChatEntry[]>([])
  const chatManagementRef = useRef<ReturnType<typeof useEditorConversations<ChatEntry>> | null>(
    null,
  )
  /** a streamed write stopped early: the draft stays in the document until the user keeps or discards it */
  const [activePartial, setActivePartial] = useState<{ blocks: number } | null>(null)
  const partialResolverRef = useRef<((keep: boolean) => void) | null>(null)
  /** bumped by New chat / unmount: a writer resuming after its abort must not open the keep card */
  const writerEpochRef = useRef(0)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  /** messages queued while a reply runs; the pump re-runs them through send on settle */
  const msgQueue = useChatRunQueue<void>({
    busy,
    submit: (text) => {
      const loop = loopRef.current
      if (!loop || loop.busy) return false
      send(text, text, null)
      return true
    },
  })
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  // bumped on selection/doc changes so the scope chip & queue rows stay fresh
  const [, setScopeTick] = useState(0)
  /** the scope chip's expandable preview of the selected text */
  const [scopePreviewOpen, setScopePreviewOpen] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottomRef = useRef(true)
  const panelWidth = useAiPanelWidth(PANEL_WIDTH_KEY)
  const { asideRef, resizing } = panelWidth
  const mountedRef = useRef(true)

  const settingsRef = useRef<AiSettings | null>(null)
  /** gsk login state for the generate_image gate (refreshed on mount and window focus) */
  const gskLoggedInRef = useRef(false)
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void window.markdownApi
        .aiGskStatus?.()
        .then((s) => {
          if (alive) gskLoggedInRef.current = !!s?.loggedIn
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const langRef = useRef(lang)
  langRef.current = lang
  const depsRef = useRef(deps)
  depsRef.current = deps
  const filePathRef = useRef(filePath)
  /** instruction of the in-flight run, labels its rollback snapshot */
  const runInstructionRef = useRef('')
  /** what the user saw for that instruction (queue submissions show a summary) */
  const runDisplayRef = useRef('')
  const runMutatedRef = useRef(false)
  /** tool activity of the whole run, for transcript persistence */
  const runToolsRef = useRef<ToolActivity[]>([])
  const chatIdsRef = useRef<{ projectId: string; chatId: string } | null>(null)
  /** messages sent before resolveChat returned, flushed once the chat id is known */
  const pendingPersistRef = useRef<
    Array<{
      role: 'user' | 'assistant'
      text: string
      tools?: ToolActivity[]
      scope?: AiScopeQuoteData
    }>
  >([])

  const patchLast = (patch: Partial<ChatEntry> | ((last: ChatEntry) => Partial<ChatEntry>)) => {
    setChat((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (!last || last.role !== 'assistant') return prev
      next[next.length - 1] = { ...last, ...(typeof patch === 'function' ? patch(last) : patch) }
      return next
    })
  }

  const persistMessage = (
    role: 'user' | 'assistant',
    text: string,
    tools?: ToolActivity[],
    scope?: AiScopeQuoteData,
  ) => {
    const ids = chatIdsRef.current
    if (!window.projectApi) return
    if (!ids) {
      pendingPersistRef.current.push({ role, text, tools, scope })
      return
    }
    void window.projectApi
      .appendChat({
        projectId: ids.projectId,
        chatId: ids.chatId,
        role,
        text,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(scope ? { scope } : {}),
      })
      .catch(() => {
        /* persistence failures are silent */
      })
  }

  const transportRef = useRef<ReturnType<typeof createElectronTransport> | null>(null)
  if (!transportRef.current)
    transportRef.current = createElectronTransport(() => settingsRef.current!)

  /**
   * Long-form writing: one tool-less request whose reply is the markdown, streamed
   * into the document as a draft by the tool. A stream that stops early leaves the
   * user a keep-or-discard choice; a stream that produced nothing is retried once.
   */
  const runDocWriter = async (
    spec: DocWriteSpec,
    onProgress: (markdown: string) => void,
    signal?: AbortSignal,
  ): Promise<DocWriteResult> => {
    const { system, user } = buildDocWriterRequest(
      spec,
      MARKDOWN_RULES,
      aiLangDirective(langRef.current),
    )
    const epoch = writerEpochRef.current
    let closed = false
    let chipTimer: ReturnType<typeof setTimeout> | null = null
    let latest = ''
    const updateChip = () => {
      chipTimer = null
      if (closed) return
      const blocks = countMarkdownBlocks(latest)
      patchLast((last) => ({
        tools: last.tools?.map((tl) =>
          tl.running ? { ...tl, summary: tGlobal('aiWritingDocument', { blocks }) } : tl,
        ),
      }))
    }
    const attempt = () =>
      streamText({
        transport: transportRef.current!,
        system,
        user,
        signal,
        maxChars: DOC_MAX_CHARS,
        extract: (raw) => ({ text: extractMarkdown(raw) }),
        onProgress: (markdown) => {
          if (closed) return
          latest = markdown
          directoryProgress(`Writing document: ${countMarkdownBlocks(markdown)} blocks`)
          onProgress(markdown)
          if (chipTimer === null) chipTimer = setTimeout(updateChip, CHIP_UPDATE_MS)
        },
      })
    let outcome = await attempt()
    if (outcome.status === 'empty' && !signal?.aborted) outcome = await attempt()
    closed = true
    if (chipTimer !== null) clearTimeout(chipTimer)
    if (outcome.status === 'complete') return { ok: true, markdown: outcome.text }
    if (outcome.status === 'empty') return { ok: false, error: outcome.error }
    if (epoch !== writerEpochRef.current) return { ok: false, error: 'the chat was reset' }
    // the draft stays in the document while the user decides
    const keep = directoryWorkflowActive()
      ? await directoryPartial(
          'The writer stopped before finishing. Keep the partial draft or discard it?',
          signal,
        )
      : await new Promise<boolean>((resolve) => {
          partialResolverRef.current = resolve
          setActivePartial({ blocks: countMarkdownBlocks(outcome.text) })
        })
    return keep
      ? { ok: true, markdown: outcome.text, truncated: true }
      : {
          ok: false,
          error: `${outcome.reason}${outcome.error ? `: ${outcome.error}` : ''}; the user discarded the partial content`,
        }
  }
  const runDocWriterRef = useRef(runDocWriter)
  runDocWriterRef.current = runDocWriter

  const decidePartial = (keep: boolean): void => {
    partialResolverRef.current?.(keep)
    partialResolverRef.current = null
    setActivePartial(null)
  }
  /** New chat / unmount: discard an open keep card and keep a still-settling writer from opening one */
  const abandonWriter = (): void => {
    writerEpochRef.current++
    decidePartial(false)
  }
  useEffect(
    () => () => {
      writerEpochRef.current++
    },
    [],
  )

  // The loop is built once; every mutable value goes through a ref getter
  const loopRef = useRef<AgentLoop<DocSnapshot> | null>(null)
  const directoryEditorPath = useRef(filePath)
  directoryEditorPath.current = filePath
  useEffect(
    () =>
      registerDirectoryEditor(() => ({
        kind: depsRef.current.source ? 'text' : 'markdown',
        path: directoryEditorPath.current,
        loop: loopRef.current,
        configure: (options) => {
          settingsRef.current = options.settings as AiSettings
        },
      })),
    [],
  )
  if (!loopRef.current) {
    const sourceSkill = createSourceSkill(() => depsRef.current.source)
    const markdownSkill = createMarkdownSkill(
      () => depsRef.current.getEditor(),
      {
        read: () => depsRef.current.getFrontmatter(),
        write: (inner) => depsRef.current.setFrontmatter(inner),
      },
      () => imageGenerationAvailable(settingsRef.current, gskLoggedInRef.current),
      () => ({
        write: (spec, onProgress, signal) => runDocWriterRef.current(spec, onProgress, signal),
      }),
    )
    const currentSkill = () => (depsRef.current.source ? sourceSkill : markdownSkill)
    const documentSkill: AgentSkill = {
      id: 'open-document',
      get systemPrompt() {
        return currentSkill().systemPrompt
      },
      get tools() {
        return currentSkill().tools
      },
      buildContext: () => currentSkill().buildContext?.() ?? '',
      executeTool: (call, signal) => currentSkill().executeTool(call, signal),
      verifyResponse: (text, executed) => currentSkill().verifyResponse?.(text, executed) ?? null,
    }
    loopRef.current = new AgentLoop<DocSnapshot>({
      transport: transportRef.current,
      skill: composeSkills('markdown+search', '', [documentSkill, createSearchSkill()]),
      captureSnapshot: () => depsRef.current.getSnapshot(),
      systemSuffix: () => aiLangDirective(langRef.current),
      events: {
        onText: (text) => patchLast({ text }),
        onToolStart: (call) => {
          // Live "running" chip: replaced in place by onToolExecuted
          patchLast((last) => ({
            tools: [
              ...(last.tools ?? []),
              { name: call.name, summary: call.name.replace(/[_-]+/g, ' '), running: true },
            ],
          }))
        },
        onToolExecuted: ({ call, execution, snapshotBefore }) => {
          if (execution.mutated) runMutatedRef.current = true
          if (snapshotBefore !== undefined) {
            const label = runInstructionRef.current.slice(0, 40)
            const time = new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
            setSnapshots((prev) =>
              [...prev, { label, time, doc: snapshotBefore }].slice(-MAX_SNAPSHOTS),
            )
          }
          const activity: ToolActivity = {
            name: call.name,
            summary: execution.summary,
            mutated: !!execution.mutated,
            isError: execution.isError,
            output: execution.output?.slice(0, TOOL_OUTPUT_MAX_CHARS),
          }
          runToolsRef.current.push(activity)
          patchLast((last) => {
            // Swap out the running placeholder pushed by onToolStart (parse-fail calls have none)
            const tools = [...(last.tools ?? [])]
            if (tools.at(-1)?.running) tools.pop()
            return { tools: [...tools, activity] }
          })
        },
        onTurnEnd: () => {
          patchLast({ streaming: false })
          setChat((prev) => [...prev, { role: 'assistant', text: '', streaming: true }])
        },
        onDone: ({ text, cancelled, turnLimit, truncated }) => {
          if (cancelled || turnLimit || truncated) msgQueue.setPaused(true)
          const base = turnLimit
            ? [text, tGlobal('aiTurnLimit')].filter(Boolean).join('\n\n')
            : text || (cancelled ? tGlobal('aiStopped') : '')
          // A reasoning model can spend the entire output budget on thinking and close the
          // turn with finish_reason=length and no prose at all — the bare "(no reply)" read
          // as the assistant ignoring the user. Name the truncation, as docs already does.
          const final = truncated
            ? [base, tGlobal('aiTruncatedNote')].filter(Boolean).join('\n\n')
            : base
          patchLast((last) => ({
            streaming: false,
            text: final || (last.tools?.length ? last.text : tGlobal('aiNoReply')),
            // A stop mid-tool can leave a running placeholder behind — drop it
            tools: last.tools?.filter((tl) => !tl.running),
          }))
          persistMessage('assistant', final, runToolsRef.current)
          const editor = depsRef.current.getEditor()
          if (editor) clearAiHighlights(editor)
          depsRef.current.onRunDone(runMutatedRef.current)
          setBusy(false)
        },
        onError: (error) => {
          msgQueue.setPaused(true)
          setChat((prev) => {
            const next = [...prev]
            for (let i = next.length - 1; i >= 0; i--) {
              const entry = next[i]!
              if (entry.role === 'user') {
                next[i] = { ...entry, undelivered: true }
                break
              }
            }
            const last = next.at(-1)
            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                streaming: false,
                text: error,
                isError: true,
                tools: last.tools?.filter((tl) => !tl.running),
              }
            }
            return next
          })
          setBusy(false)
        },
      },
    })
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      partialResolverRef.current?.(false)
      loopRef.current?.cancel()
      const editor = depsRef.current.getEditor()
      if (editor) clearAiHighlights(editor)
    }
  }, [])

  // ── chat-history persistence: bind to the file, restore prior transcript ──
  useEffect(() => {
    const api = window.projectApi
    if (!api) return
    const tempChatId = `unsaved-${Date.now()}`
    void api
      .resolveChat({ filePath: filePathRef.current ?? null, tempChatId })
      .then((ids) => {
        chatIdsRef.current = ids
        for (const msg of pendingPersistRef.current.splice(0)) {
          persistMessage(msg.role, msg.text, msg.tools, msg.scope)
        }
        return api.loadChat({ projectId: ids.projectId, chatId: ids.chatId, limit: 200 })
      })
      .then(async (msgs) => {
        if (await chatManagementRef.current!.restorePersistent()) return
        if (msgs.length === 0) return
        // the user may have sent a message while history was loading — never
        // replace a live transcript (and don't clobber the loop context)
        let applied = false
        setChat((prev) => {
          if (prev.length > 0) return prev
          applied = true
          return msgs.map((m) => ({
            role: m.role,
            text: m.text,
            tools: m.tools?.map((tool) => ({
              name: tool.name,
              summary: tool.summary,
              isError: tool.isError,
              output: tool.output ? tool.output.slice(0, TOOL_OUTPUT_MAX_CHARS) : undefined,
            })),
            ...(m.scope ? { scope: m.scope } : {}),
          }))
        })
        if (applied && !loopRef.current?.busy) {
          loopRef.current?.restore(msgs.map((m) => ({ role: m.role, text: m.text })))
        }
      })
      .catch(() => {
        /* history load failures are silent */
      })
  }, [])

  /** after an untitled document's first save, bind the unsaved-* history to the real path */
  useEffect(() => {
    filePathRef.current = filePath
    const ids = chatIdsRef.current
    if (!window.projectApi || !ids || !filePath || !ids.chatId.startsWith('unsaved-')) return
    void window.projectApi
      .rebindChat({ projectId: ids.projectId, tempChatId: ids.chatId, newFilePath: filePath })
      .then((r) => {
        if (r?.chatId) {
          chatIdsRef.current = r
          chatManagementRef.current!.rebind()
        }
      })
      .catch(() => {
        /* silent */
      })
  }, [filePath])

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight })
    }
  }, [chat, busy])

  const onChatScroll = (): void => {
    const el = chatRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  /** retryScope: null = a retry that had no scope; undefined = capture the live selection */
  const send = (text: string, displayText?: string, retryScope?: AiScopeQuoteData | null): void => {
    const instruction = text.trim()
    const loop = loopRef.current
    if (!instruction || !loop || loop.busy) return
    stickToBottomRef.current = true
    runInstructionRef.current = instruction
    runDisplayRef.current = displayText ?? instruction
    runMutatedRef.current = false
    runToolsRef.current = []
    // a queue batch carries its own display text: no selection quote
    const scope =
      retryScope !== undefined
        ? (retryScope ?? undefined)
        : displayText === undefined
          ? selectionScopeQuote()
          : undefined

    // the popover input / composer own the DOM selection now: keep the targeted range visible until the run ends
    if (scope) setInactiveSelectionShown(depsRef.current.getEditor(), true)
    setChat((prev) => [
      ...prev,
      { role: 'user', text: displayText ?? instruction, instruction, ...(scope ? { scope } : {}) },
      { role: 'assistant', text: '', streaming: true },
    ])
    setPrompt('')
    setBusy(true)
    // persist what the user saw — a restored transcript must not surface the
    // internal batch protocol text behind a queue submission
    persistMessage('user', displayText ?? instruction, undefined, scope)
    void (async () => {
      try {
        settingsRef.current = directoryModelSettings(await window.markdownApi.getAiSettings())
        if (!mountedRef.current) return
        await loop.run(instruction)
      } catch (err) {
        if (!mountedRef.current) return
        patchLast({
          streaming: false,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
        })
        setBusy(false)
      }
    })()
  }

  const stop = (): void => {
    msgQueue.setPaused(true)
    loopRef.current?.cancel()
  }

  /** Enter while a reply runs: the draft joins the queue above the composer */
  const enqueueDraft = () => {
    const text = prompt.trim()
    if (!text) return
    msgQueue.enqueue(text, undefined)
    setPrompt('')
  }

  // keep the scope chip & queue rows in sync with the editor selection/content
  useEffect(() => {
    const editor = depsRef.current.getEditor()
    if (!editor) return
    const bump = () => {
      if (editor.state.selection.empty) setScopePreviewOpen(false)
      setScopeTick((tick) => tick + 1)
    }
    editor.on('selectionUpdate', bump)
    editor.on('update', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('update', bump)
    }
  }, [])

  // scope chip data, recomputed per render (the scope tick above keeps it fresh)
  const editor = depsRef.current.getEditor()
  const source = deps.source
  const sourceSelection = source?.getSelection()
  const liveSelection = editor?.state.selection
  const selectionText =
    source && sourceSelection
      ? source.getText().slice(sourceSelection.from, sourceSelection.to).trim()
      : !editor || !liveSelection || liveSelection.empty
        ? ''
        : editor.state.doc.textBetween(liveSelection.from, liveSelection.to, '\n', ' ').trim()
  const hasScopeSelection = selectionText.length > 0

  /** the × on the scope chip: collapse the selection so the run targets the whole document */
  const clearScopeSelection = (): void => {
    if (source) {
      source.clearSelection()
      return
    }
    if (editor) editor.commands.setTextSelection(editor.state.selection.to)
  }

  const selectionScopeQuote = (): AiScopeQuoteData | undefined => {
    const source = depsRef.current.source
    if (source) {
      const selection = source.getSelection()
      const text = selection
        ? source.getText().slice(selection.from, selection.to).replace(/\s+/g, ' ').trim()
        : ''
      return text
        ? {
            label: t('aiScopeSelection', { words: countWords(text) }),
            text: text.length > SCOPE_TEXT_MAX ? `${text.slice(0, SCOPE_TEXT_MAX)}…` : text,
          }
        : undefined
    }
    const ed = depsRef.current.getEditor()
    if (!ed || ed.state.selection.empty) return undefined
    const { from, to } = ed.state.selection
    const text = ed.state.doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim()
    if (!text) return undefined
    return {
      label: t('aiScopeSelection', { words: countWords(text) }),
      text: text.length > SCOPE_TEXT_MAX ? `${text.slice(0, SCOPE_TEXT_MAX)}…` : text,
    }
  }

  // the frozen-range highlight ends with the run, or as soon as the editor is focused again
  useEffect(() => {
    if (!busy) setInactiveSelectionShown(depsRef.current.getEditor(), false)
  }, [busy])
  useEffect(() => {
    const ed = depsRef.current.getEditor()
    if (!ed) return
    const off = () => setInactiveSelectionShown(ed, false)
    ed.on('focus', off)
    return () => {
      ed.off('focus', off)
    }
  }, [])

  /** [label](mdnav://block/N) links in replies select and scroll to that block */
  const docNav = {
    scheme: DOC_NAV_SCHEME,
    onNavigate: (href: string) => {
      const index = parseDocNavHref(href)
      const current = depsRef.current.getEditor()
      if (index !== null && current) navigateToBlock(current, index)
    },
  }
  // [name](filenav:///abs/path) citations open the cited file in its own app
  const fileNav = createFileNav((path) => {
    void window.markdownApi.openSourcePath(path)
  })

  /** submit every still-anchored queued edit as one batch run */
  const sendQueue = (): void => {
    const loop = loopRef.current
    const current = depsRef.current.getEditor()
    if (!loop || loop.busy || editQueue.length === 0 || !current) return
    const entries = liveItems(resolveQueue(current, editQueue))
    if (entries.length === 0) {
      onQueueClear?.()
      return
    }
    const instruction = buildQueueInstruction(entries)
    const display = buildQueueSummary(t('aiQueueSubmitted', { count: entries.length }), entries)
    // consumed at send: the run rewrites the anchored passages, which would
    // orphan the anchors anyway; a failed run is retried via the retry action
    onQueueConsume?.(editQueue.map((item) => item.qid))
    send(instruction, display)
  }

  // ribbon presets auto-send; while a run is active they land in the composer instead
  const presetNonceRef = useRef(0)
  useEffect(() => {
    if (!preset || preset.nonce === presetNonceRef.current) return
    presetNonceRef.current = preset.nonce
    if (loopRef.current?.busy) setPrompt(preset.text)
    else send(preset.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset])

  const rollback = (snapshot: Snapshot): void => {
    if (busy) return
    depsRef.current.restoreSnapshot(snapshot.doc)
    setSnapshots((prev) => prev.filter((s) => s !== snapshot))
  }

  const chatManagement = useEditorConversations<ChatEntry>({
    messages: chat,
    draft: prompt,
    busy,
    lang,
    getKey: () => {
      const ids = chatIdsRef.current
      return ids ? `${ids.projectId}:${ids.chatId}` : null
    },
    replace: (messages) => {
      setChat(messages)
    },
    setDraft: setPrompt,
    loop: () => loopRef.current,
    beforeSwitch: () => {
      msgQueue.clear()
      msgQueue.setPaused(false)
      abandonWriter()
    },
    send: (message, text, displayText) => {
      send(text, displayText, message.scope ?? null)
    },
  })
  chatManagementRef.current = chatManagement

  return (
    <aside
      id={panelWidth.panelId}
      ref={asideRef}
      className={`copilot nawa-chat-panel${resizing ? ' ai-panel-resizing' : ''}`}
      style={{ width: '100%' }}
      dir={lang === 'ar' ? 'rtl' : undefined}
    >
      <AiPanelResizer panel={panelWidth} lang={lang} />
      <ChatPanelHeader
        lang={lang}
        brand={<NawaMark size={22} />}
        onNewChat={() => {
          if (!chatManagement.newChat()) return
          msgQueue.setPaused(false)
          abandonWriter()
          msgQueue.clear()
          loopRef.current?.reset()
          setBusy(false)
          setChat([])
        }}
        disabled={busy}
        onCollapse={onCollapse}
        collapseLabel={t('aiCollapsePanel')}
      >
        <AiPanelSideButton
          lang={lang}
          onMove={(side) => window.markdownApi.setAiPanelPrefs({ side })}
        />
      </ChatPanelHeader>

      {chatManagement.toolbar}
      <div className="ai-chat" ref={chatRef} onScroll={onChatScroll}>
        {chat.length === 0 && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">{t('aiEmptyTitle')}</div>
            <div className="ai-chat-empty-body">{t('aiEmptyBody')}</div>
            <div className="ai-starter-list">
              <button
                className="ai-starter"
                onClick={() => {
                  setPrompt(t('aiQuickDraftPrompt'))
                  inputRef.current?.focus()
                }}
              >
                {t('aiQuickDraft')}
              </button>
              <button
                className="ai-starter"
                onClick={() => {
                  setPrompt(t('aiQuickPolishPrompt'))
                  inputRef.current?.focus()
                }}
              >
                {t('aiQuickPolish')}
              </button>
            </div>
          </div>
        )}
        {chat.map((entry, i) => {
          if (entry.role === 'user') {
            return chatManagement.actions(i, (editor) => (
              <div key={i} className="ai-msg ai-msg-user">
                {entry.scope && <AiScopeQuote scope={entry.scope} />}
                {editor ?? <span dir="auto">{entry.text}</span>}
                {entry.undelivered && (
                  <div className="ai-msg-undelivered">{t('aiUndelivered')}</div>
                )}
              </div>
            ))
          }
          const hasTools = (entry.tools?.length ?? 0) > 0
          if (!entry.text && !entry.streaming && !hasTools) return null
          return (
            <div
              key={i}
              className={`ai-msg ai-msg-assistant${entry.isError ? ' ai-msg-error' : ''}${entry.streaming ? ' ai-msg-streaming' : ''}`}
            >
              {!entry.text && entry.streaming ? (
                <span className="ai-typing-row">
                  <AiTypingIndicator label={hasTools ? t('aiWorking') : t('aiThinking')} />
                </span>
              ) : (
                entry.text && (
                  <div dir="auto">
                    <Markdown text={entry.text} navs={[docNav, fileNav]} />
                  </div>
                )
              )}
              {hasTools && <ToolChipList tools={entry.tools!} />}

              {chatManagement.actions(i)}
            </div>
          )
        })}
      </div>

      {snapshots.length > 0 && (
        <div className="ai-versions">
          <div className="ai-versions-title">
            <IconClock />
            {t('aiSnapshotsTitle')}
          </div>
          {snapshots.map((s, i) => (
            <div key={i} className="ai-version-row">
              <span className="ai-version-label" data-tip={s.label}>
                <span className="ai-version-time">{s.time}</span>
                {s.label}
              </span>
              <button className="ai-version-rollback" disabled={busy} onClick={() => rollback(s)}>
                {t('aiRollback')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ai-composer">
        {activePartial && (
          <div className="ai-queue ai-partial-card" role="group" aria-label={t('aiPartialTitle')}>
            <div className="ai-queue-head">
              <span className="ai-queue-title">{t('aiPartialTitle')}</span>
            </div>
            <div className="ai-queue-hint">
              {t('aiPartialBody', { blocks: activePartial.blocks })}
            </div>
            <div className="ai-queue-foot">
              <button
                type="button"
                className="ai-queue-discard"
                onClick={() => decidePartial(false)}
              >
                {t('aiPartialDiscard')}
              </button>
              <button type="button" className="ai-queue-send" onClick={() => decidePartial(true)}>
                {t('aiPartialAdopt')}
              </button>
            </div>
          </div>
        )}
        {editor && editQueue.length > 0 && (
          <EditQueueCard
            items={editQueue}
            editor={editor}
            busy={busy}
            onEditInstruction={(qid, instruction) => onQueueEditInstruction?.(qid, instruction)}
            onRemove={(qid) => onQueueRemove?.(qid)}
            onDiscardAll={() => onQueueClear?.()}
            onSend={sendQueue}
            onFocus={(qid) => onQueueFocus?.(qid)}
          />
        )}
        <AiComposer
          footerStart={
            <ChatModelPicker
              loadSettings={loadChatModelSettings}
              onChange={setRendererChatModel}
              initialId={getRendererChatModel()}
              disabled={busy}
            />
          }
          queueStrip={
            <AiQueueStrip
              items={msgQueue.queued}
              labels={AI_QUEUE_LABELS[lang]}
              onUpdate={msgQueue.update}
              onRemove={msgQueue.remove}
              onClear={msgQueue.clear}
              paused={msgQueue.paused}
              onTogglePause={msgQueue.togglePaused}
              onMove={msgQueue.move}
            />
          }
          onQueue={enqueueDraft}
          queuePlaceholder={AI_QUEUE_LABELS[lang].queuePlaceholder}
          value={prompt}
          busy={busy}
          header={
            hasScopeSelection && (
              <div className="ai-scope-row">
                <span className="ai-scope-hint">
                  <button
                    className="ai-scope-label"
                    onClick={() => setScopePreviewOpen((v) => !v)}
                    aria-expanded={scopePreviewOpen}
                    data-tip={t('aiScopeSelectionTip')}
                  >
                    {t('aiScopeSelection', { words: countWords(selectionText) })}
                  </button>
                  <button
                    className="ai-scope-clear"
                    onClick={clearScopeSelection}
                    data-tip={t('aiScopeClearTitle')}
                    aria-label={t('aiScopeClearTitle')}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
                {scopePreviewOpen && (
                  <div className="ai-scope-preview">
                    {selectionText.length > 400 ? `${selectionText.slice(0, 400)}…` : selectionText}
                  </div>
                )}
              </div>
            )
          }
          placeholder={t('aiComposerPlaceholder')}
          hintIdle={t('aiHintIdle')}
          hintBusy={t('aiHintBusy')}
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly

          textareaRef={inputRef}
          onChange={setPrompt}
          onSend={() => send(prompt)}
          onStop={stop}
        />
      </div>
    </aside>
  )
}

/** Step-row status icons (timeline glyphs, unified with the other apps) */
function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.5 3.5h11M6.5 20.5h11M8 3.5v3.2c0 2.6 4 4.2 4 5.3 0 1.1 4 2.7 4 5.3v3.2M16 3.5v3.2c0 2.6-4 4.2-4 5.3 0 1.1-4 2.7-4 5.3v3.2" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.4 2.4 2.4 4.6-5" />
    </svg>
  )
}

/** Tool activity group (docs parity): auto-opens while tools run, auto-collapses into
 *  "Worked · N steps" when they finish; a manual toggle always wins */
function ToolChipList({ tools }: { tools: ToolActivity[] }) {
  const { t: tr } = useI18n()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const toggle = (j: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(j)) next.delete(j)
      else next.add(j)
      return next
    })
  }

  const anyRunning = tools.some((tool) => tool.running)
  const open = userOpen ?? anyRunning
  const label = anyRunning ? tr('aiGroupWorking') : tr('aiWorkedSteps', { n: tools.length })

  return (
    <div className="ai-work-group">
      <button
        type="button"
        className={`ai-work-group-summary${anyRunning ? ' running' : ''}`}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        {anyRunning && !open && <span className="ai-tool-chip-spinner" aria-hidden />}
        <span className="ai-work-group-label">{label}</span>
        <span className={`ai-tool-chip-caret${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      <div className={`ai-work-group-body${open ? ' open' : ''}`}>
        <div className="ai-work-group-body-inner">
          {tools.map((tool, j) => {
            const hasOutput = !tool.running && !!tool.output
            const isOpen = expanded.has(j)
            const stepStatus = tool.running ? 'running' : tool.isError ? 'error' : 'done'
            return (
              <div key={j} className="ai-step-row">
                <span className={`ai-step-icon ${stepStatus}`} aria-hidden>
                  <StepIcon status={stepStatus} />
                </span>
                <div className="ai-step-content">
                  {hasOutput ? (
                    <button
                      type="button"
                      className="ai-step-title clickable"
                      data-tip={tool.name}
                      aria-expanded={isOpen}
                      onClick={() => toggle(j)}
                    >
                      {tool.summary}
                    </button>
                  ) : (
                    <span className="ai-step-title" data-tip={tool.name}>
                      {tool.summary}
                    </span>
                  )}
                  {hasOutput && isOpen && (
                    <div className="ai-step-detail">
                      <div className="ai-tool-output">
                        <div className="ai-tool-output-pre">{tool.output}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function IconClock(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  )
}

/** Nawa brand mark, inline for crisp device-resolution rendering */
export function NawaMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="16" y="16" width="480" height="480" rx="112" fill="#141414" />
      <rect x="128" y="128" width="64" height="256" fill="#ffffff" />
      <rect x="320" y="128" width="64" height="256" fill="#ffffff" />
      <path d="M128 128 L192 128 L384 320 L384 384 L320 384 L128 192 Z" fill="#e8663f" />
    </svg>
  )
}
