import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalyticsStore } from '../src/main/analytics/store'
import type { AnalyticsResult } from '../src/shared/analytics-api'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
const database = () => {
  directory = mkdtempSync(join(tmpdir(), 'nawa-analytics-lock-'))
  return join(directory, 'data.sqlite3')
}
const receipt = (id: string, createdAt: number): AnalyticsResult => ({
  id, createdAt, operation: 'query', sources: [], sql: [], parameters: [], population: {},
  columns: [], rows: [], totalResultRows: 0, displayedRows: 0, outputTruncated: false,
  inputSampled: false, warnings: [], request: {},
})

it('opens and reads metadata during an uncommitted writer transaction without schema writes', () => {
  const path = database(), writer = new AnalyticsStore(path)
  let reader: AnalyticsStore | undefined
  try {
    writer.db.exec('BEGIN IMMEDIATE')
    writer.putFile({ path: 'pending.csv', hash: 'hash', size: 1, mtime: 0, ctime: 0, state: 'importing', error: '', imported: 0 })
    reader = new AnalyticsStore(path, { readOnly: true, initialize: false })
    expect(reader.files()).toEqual([])
    expect(() => reader.putFile({ path: 'forbidden.csv', hash: '', size: 0, mtime: 0, ctime: 0, state: 'ready', error: '', imported: 0 })).toThrow(/readonly/)
    writer.db.exec('COMMIT')
    expect(reader.files().map(f => f.path)).toEqual(['pending.csv'])
  } finally {
    reader?.close()
    writer.close()
  }
})

it('persists a complete result and applies retention in one transaction', () => {
  const store = new AnalyticsStore(database())
  try {
    store.saveResult(receipt('old', 1), 1)
    store.db.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON analytics_results BEGIN SELECT RAISE(ABORT, 'retention failed'); END")
    expect(() => store.saveResult(receipt('new', 2), 1)).toThrow('retention failed')
    expect(store.result('old')).toEqual(receipt('old', 1))
    expect(store.result('new')).toBeUndefined()
    expect(store.db.isTransaction).toBe(false)
    store.db.exec('DROP TRIGGER fail_retention')
    store.saveResult(receipt('new', 2), 1)
    expect(store.result('old')).toBeUndefined()
    expect(store.result('new')).toEqual(receipt('new', 2))
  } finally { store.close() }
})
