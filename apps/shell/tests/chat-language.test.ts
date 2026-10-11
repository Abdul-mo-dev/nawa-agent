/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcStreamChunk, IpcStreamStart } from '@genoffice/agent-core'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import type { ConversationRecord, HistorySave } from '../src/shared/conversation-api'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { WorkspaceChat } from '../src/renderer/src/WorkspaceChat'
import { LocaleProvider, useI18n } from '../src/renderer/src/locale'

type Surface = 'workspace' | 'knowledge-base'
const cleanup: (() => Promise<void>)[] = []

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  localStorage.clear()
})
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function panel(surface: Surface, initial: Lang) {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = {
    ...settings.providers.custom,
    baseUrl: 'http://127.0.0.1:8082/v1',
    model: 'local-model',
  }
  const listeners = new Set<(chunk: IpcStreamChunk) => void>()
  const api = {
    getAiSettings: vi.fn(async () => settings),
    setLanguage: vi.fn(async (_lang: Lang) => undefined),
    kbList: vi.fn(async () => [
      {
        path: '/documents/note.txt',
        name: 'note.txt',
        folder: 'documents',
        ext: '.txt',
        sizeBytes: 20,
      },
    ]),
    kbSearch: vi.fn(async () => []),
    aiStream: vi.fn(async (_request: IpcStreamStart<AiSettings>) => undefined),
    aiStreamCancel: vi.fn(),
    onAiStreamChunk: (listener: (chunk: IpcStreamChunk) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const record: ConversationRecord = {
    id: crypto.randomUUID(),
    folder: null,
    folderName: 'Workspace',
    title: 'Language test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    modelId: '',
    revision: 0,
    draft: '',
    messages: [],
    baselineId: null,
    lastChatAt: null,
  }
  Object.assign(window, {
    aiOffice: api,
    nawaHistory: {
      initialize: vi.fn(async () => ({ databasePath: 'history.sqlite', imported: 0 })),
      list: vi.fn(async () => ({ conversations: [], total: 0 })),
      create: vi.fn(async () => record),
      save: vi.fn(async (input: HistorySave) => ({
        revision: input.revision + 1,
        updatedAt: Date.now(),
        title: record.title,
      })),
      cancelScan: vi.fn(async () => undefined),
    },
    nawaDirectory: {},
  })
  let setLanguage!: (lang: Lang) => void
  function Chat() {
    setLanguage = useI18n().setLang
    return surface === 'workspace'
      ? createElement(WorkspaceChat, {
          folder: null,
          folderName: 'Workspace',
          registeredRoots: [],
          scopePaths: [],
          onOpenFile: vi.fn(),
          onClose: vi.fn(),
        })
      : createElement(KbAskPanel, { onOpenPath: vi.fn() })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup.push(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial }, createElement(Chat))),
  )
  expect(host.querySelector('textarea')).not.toBeNull()
  const send = async (text: string) => {
    await act(async () => {
      const textarea = host.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        text,
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('button.ai-send-btn')!.click())
  }
  const emit = async (chunk: Omit<IpcStreamChunk, 'requestId'>) => {
    await act(async () => {
      const requestId = api.aiStream.mock.calls.at(-1)![0].requestId
      for (const listener of listeners) listener({ ...chunk, requestId })
    })
  }
  const switchLanguage = async (lang: Lang) => {
    await act(async () => setLanguage(lang))
  }
  return { api, host, send, emit, switchLanguage }
}

const fallbacks: [Lang, string][] = [
  [
    'en',
    "Reply in the same language as the user's message; if it cannot be determined, reply in English.",
  ],
  ['ar', 'أجب بنفس لغة رسالة المستخدم؛ وإذا تعذر تحديدها، فأجب باللغة العربية.'],
  ['zh-TW', '用與使用者訊息相同的語言回覆；無法判斷使用者訊息的語言時，用繁體中文回覆。'],
  [
    'vi',
    'Trả lời bằng ngôn ngữ của tin nhắn người dùng; nếu không xác định được, hãy trả lời bằng tiếng Việt.',
  ],
]

for (const surface of ['workspace', 'knowledge-base'] as const) {
  it.each(fallbacks)(
    `${surface} sends the message unchanged with the %s reply-language fallback`,
    async (lang, directive) => {
      const p = await panel(surface, lang)
      const question = 'こんにちは'
      await p.send(question)
      expect(p.api.aiStream).toHaveBeenCalledOnce()
      const request = p.api.aiStream.mock.calls[0]![0]
      expect(request.system.endsWith(directive)).toBe(true)
      expect(request.system).toContain(
        surface === 'workspace'
          ? 'Only completed, currently verified evidence is restored as answer context.'
          : 'Search and read current sources again before using file facts in this answer.',
      )
      expect(request.messages.at(-1)).toMatchObject({ role: 'user' })
      expect(request.messages.at(-1)!.text.startsWith(question)).toBe(true)
      await p.emit({ type: 'error', error: 'Test complete.' })
    },
  )

  it(`${surface} uses the current language on tool continuations and subsequent questions`, async () => {
    const p = await panel(surface, 'en')
    await p.send('こんにちは')
    expect(p.api.aiStream.mock.calls[0]![0].system).toContain('reply in English.')
    await p.switchLanguage('ja')
    await p.emit({
      type: 'tool-call',
      toolCall: {
        id: 'read',
        name: surface === 'workspace' ? 'list_files' : 'search_knowledge_base',
        input: surface === 'workspace' ? {} : { query: 'note' },
      },
    })
    await p.emit({ type: 'done' })
    expect(p.api.aiStream).toHaveBeenCalledTimes(2)
    const japanese = '言語を判別できない場合は日本語で返信してください。'
    expect(p.api.aiStream.mock.calls[1]![0].system.endsWith(japanese)).toBe(true)
    await p.emit({ type: 'delta', text: 'こんにちは。' })
    await p.emit({ type: 'done' })
    await p.switchLanguage('ar')
    await p.send('مرحبا')
    expect(p.api.aiStream).toHaveBeenCalledTimes(3)
    expect(p.api.aiStream.mock.calls[2]![0].system.endsWith(fallbacks[1]![1])).toBe(true)
    await p.emit({ type: 'error', error: 'Test complete.' })
  })
}
