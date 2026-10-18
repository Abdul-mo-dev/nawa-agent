import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
const { HistoryStore } = createRequire(import.meta.url)('../src/main/history/history-worker.cjs')
const stores: InstanceType<typeof HistoryStore>[] = []
function fixture() {
  const store = new HistoryStore(':memory:')
  stores.push(store)
  const record = store.create({ folder: null, folderName: 'Workspace' })
  const scope = { opened: null, files: ['C:\\work\\report.xlsx'], directories: [] }
  store.save({
    ...record,
    draft: 'unsent draft',
    messages: [
      { id: 'u1', role: 'user', text: 'first question', createdAt: 1, scope },
      { id: 'a1', role: 'assistant', text: 'first answer', createdAt: 2 },
      { id: 'u2', role: 'user', text: 'second question', createdAt: 3 },
      { id: 'a2', role: 'assistant', text: 'second answer', createdAt: 4 },
    ],
  })
  return { store, record: store.get(record.id), scope }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

it('edits an earlier question without retaining the abandoned continuation in model history', () => {
  const { store, record } = fixture()
  const edited = store.revise({
    id: record.id,
    revision: record.revision,
    messageId: 'u2',
    kind: 'edit',
    text: 'revised second question',
  })
  expect(edited.messages.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1'])
  expect(edited.draft).toBe('revised second question')
  expect(edited.versions).toHaveLength(2)
  expect(
    edited.versions.find((version: { id: string }) => version.id === edited.activeVersionId)
      .parentVersionId,
  ).toBe('main')
  const original = store.switchVersion({
    id: record.id,
    revision: edited.revision,
    versionId: 'main',
  })
  expect(original.messages).toHaveLength(4)
  expect(original.draft).toBe('unsent draft')
  const restored = store.switchVersion({
    id: record.id,
    revision: original.revision,
    versionId: edited.activeVersionId,
  })
  expect(restored.draft).toBe('revised second question')
})

it('keeps retry attempts and original file selection recoverable without duplicate questions', () => {
  const { store, record, scope } = fixture()
  const retried = store.revise({
    id: record.id,
    revision: record.revision,
    messageId: 'a1',
    kind: 'retry',
  })
  expect(retried.messages).toEqual([])
  expect(retried.draft).toBe('first question')
  const original = store.switchVersion({
    id: record.id,
    revision: retried.revision,
    versionId: 'main',
  })
  expect(original.messages[0].scope).toEqual(scope)
  expect(
    original.messages.filter((message: { role: string }) => message.role === 'user'),
  ).toHaveLength(2)
})

it('soft-deletes a turn and its continuation and restores them through the saved parent version', () => {
  const { store, record } = fixture()
  const deleted = store.revise({
    id: record.id,
    revision: record.revision,
    messageId: 'a2',
    kind: 'delete',
  })
  expect(deleted.messages.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1'])
  const exported = store.exportConversation(record.id)
  expect(
    exported.versions.find((item: { id: string }) => item.id === 'main').messages,
  ).toHaveLength(4)
  expect(
    exported.versions.find((item: { id: string }) => item.id === deleted.activeVersionId).messages,
  ).toHaveLength(2)
  const version = deleted.versions.find(
    (item: { id: string }) => item.id === deleted.activeVersionId,
  )
  const undone = store.switchVersion({
    id: record.id,
    revision: deleted.revision,
    versionId: version.parentVersionId,
  })
  expect(undone.messages.map((message: { id: string }) => message.id)).toEqual([
    'u1',
    'a1',
    'u2',
    'a2',
  ])
})

it('branches independently and retains provenance without copying filesystem baselines', () => {
  const { store, record } = fixture()
  const branch = store.branch({ id: record.id, revision: record.revision, messageId: 'a1' })
  expect(branch.id).not.toBe(record.id)
  expect(branch.sourceConversationId).toBe(record.id)
  expect(branch.messages).toHaveLength(2)
  expect(branch.baselineId).toBeNull()
  store.save({ ...branch, messages: [] })
  expect(store.get(record.id).messages).toHaveLength(4)
})

it('supports Trash, restoration, archive, content search and permanent deletion', () => {
  const { store, record } = fixture()
  expect(store.list({ query: 'first answer' }).conversations).toHaveLength(1)
  expect(store.list({ query: '%' }).conversations).toHaveLength(0)
  store.delete(record.id)
  expect(store.list({}).total).toBe(0)
  expect(store.list({ view: 'trash' }).total).toBe(1)
  expect(() => store.save(record)).toThrow('no longer exists')
  store.restore(record.id)
  expect(store.get(record.id).messages).toHaveLength(4)
  store.archive(record.id, true)
  expect(store.list({}).total).toBe(0)
  expect(store.list({ view: 'archived' }).total).toBe(1)
  expect(() => store.purge(record.id)).toThrow('Trash')
  store.delete(record.id)
  store.purge(record.id)
  expect(store.list({ view: 'trash' }).total).toBe(0)
  expect(() => store.restore(record.id)).toThrow()
})

it('rejects stale or running mutations atomically', () => {
  const { store, record } = fixture()
  expect(() =>
    store.revise({ id: record.id, revision: 0, messageId: 'u1', kind: 'delete' }),
  ).toThrow('changed')
  expect(store.get(record.id).versions).toHaveLength(0)
  store.save({
    ...record,
    messages: [
      ...record.messages,
      { id: 'partial', role: 'assistant', text: 'partial', streaming: true, createdAt: 5 },
    ],
  })
  const active = store.get(record.id)
  expect(() => store.branch({ id: record.id, revision: active.revision, messageId: 'u1' })).toThrow(
    'Stop',
  )
  expect(store.list({}).total).toBe(1)
})

it('retains committed file outcomes independently of deleted chat turns and copies them into branches', () => {
  const { store, record } = fixture()
  const receipt = {
    id: 'receipt',
    role: 'assistant',
    text: 'Created the file',
    createdAt: 2,
    contextKey: 'scope',
    request: {
      id: 'change',
      phase: 'receipt',
      outcome: 'completed',
      action: { operation: 'create', path: 'C:\\work\\created.txt' },
    },
  }
  store.save({
    ...record,
    messages: [...record.messages.slice(0, 2), receipt, ...record.messages.slice(2)],
  })
  const current = store.get(record.id)
  const deleted = store.revise({
    id: current.id,
    revision: current.revision,
    messageId: 'u1',
    kind: 'delete',
  })
  expect(deleted.messages).toEqual([])
  expect(deleted.actions[0].request.action.path).toBe('C:\\work\\created.txt')
  const restored = store.switchVersion({
    id: deleted.id,
    revision: deleted.revision,
    versionId: 'main',
  })
  const branch = store.branch({ id: restored.id, revision: restored.revision, messageId: 'u1' })
  expect(branch.messages).toHaveLength(3)
  store.delete(record.id)
  store.purge(record.id)
  expect(store.get(branch.id).actions[0].request.action.path).toBe('C:\\work\\created.txt')
})
