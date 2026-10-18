/** @vitest-environment jsdom */
import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatMessageActions } from '../src/ChatMessageActions'
import { useEditorConversations } from '../src/use-editor-conversations'

interface Message {
  instruction?: string
  role: 'user' | 'assistant'
  text: string
  attachments?: { path: string }[]
  scope?: { label: string }
  tools?: { summary: string; mutated?: boolean }[]
}
const initial: Message[] = [
  {
    role: 'user',
    text: 'first question',
    attachments: [{ path: 'source.xlsx' }],
    scope: { label: 'A1:B4' },
  },
  { role: 'assistant', text: 'first answer' },
  { role: 'user', text: 'second question' },
  { role: 'assistant', text: 'second answer' },
]
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
let manager: ReturnType<typeof useEditorConversations<Message>>,
  visible: Message[],
  currentDraft: string
const loop = { reset: vi.fn(), restore: vi.fn(), prepareAnswerRegeneration: vi.fn() }
const sent = vi.fn()
function Probe({
  seed = initial,
  keyName = 'p:c',
  busy = false,
}: {
  seed?: Message[]
  keyName?: string
  busy?: boolean
}) {
  const [messages, setMessages] = useState(seed),
    [draft, setDraft] = useState('draft')
  visible = messages
  currentDraft = draft
  manager = useEditorConversations({
    messages,
    draft,
    busy,
    lang: 'en',
    getKey: () => keyName,
    replace: setMessages,
    setDraft,
    loop: () => loop,
    beforeSwitch: () => {},
    send: (message, text, displayText) => {
      sent(message, text, displayText)
      setMessages((previous) => [
        ...previous,
        { ...message, text: displayText },
        { role: 'assistant', text: 'new answer' },
      ])
      setDraft('')
    },
  })
  return createElement(
    'div',
    null,
    manager.toolbar,
    ...messages.map((message, index) =>
      message.role === 'user'
        ? manager.actions(index, (editor) =>
            createElement('div', { className: 'ai-msg ai-msg-user' }, editor ?? message.text),
          )
        : createElement(
            'div',
            { key: index, 'data-message-index': index },
            message.text,
            manager.actions(index),
          ),
    ),
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  delete (window as unknown as { projectApi?: unknown }).projectApi
})
const actions = (index: number) =>
  (manager.actions(index) as ReactElement<Parameters<typeof ChatMessageActions>[0]>).props

it('edits an earlier question on a saved alternative path and excludes its abandoned continuation', async () => {
  await act(async () => {
    await actions(0).onEdit!('revised question')
  })
  expect(visible.map((message) => message.text)).toEqual(['revised question', 'new answer'])
  expect(sent.mock.calls[0][0].attachments).toEqual(initial[0].attachments)
  expect(sent.mock.calls[0][0].scope).toEqual(initial[0].scope)
  expect(loop.restore).toHaveBeenLastCalledWith([])
  const saved = JSON.parse(localStorage.getItem('nawa.editor-conversations:v1:p:c')!)
  expect(saved.chats[0].versions[0].messages.map((message: Message) => message.text)).toEqual(
    initial.map((message) => message.text),
  )
  expect(saved.chats[0].versions).toHaveLength(2)
})

it('regenerates from the question context, retains the original answer, and blocks file changes', async () => {
  await act(async () => {
    await actions(3).onRegenerate!()
  })
  expect(loop.restore).toHaveBeenLastCalledWith(
    initial.slice(0, 2).map(({ role, text }) => ({ role, text })),
  )
  expect(loop.prepareAnswerRegeneration).toHaveBeenLastCalledWith('second answer')
  expect(visible.map((message) => message.text)).toEqual([
    'first question',
    'first answer',
    'second question',
    'new answer',
  ])
  expect(visible.filter((message) => message.text === 'second question')).toHaveLength(1)
})

it('deletes a dependent continuation and restores it with Undo', async () => {
  await act(async () => {
    await actions(2).onDelete!()
  })
  expect(visible.map((message) => message.text)).toEqual(['first question', 'first answer'])
  const undo = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Undo chat change',
  )!
  act(() => undo.click())
  expect(visible.map((message) => message.text)).toEqual(initial.map((message) => message.text))
  expect(currentDraft).toBe('draft')
})

it('preserves the old chat when starting a new one and restores managed state before legacy logs', () => {
  act(() => {
    expect(manager.newChat()).toBe(true)
  })
  expect(visible).toEqual([])
  act(() => root.unmount())
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  act(() => {
    expect(manager.restoreStored()).toBe(true)
  })
  expect(visible).toEqual([])
  const saved = JSON.parse(localStorage.getItem('nawa.editor-conversations:v1:p:c')!)
  expect(saved.chats).toHaveLength(2)
  expect(saved.chats[0].versions[0].messages).toHaveLength(4)
})

it('creates an independent branch with a source link', async () => {
  await act(async () => {
    await actions(1).onBranch!()
  })
  expect(visible.map((message) => message.text)).toEqual(['first question', 'first answer'])
  const saved = JSON.parse(localStorage.getItem('nawa.editor-conversations:v1:p:c')!)
  expect(saved.chats).toHaveLength(2)
  expect(saved.chats[1].source).toBe(saved.chats[0].id)
  expect(saved.active).toBe(saved.chats[1].id)
})

it('keeps internal instructions out of the bubble when regenerating a targeted request', async () => {
  act(() =>
    root.render(
      createElement(Probe, {
        key: 'targeted',
        keyName: 'p:targeted',
        seed: [
          {
            role: 'user',
            text: 'Polish selection',
            instruction: 'Internal instruction with frozen element identities',
          },
          { role: 'assistant', text: 'Polished the selected elements' },
        ],
      }),
    ),
  )
  await act(async () => {
    await actions(1).onRegenerate!()
  })
  expect(sent).toHaveBeenLastCalledWith(
    expect.anything(),
    'Internal instruction with frozen element identities',
    'Polish selection',
  )
  expect(visible[0].text).toBe('Polish selection')
})

it('retains actual file-change receipts after deleting a continuation without restoring abandoned answers', async () => {
  act(() =>
    root.render(
      createElement(Probe, {
        key: 'mutated',
        keyName: 'p:mutated',
        seed: [
          { role: 'user', text: 'Update the total' },
          {
            role: 'assistant',
            text: 'Old answer to remove',
            tools: [{ summary: 'Updated total to 42', mutated: true }],
          },
        ],
      }),
    ),
  )
  await act(async () => {
    await actions(0).onDelete!()
  })
  expect(visible).toEqual([])
  const context = loop.restore.mock.calls.at(-1)![0] as Message[]
  expect(JSON.stringify(context)).toContain('Updated total to 42')
  expect(JSON.stringify(context)).not.toContain('Old answer to remove')
  expect(host.textContent).toContain('File changes')
})

it('keeps the visible conversation intact when saving a mutation fails', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage full')
  })
  act(() => {
    expect(() => actions(0).onEdit!('revised')).toThrow('Storage full')
  })
  expect(visible).toEqual(initial)
  expect(sent).not.toHaveBeenCalled()
  act(() => {
    expect(manager.newChat()).toBe(false)
  })
  expect(host.textContent).toContain('Storage full')
  write.mockRestore()
})

it('restores a durable managed library when the browser journal is missing and serializes native saves', async () => {
  const durable = {
    schema: 1,
    revision: 7,
    active: 'saved',
    chats: [
      {
        id: 'saved',
        title: 'Recovered',
        active: 'version',
        versions: [
          {
            id: 'version',
            label: 'Original',
            draft: 'recovered draft',
            messages: initial.slice(0, 2),
          },
        ],
      },
    ],
  }
  const save = vi.fn(async (args: { revision: number }) => ({ revision: args.revision + 1 }))
  ;(window as unknown as { projectApi: unknown }).projectApi = {
    loadManagedConversation: vi.fn(async () => ({ revision: 4, state: durable })),
    saveManagedConversation: save,
  }
  await act(async () => {
    expect(await manager.restorePersistent()).toBe(true)
  })
  expect(visible.map((message) => message.text)).toEqual(['first question', 'first answer'])
  expect(currentDraft).toBe('recovered draft')
  await act(async () => {
    manager.newChat()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(visible).toEqual([])
  expect(save.mock.calls[0][0].revision).toBe(4)
  for (let index = 1; index < save.mock.calls.length; index++)
    expect(save.mock.calls[index][0].revision).toBe(save.mock.calls[index - 1][0].revision + 1)
})

it('edits in the question bubble with actions below it and confirms dependent deletion', () => {
  const first = host.querySelector('.chat-question-row')!
  const bubble = first.querySelector('.ai-msg-user')!
  expect(bubble.textContent).toBe('first question')
  expect(bubble.querySelector('.chat-message-actions')).toBeNull()
  expect(bubble.nextElementSibling?.className).toBe('chat-message-actions')
  const edit = first.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!
  act(() => edit.click())
  const input = bubble.querySelector('textarea')!
  expect(input.value).toBe('first question')
  expect(bubble.textContent).toBe(input.textContent)
  expect(first.querySelector('.chat-message-edit')).toBeNull()
  expect(first.querySelector('button[type="submit"]')!.getAttribute('form')).toBe(input.form!.id)
  expect(document.activeElement).toBe(input)
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(first.querySelector('textarea')).toBeNull()
  expect(bubble.textContent).toBe('first question')
  const remove = first.querySelector<HTMLButtonElement>('.chat-message-tools .chat-destructive')!
  act(() => remove.click())
  expect(first.textContent).toContain('Remove 2 exchanges')
  expect(visible).toHaveLength(4)
})

it('shows a single answer toolbar after a multi-segment reply, ignoring empty trailing segments', () => {
  act(() =>
    root.render(
      createElement(Probe, {
        key: 'segmented',
        seed: [
          initial[0],
          { role: 'assistant', text: 'Checking the file', tools: [{ summary: 'Read selection' }] },
          { role: 'assistant', text: 'Final answer' },
          { role: 'assistant', text: '' },
          ...initial.slice(2),
        ],
      }),
    ),
  )
  expect(host.querySelectorAll('.chat-message-tools')).toHaveLength(4)
  expect(host.querySelector('[data-message-index="1"] .chat-message-tools')).toBeNull()
  expect(host.querySelector('[data-message-index="3"] .chat-message-tools')).toBeNull()
  const final = host.querySelector('[data-message-index="2"]')!
  expect(final.querySelectorAll('.chat-message-tools')).toHaveLength(1)
  expect(final.querySelector('button[aria-label="Regenerate answer"]')).not.toBeNull()
  expect(final.querySelector('button[aria-label="Branch into new chat"]')).not.toBeNull()
  expect(final.querySelector('button[aria-label="Delete from here"]')).not.toBeNull()
  expect(host.querySelectorAll('.chat-question-row')).toHaveLength(2)
})

it('waits for the current reply to finish before showing its actions and keeps previous reply actions', () => {
  act(() => root.render(createElement(Probe, { busy: true })))
  expect(host.querySelector('[data-message-index="1"] .chat-message-tools')).not.toBeNull()
  expect(host.querySelector('[data-message-index="3"] .chat-message-tools')).toBeNull()
  act(() => root.render(createElement(Probe, { busy: false })))
  expect(host.querySelector('[data-message-index="3"] .chat-message-tools')).not.toBeNull()
})
