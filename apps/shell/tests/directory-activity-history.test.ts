import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { HistoryStore } = createRequire(import.meta.url)('../src/main/history/history-worker.cjs')
let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
const activity = { id: 'run-1', model: 'model', selectedFiles: 1, status: 'running', startedAt: 1, omitted: 0, steps: [
  { id: 'step', tool: 'query', kind: 'tool', status: 'running', startedAt: 2, summary: 'Querying', targets: ['C:\\data.xlsx'], input: '{"apiKey":"private-key"}' },
] }
it('migrates existing history and persists diagnostics while recovering interrupted work as stopped', () => {
  directory = mkdtempSync(join(tmpdir(), 'nawa-activity-history-'))
  const path = join(directory, 'history.sqlite')
  let store = new HistoryStore(path)
  const conversation = store.create({ folder: null, folderName: 'History' })
  store.save({ id: conversation.id, revision: 0, draft: '', modelId: '', baselineId: null, lastChatAt: null,
    messages: [{ id: 'old', role: 'user', text: 'Existing history', createdAt: 1 }] })
  store.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE messages DROP COLUMN activity_json; PRAGMA user_version=1'); legacy.close()
  store = new HistoryStore(path)
  try {
    const existing = store.get(conversation.id)
    expect(existing.messages[0].text).toBe('Existing history')
    store.save({ ...existing, messages: [...existing.messages, { id: 'new', role: 'assistant', text: '', createdAt: 2, streaming: true, activity }] })
    const saved = store.get(conversation.id)
    expect(saved.messages[1]).toMatchObject({ streaming: false, error: true, activity: { id: 'run-1', status: 'cancelled', steps: [{ status: 'cancelled' }] } })
    expect(JSON.stringify(saved)).not.toContain('private-key')
    expect(saved.messages[1].activity.steps[0].targets).toEqual(['C:\\data.xlsx'])
  } finally { store.close() }
  const db = new DatabaseSync(path)
  try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3) } finally { db.close() }
})
it('counts activity toward transcript limits and rejects malformed status without losing saved history', () => {
  const store = new HistoryStore(':memory:')
  try {
    const record = store.create({ folder: null, folderName: 'Test' })
    expect(() => store.save({ ...record, messages: [{ id: 'a', role: 'assistant', text: 'x', activity: { ...activity, status: 'invented' } }] })).toThrow('activity status')
    expect(store.get(record.id).revision).toBe(0)
    expect(() => store.save({ ...record, messages: [{ id: 'a', role: 'assistant', text: 'x'.repeat(8 * 1024 * 1024), activity }] })).toThrow('storage limit')
  } finally { store.close() }
})
it('upserts only changed messages and persists source receipts, citations and incomplete outcomes', () => {
  directory = mkdtempSync(join(tmpdir(), 'nawa-delta-history-'))
  const path = join(directory, 'history.sqlite'), store = new HistoryStore(path)
  const db = new DatabaseSync(path)
  try {
    const record = store.create({ folder: null, folderName: 'Delta' })
    const message = { id: 'answer', role: 'assistant', text: 'partial', createdAt: 2 }
    store.save({ ...record, messages: [{ id: 'user', role: 'user', text: 'Question', createdAt: 1 }, message] })
    db.exec('CREATE TABLE writes (kind TEXT); CREATE TRIGGER track_update AFTER UPDATE ON messages BEGIN INSERT INTO writes VALUES (\'update\'); END; CREATE TRIGGER track_delete AFTER DELETE ON messages BEGIN INSERT INTO writes VALUES (\'delete\'); END;')
    const citation = { id: 'RAG:one', path: 'C:\\file.txt', sourceHash: 'a'.repeat(64), locator: 'line 1', excerpt: 'Saved evidence' }
    store.save({ ...store.get(record.id), delta: true, messages: [{ ...message, text: 'retained partial',
      request: { id: 'request', phase: 'final', outcome: 'incomplete', evidence: [{ path: citation.path, hash: citation.sourceHash }] }, citations: [citation] }] })
    const saved = store.get(record.id)
    expect(saved.messages).toHaveLength(2); expect(saved.messages[0].text).toBe('Question')
    expect(saved.messages[1]).toMatchObject({ text: 'retained partial', request: { outcome: 'incomplete', evidence: [{ hash: citation.sourceHash }] }, citations: [citation] })
    expect(db.prepare('SELECT kind FROM writes').all()).toEqual([{ kind: 'update' }])
    expect(() => store.save({ ...saved, revision: 0, delta: true, messages: [] })).toThrow()
    store.save({ ...saved, delta: true, messages: [], removedIds: ['answer'] })
    expect(store.get(record.id).messages.map((message: any) => message.id)).toEqual(['user'])
  } finally { db.close(); store.close() }
})
