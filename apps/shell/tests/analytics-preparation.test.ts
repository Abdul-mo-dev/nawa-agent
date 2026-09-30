/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsSettings } from '../src/renderer/src/analytics/AnalyticsSettings'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'
import { LocaleProvider } from '../src/renderer/src/locale'
import { DEFAULT_ANALYTICS_SETTINGS } from '../src/shared/analytics-api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined, host: HTMLDivElement | undefined
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined })

describe('agent preparation controls', () => {
  it('runs button-authorized preparation, agent policy review and SQLite export through the same chat tools', async () => {
    const client = { analytics: vi.fn().mockResolvedValueOnce({ preparation: { draftsPrepared: 1 } }).mockResolvedValueOnce({ id: 'data', generation: 'draft', totalColumns: 1, policy: { columns: [{ id: 'c0' }] } }).mockResolvedValueOnce({ datasetId: 'data', generation: 'approved', approved: true, status: 'ready' }).mockResolvedValueOnce({ datasets: [{ id: 'data', generation: 'approved', name: 'Data', status: 'ready' }], nextOffset: null }).mockResolvedValueOnce({ databasePath: 'C:/Workspace/tables.sqlite3', exports: [] }), cancel: vi.fn() }
    const skill = analyticsSkill(client, { prepareExport: true })
    expect(skill.tools.some(tool => tool.name === 'export_sqlite')).toBe(true)
    expect(analyticsSkill(client).tools.some(tool => tool.name === 'export_sqlite')).toBe(false)
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    expect(skill.verifyResponse?.('Preparation is finished.', [{ name: 'prepare_data', ok: true }])).toContain('unfinished')
    await skill.executeTool({ id: 'review', name: 'describe_dataset', input: { datasetId: 'data' } })
    await skill.executeTool({ id: 'apply', name: 'propose_table_policy', input: { datasetId: 'data', expectedGeneration: 'draft', policy: {} } })
    const exported = await skill.executeTool({ id: 'export', name: 'export_sqlite', input: {} })
    expect(JSON.parse(exported.output).databasePath).toBe('C:/Workspace/tables.sqlite3')
    expect(skill.verifyResponse?.('Exported the reviewed table to SQLite.', [{ name: 'prepare_data', ok: true }, { name: 'export_sqlite', ok: true }])).toBeNull()
    expect(client.analytics.mock.calls.map(([action]) => action)).toEqual(['prepare', 'describe', 'propose-policy', 'discover', 'export-sqlite'])
  })

  it('turns premature export attempts into paginated review pages before one real SQLite export', async () => {
    const names = ['FilesTable', 'Data', 'Budget']
    const ids = ['files', 'data', 'budget']
    const calls: { action: string; payload: any }[] = []
    const client = { analytics: vi.fn(async (action: string, payload: any) => {
      calls.push({ action, payload })
      if (action === 'prepare') return { preparation: { draftsPrepared: 3 } }
      if (action === 'discover') return payload.offset === 0
        ? { datasets: ids.slice(0, 2).map((id, i) => ({ id, name: names[i], generation: 'draft', status: 'needs-review' })), nextOffset: 2 }
        : { datasets: [{ id: 'budget', name: 'Budget', generation: 'draft', status: 'needs-review' }], nextOffset: null }
      if (action === 'describe') {
        const totalColumns = payload.datasetId === 'data' ? 65 : 1
        const count = Math.min(32, totalColumns - payload.columnOffset)
        return { id: payload.datasetId, generation: 'draft', totalColumns,
          policy: { columns: Array.from({ length: count }, (_, i) => ({ id: `c${payload.columnOffset + i}` })) },
          nextColumnOffset: payload.columnOffset + count < totalColumns ? payload.columnOffset + count : null }
      }
      if (action === 'export-sqlite') return { databasePath: 'C:/Workspace/tables.sqlite3', exports: [] }
      throw new Error(`Unexpected ${action}`)
    }), cancel: vi.fn() }
    const skill = analyticsSkill(client, { prepareExport: true })
    const before = await skill.executeTool({ id: 'early', name: 'export_sqlite', input: {} })
    expect(JSON.parse(before.output).status).toBe('preparation-required')
    expect(client.analytics).not.toHaveBeenCalled()
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: { paths: ['FilesTable.xlsx'] } })
    expect(calls[0]).toEqual({ action: 'prepare', payload: {} })
    const reviews = []
    for (let index = 0; index < 5; index++) {
      const result = await skill.executeTool({ id: String(index), name: 'export_sqlite', input: {} })
      reviews.push(JSON.parse(result.output))
      expect(result.isError).not.toBe(true)
      expect(client.analytics.mock.calls.filter(([action]) => action === 'export-sqlite')).toHaveLength(0)
      expect(skill.verifyResponse?.('Export complete.', [])).toContain('unfinished')
    }
    expect(reviews.map(review => [review.datasetName, review.columnOffset])).toEqual([
      ['FilesTable', 0], ['Data', 0], ['Data', 32], ['Data', 64], ['Budget', 0],
    ])
    expect(reviews.every(review => review.status === 'review-required' && review.description.policy.columns.length > 0)).toBe(true)
    const result = await skill.executeTool({ id: 'publish', name: 'export_sqlite', input: {} })
    expect(JSON.parse(result.output).databasePath).toBe('C:/Workspace/tables.sqlite3')
    expect(client.analytics.mock.calls.filter(([action]) => action === 'export-sqlite')).toHaveLength(1)
    expect(skill.verifyResponse?.('Export complete.', [])).toBeNull()
  })

  it('does not report completion when the export bridge returns no published database', async () => {
    const client = { analytics: vi.fn(async (action: string) => action === 'prepare' ? { preparation: {} }
      : action === 'discover' ? { datasets: [], nextOffset: null } : {}), cancel: vi.fn() }
    const skill = analyticsSkill(client, { prepareExport: true })
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    const result = await skill.executeTool({ id: 'export', name: 'export_sqlite', input: {} })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('did not confirm a database path')
    expect(skill.verifyResponse?.('Finished export.', [])).toContain('unfinished')
  })

  it('reuses preparation and discovery pages instead of fetching the same catalog again', async () => {
    const client = { analytics: vi.fn(async (action: string, payload: any) => {
      if (action === 'prepare') return { datasets: [{ id: 'a', name: 'A', generation: 'draft', status: 'needs-review' }], nextOffset: 1 }
      if (action === 'discover') return { datasets: [{ id: 'b', name: 'B', generation: 'draft', status: 'needs-review' }], nextOffset: null }
      if (action === 'describe') return { id: payload.datasetId, generation: 'draft', totalColumns: 1, policy: { columns: [{ id: 'c0' }] }, nextColumnOffset: null }
      if (action === 'export-sqlite') return { databasePath: 'C:/Workspace/tables.sqlite3' }
      throw new Error(`Unexpected ${action}`)
    }), cancel: vi.fn() }
    const skill = analyticsSkill(client, { prepareExport: true })
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    await skill.executeTool({ id: 'catalog', name: 'discover_datasets', input: { offset: 1 } })
    expect(JSON.parse((await skill.executeTool({ id: 'review-a', name: 'export_sqlite', input: {} })).output).datasetId).toBe('a')
    expect(JSON.parse((await skill.executeTool({ id: 'review-b', name: 'export_sqlite', input: {} })).output).datasetId).toBe('b')
    expect(JSON.parse((await skill.executeTool({ id: 'export', name: 'export_sqlite', input: {} })).output).databasePath).toBe('C:/Workspace/tables.sqlite3')
    expect(client.analytics.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(1)
  })

  it('updates a cached preparation catalog after agent approval without requesting the old generation again', async () => {
    const client = { analytics: vi.fn(async (action: string) => {
      if (action === 'prepare') return { datasets: [{ id: 'table', name: 'Data', generation: 'draft', status: 'needs-review' }], nextOffset: null }
      if (action === 'describe') return { id: 'table', generation: 'draft', totalColumns: 1, policy: { columns: [{ id: 'c0' }] } }
      if (action === 'propose-policy') return { datasetId: 'table', generation: 'approved', status: 'ready', approved: true }
      if (action === 'export-sqlite') return { databasePath: 'C:/Workspace/tables.sqlite3' }
      throw new Error(`Unexpected ${action}`)
    }), cancel: vi.fn() }
    const skill = analyticsSkill(client, { prepareExport: true })
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    await skill.executeTool({ id: 'describe', name: 'describe_dataset', input: { datasetId: 'table' } })
    await skill.executeTool({ id: 'policy', name: 'propose_table_policy', input: { datasetId: 'table', expectedGeneration: 'draft', policy: {} } })
    const result = await skill.executeTool({ id: 'export', name: 'export_sqlite', input: {} })
    expect(JSON.parse(result.output).databasePath).toBe('C:/Workspace/tables.sqlite3')
    expect(client.analytics.mock.calls.map(([action]) => action)).toEqual(['prepare', 'describe', 'propose-policy', 'export-sqlite'])
  })

  it('forwards complex SQL and search parameters through the SQLite action', async () => {
    const client = { analytics: vi.fn().mockResolvedValue({ id: 'receipt', rows: [] }), cancel: vi.fn() }
    const input = { datasetIds: ['data'], sql: 'WITH matches AS (SELECT * FROM data WHERE c0 LIKE ?) SELECT * FROM matches', parameters: ['%shipment%'] }
    await analyticsSkill(client).executeTool({ id: 'sql', name: 'query_sql', input })
    expect(client.analytics).toHaveBeenCalledExactlyOnceWith('sql', input)
  })
  it('requires the user to save local-storage consent and can revoke it without changing limits', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { nawaAnalytics: { settings: async () => ({ settings: DEFAULT_ANALYTICS_SETTINGS, databasePath: 'analytics.sqlite3' }), saveSettings } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(LocaleProvider, { initial: 'en' }, createElement(AnalyticsSettings))))
    const consent = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save analytics settings')!
    expect(consent.checked).toBe(false)
    expect(host.textContent).toContain('stored locally without encryption')
    await act(async () => consent.click())
    expect(saveSettings).not.toHaveBeenCalled()
    await act(async () => save.click())
    expect(saveSettings).toHaveBeenLastCalledWith({ ...DEFAULT_ANALYTICS_SETTINGS, allowAgentPreparation: true })
    await act(async () => consent.click())
    await act(async () => save.click())
    expect(saveSettings).toHaveBeenLastCalledWith(DEFAULT_ANALYTICS_SETTINGS)
  })

  it('exposes import and proposal tools, while leaving approval and clearing unavailable to the model', async () => {
    const client = { analytics: vi.fn().mockResolvedValue({ approvalRequired: true }), cancel: vi.fn() }
    const skill = analyticsSkill(client)
    const names = skill.tools.map(tool => tool.name)
    expect(names).toContain('prepare_data')
    expect(names).toContain('propose_table_policy')
    expect(names.some(name => /approve|clear/.test(name))).toBe(false)
    const paths = ['C:/Docs/files.xlsx']
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: { paths } })
    expect(client.analytics).toHaveBeenLastCalledWith('prepare', { paths })
    const draft = { datasetId: 'dataset', expectedGeneration: 'generation', policy: { grain: 'One file' } }
    const result = await skill.executeTool({ id: 'draft', name: 'propose_table_policy', input: draft })
    expect(client.analytics).toHaveBeenLastCalledWith('propose-policy', draft)
    expect(result.summary).toContain('user approval required')
    expect(skill.systemPrompt).toContain('Preparation results are not approved analytical answers')
  })

  it('saves automatic approval only after opting into preparation, and revokes it with preparation', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { nawaAnalytics: { settings: async () => ({ settings: DEFAULT_ANALYTICS_SETTINGS, databasePath: 'analytics.sqlite3' }), saveSettings } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(LocaleProvider, { initial: 'en' }, createElement(AnalyticsSettings))))
    const [prepare, automatic] = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save analytics settings')!
    expect(automatic.disabled).toBe(true); expect(automatic.checked).toBe(false)
    await act(async () => prepare.click()); expect(automatic.disabled).toBe(false)
    await act(async () => automatic.click()); expect(saveSettings).not.toHaveBeenCalled()
    await act(async () => save.click())
    expect(saveSettings).toHaveBeenLastCalledWith({ ...DEFAULT_ANALYTICS_SETTINGS, allowAgentPreparation: true, allowAgentApproval: true })
    await act(async () => prepare.click()); expect(automatic.checked).toBe(false)
    await act(async () => save.click()); expect(saveSettings).toHaveBeenLastCalledWith(DEFAULT_ANALYTICS_SETTINGS)
  })

  it('reports applied policies as ready for analysis rather than requiring a review step', async () => {
    const client = { analytics: vi.fn().mockResolvedValueOnce({ preparation: { approvedTables: 3, readyTables: 3, draftTables: 0 } }).mockResolvedValueOnce({ approved: true, approvalBy: 'agent', status: 'ready', generation: 'new' }), cancel: vi.fn() }
    const skill = analyticsSkill(client)
    const prepared = await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    expect(prepared.summary).toContain('approved clear selected tables')
    const applied = await skill.executeTool({ id: 'policy', name: 'propose_table_policy', input: {} })
    expect(applied.summary).toContain('approved an agent table policy')
    expect(skill.systemPrompt).toContain('Ready agent-approved tables can be queried immediately')
    expect(skill.systemPrompt).toContain('not reasons to require manual review of every clear table')
  })

  it('does not submit preparation after cancellation or claim success after a denied proposal', async () => {
    const client = { analytics: vi.fn().mockRejectedValue(new Error('Preparation consent is disabled')), cancel: vi.fn() }
    const skill = analyticsSkill(client), cancelled = new AbortController()
    cancelled.abort()
    expect((await skill.executeTool({ id: 'cancelled', name: 'prepare_data', input: {} }, cancelled.signal)).isError).toBe(true)
    expect(client.analytics).not.toHaveBeenCalled()
    expect((await skill.executeTool({ id: 'denied', name: 'propose_table_policy', input: {} })).isError).toBe(true)
  })

  it('uses an empty payload for the full selection and reports complete outcomes before paginated schemas', async () => {
    const value = { preparation: { draftsPrepared: 26, existingDrafts: 0, draftTables: 26, blockedTables: 2, issues: [{ kind: 'blocked-table', path: 'C:/Docs/formulas.xlsx', reason: 'Row 2 contains a formula' }], issuesTruncated: false }, datasets: [], nextOffset: 25 }
    const client = { analytics: vi.fn().mockResolvedValue(value), cancel: vi.fn() }
    const skill = analyticsSkill(client)
    const result = await skill.executeTool({ id: 'prepare-all', name: 'prepare_data', input: {} })
    expect(client.analytics).toHaveBeenCalledExactlyOnceWith('prepare', {})
    expect(JSON.parse(result.output)).toEqual(value)
    expect(result.isError).not.toBe(true)
    expect(skill.systemPrompt).toContain('Call prepare_data with {} (omit paths)')
    expect(skill.systemPrompt).toContain('Do not repeat a successful prepare_data')
    const tool = skill.tools.find(tool => tool.name === 'prepare_data')!
    expect(tool.description).toContain('Call with {} for the full selection')
    expect(tool.description).toContain('unique selected filenames')
  })

  it('corrects a final answer that claims no drafts exist after successful bulk preparation', async () => {
    const client = { analytics: vi.fn().mockResolvedValue({ preparation: { draftsPrepared: 5, existingDrafts: 1, blockedTables: 2 } }), cancel: vi.fn() }
    const skill = analyticsSkill(client)
    await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
    const executed = [{ name: 'prepare_data', ok: true }]
    expect(skill.verifyResponse?.('No table policies have been drafted yet. Should I prepare all files?', executed)).toContain('6 validated policy drafts')
    expect(skill.verifyResponse?.('Six drafts are ready for review. Two tables need formula decisions.', executed)).toBeNull()
    expect(skill.verifyResponse?.('No table policies have been drafted yet.', [{ name: 'prepare_data', ok: false }])).toBeNull()
    expect(skill.systemPrompt).toContain('Do not ask again whether to prepare the batch')
  })
})
