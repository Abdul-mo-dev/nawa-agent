/** @vitest-environment jsdom */
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationHistoryApi } from '../src/shared/conversation-api'
vi.mock('@genoffice/ui', async () => ({
  ...(await vi.importActual('@genoffice/ui')),
  ChatModelPicker: () => null,
}))
import { WorkspaceChat } from '../src/renderer/src/WorkspaceChat'
const { HistoryStore } = createRequire(import.meta.url)('../src/main/history/history-worker.cjs')
let store: InstanceType<typeof HistoryStore>,
  host: HTMLDivElement,
  root: ReturnType<typeof createRoot>,
  originalId: string,
  reopen: () => void
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  Element.prototype.scrollTo ??= () => {}
  store = new HistoryStore(':memory:')
  const record = store.create({ folder: null, folderName: 'Workspace' })
  originalId = record.id
  store.save({
    ...record,
    messages: [
      { id: 'u1', role: 'user', text: 'first question', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'first answer', createdAt: 2 },
      { id: 'u2', role: 'user', text: 'second question', createdAt: 3 },
      { id: 'a2', role: 'assistant', text: 'second answer', createdAt: 4 },
    ],
  })
  window.nawaHistory = {
    initialize: async () => ({ databasePath: ':memory:', imported: 0 }),
    list: async (input) => store.list(input),
    create: async (input) => store.create(input),
    get: async (id) => store.get(id),
    save: async (input) => store.save(input),
    rename: async (id, title) => store.rename(id, title),
    delete: async (id) => store.delete(id),
    restore: async (id) => store.restore(id),
    purge: async (id) => store.purge(id),
    archive: async (id, archived) => store.archive(id, archived),
    branch: async (input) => store.branch(input),
    revise: async (input) => store.revise(input),
    switchVersion: async (input) => store.switchVersion(input),
    cancelScan: async () => {},
    revealDatabase: async () => {},
  } as ConversationHistoryApi
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    getAiSettings: async () => {
      throw new Error('Test model unavailable')
    },
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = (key?: string) =>
    root.render(
      createElement(WorkspaceChat, {
        key,
        folder: null,
        folderName: 'Workspace',
        registeredRoots: [],
        scopePaths: [],
        onOpenFile: () => {},
        onClose: () => {},
      }),
    )
  reopen = () => render('reopened')
  act(() => render())
  await flush()
  await flush()
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    await Promise.resolve()
  })
  host.remove()
  store.close()
  vi.restoreAllMocks()
})

it('deletes a continuation through the rendered message menu and restores it with Undo', async () => {
  const user = host.querySelectorAll('.ws-chat-assistant')[1]
  act(() => user.querySelector<HTMLButtonElement>('.chat-message-tools .chat-destructive')!.click())
  expect(user.textContent).toContain('Remove 1 exchange')
  expect(store.get(originalId).messages).toHaveLength(4)
  act(() => user.querySelector<HTMLButtonElement>('.chat-message-edit .chat-destructive')!.click())
  await flush()
  expect(store.get(originalId).messages.map((message: { id: string }) => message.id)).toEqual([
    'u1',
    'a1',
  ])
  const undo = [...host.querySelectorAll<HTMLButtonElement>('.chat-session-toolbar button')].find(
    (button) => button.textContent === 'Undo chat change',
  )!
  act(() => undo.click())
  await flush()
  expect(host.querySelectorAll('.ws-chat-user')).toHaveLength(2)
  expect(store.get(originalId).messages).toHaveLength(4)
})

it('branches from a rendered answer and links back to the original conversation', async () => {
  const answer = host.querySelector('.ws-chat-assistant')!
  const branch = answer.querySelector<HTMLButtonElement>(
    'button[aria-label="Branch into new chat"]',
  )!
  act(() => branch.click())
  await flush()
  expect(store.list({}).total).toBe(2)
  expect(host.querySelectorAll('.ws-chat-user')).toHaveLength(1)
  const selector = host.querySelector<HTMLSelectElement>(
    '.chat-session-toolbar .nawa-chat-conversation',
  )!
  const branchId = selector.value
  expect(selector.options).toHaveLength(2)
  expect(host.querySelector('.ai-input-footer .nawa-chat-conversation')).toBeNull()
  const source = host.querySelector<HTMLButtonElement>('.chat-session-source')!
  act(() => source.click())
  await flush()
  expect(host.querySelectorAll('.ws-chat-user')).toHaveLength(2)
  act(() => {
    const current = host.querySelector<HTMLSelectElement>(
      '.chat-session-toolbar .nawa-chat-conversation',
    )!
    current.value = branchId
    current.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
  expect(host.querySelectorAll('.ws-chat-user')).toHaveLength(1)
})

it('saves an edited version without the old continuation and retains the original version', async () => {
  const user = host.querySelector('.ws-chat-user')!
  const row = user.closest('.chat-question-row')!
  expect(user.querySelector('.chat-message-actions')).toBeNull()
  expect(user.nextElementSibling?.className).toBe('chat-message-actions')
  const edit = row.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!
  act(() => edit.click())
  const input = user.querySelector('textarea')!
  expect(input.value).toBe('first question')
  expect(user.textContent).toBe(input.textContent)
  expect(document.activeElement).toBe(input)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'revised question',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = row.querySelector<HTMLButtonElement>('button[type="submit"]')!
  act(() => submit.click())
  await flush()
  await flush()
  const record = store.get(originalId)
  expect(record.messages[0].text).toBe('revised question')
  expect(record.versions).toHaveLength(2)
  expect(
    record.messages.filter((message: { role: string }) => message.role === 'user'),
  ).toHaveLength(1)
  expect(record.messages.some((message: { id: string }) => message.id === 'u2')).toBe(false)
  const original = store.switchVersion({
    id: record.id,
    revision: record.revision,
    versionId: 'main',
  })
  expect(original.messages).toHaveLength(4)
})

it('places answer actions only after the final reply segment in each exchange', async () => {
  const record = store.get(originalId)
  store.save({
    ...record,
    messages: [
      record.messages[0],
      { id: 'a0', role: 'assistant', text: 'Checking the files', createdAt: 1 },
      ...record.messages.slice(1),
    ],
  })
  act(() => reopen())
  await flush()
  await flush()
  const answers = host.querySelectorAll('.ws-chat-assistant')
  expect(answers).toHaveLength(3)
  expect(answers[0].textContent).toBe('Checking the files')
  expect(answers[0].querySelector('.chat-message-tools')).toBeNull()
  expect(answers[1].querySelectorAll('.chat-message-tools')).toHaveLength(1)
  expect(answers[2].querySelectorAll('.chat-message-tools')).toHaveLength(1)
  expect(host.querySelectorAll('.chat-message-tools')).toHaveLength(4)
})
