import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../src/store'
let directory: string, store: ProjectStore
const state = () => ({
  schema: 1,
  revision: 1,
  active: 'chat',
  chats: [
    {
      id: 'chat',
      title: 'Original',
      active: 'v1',
      versions: [
        {
          id: 'v1',
          label: 'Original',
          draft: '',
          messages: [
            { role: 'user', text: 'question' },
            { role: 'assistant', text: 'answer' },
          ],
        },
      ],
    },
  ],
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nawa-managed-'))
  store = new ProjectStore(directory)
  store.ensureDefaultProject()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('persists versions atomically and mirrors only the active path into legacy history', () => {
  expect(store.loadManagedConversation('default', 'file')).toBeNull()
  expect(store.saveManagedConversation('default', 'file', 0, state())).toEqual({ revision: 1 })
  expect(new ProjectStore(directory).loadManagedConversation('default', 'file')).toEqual({
    revision: 1,
    state: state(),
  })
  expect(store.loadChat('default', 'file').map((message) => message.text)).toEqual([
    'question',
    'answer',
  ])
  const empty = state()
  empty.chats[0].versions[0].messages = []
  store.saveManagedConversation('default', 'file', 1, empty)
  expect(store.loadChat('default', 'file')).toEqual([])
})
it('rejects stale writers and malformed or traversing inputs without losing the saved history', () => {
  store.saveManagedConversation('default', 'file', 0, state())
  expect(() => store.saveManagedConversation('default', 'file', 0, state())).toThrow(
    'another window',
  )
  expect(() =>
    store.saveManagedConversation('default', 'file', 1, { ...state(), active: 'missing' }),
  ).toThrow('active')
  const broken = state()
  Object.assign(broken.chats[0], { actions: 'invalid receipts' })
  expect(() => store.saveManagedConversation('default', 'file', 1, broken)).toThrow('receipts')
  expect(() => store.saveManagedConversation('default', '../escape', 0, state())).toThrow()
  expect(store.loadManagedConversation('default', 'file')!.revision).toBe(1)
})
it('moves the managed library with an unsaved chat when its file is first saved', () => {
  store.saveManagedConversation('default', 'unsaved-test', 0, state())
  store.rebindChat('default', 'unsaved-test', 'saved-file')
  expect(store.loadManagedConversation('default', 'saved-file')!.state).toEqual(state())
  expect(store.loadManagedConversation('default', 'unsaved-test')).toBeNull()
})
