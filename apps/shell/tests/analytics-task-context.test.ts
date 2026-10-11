import { expect, it, vi } from 'vitest'
import { selectedTableTaskContext } from '../src/renderer/src/analytics/task-context'

const path = 'C:\\sample files\\employee-data.xlsx'
const dataset = {
  id: 'ready-employees',
  path,
  sourceHash: 'a'.repeat(64),
  generation: 'current',
  name: 'Data',
  sheet: 'Data',
  range: 'Data!A2:E501',
  status: 'ready',
  grain: 'One source data record',
  columns: [
    { id: 'c0', name: 'id', type: 'text' },
    { id: 'c1', name: 'name', type: 'text' },
  ],
  totalColumns: 2,
  moreColumns: false,
}

it('does not discover data for an empty file selection', async () => {
  const analytics = vi.fn()
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, []))
  expect(analytics).not.toHaveBeenCalled()
  expect(context).toMatchObject({ metadataOnly: true, datasets: [], selectedFileCount: 0 })
})

it('loads the verified Ready schema without importing, reading cells or querying numbers', async () => {
  const analytics = vi.fn().mockResolvedValue({ datasets: [dataset], nextOffset: null })
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, path))
  expect(analytics).toHaveBeenCalledExactlyOnceWith('discover', { query: 'employee-data.xlsx' })
  expect(context).toMatchObject({ metadataOnly: true, datasets: [dataset] })
  expect(context.guidance).toContain('not a calculated answer')
})

it('excludes another selected file that also matches the catalog query', async () => {
  const analytics = vi.fn().mockResolvedValue({
    datasets: [
      dataset,
      { ...dataset, id: 'other-employees', path: 'C:\\other\\employee-data.xlsx' },
    ],
    nextOffset: null,
  })
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, path))
  expect(context.datasets).toHaveLength(1)
  expect(context.datasets[0].id).toBe('ready-employees')
})

it('keeps empty, blocked and paginated catalogs explicit instead of assuming readiness', async () => {
  const analytics = vi
    .fn()
    .mockResolvedValueOnce({ datasets: [], nextOffset: null })
    .mockResolvedValueOnce({
      datasets: [{ ...dataset, status: 'unavailable', reason: 'Saved file changed' }],
      nextOffset: 25,
    })
  expect(JSON.parse(await selectedTableTaskContext({ analytics }, path)).datasets).toEqual([])
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, path))
  expect(context.datasets[0]).toMatchObject({ status: 'unavailable', reason: 'Saved file changed' })
  expect(context.nextOffset).toBe(25)
})

it('preserves approval origin so automatic approval is not presented as human review', async () => {
  const approval = { by: 'agent', at: 1, reason: 'Validated under saved settings.' }
  const analytics = vi
    .fn()
    .mockResolvedValue({ datasets: [{ ...dataset, approval, preparationState: 'ready' }] })
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, path))
  expect(context.datasets[0]).toMatchObject({ approval, preparationState: 'ready' })
})

it('bounds complete metadata entries and labels omissions without cutting JSON', async () => {
  const analytics = vi.fn().mockResolvedValue({
    datasets: Array.from({ length: 25 }, (_, i) => ({
      ...dataset,
      id: 'table-' + i,
      warnings: ['X'.repeat(3000)],
    })),
    nextOffset: 25,
  })
  const output = await selectedTableTaskContext({ analytics }, path)
  expect(output.length).toBeLessThanOrEqual(6000)
  const context = JSON.parse(output)
  expect(context.datasetsOmittedFromThisPage).toBe(25 - context.datasets.length)
  expect(context.nextOffset).toBe(25)
})

it('provides multiple selected schemas in one read-only call and exposes unsupported coverage', async () => {
  const second = 'C:\\sample files\\sales.csv'
  const notes = 'C:\\sample files\\notes.txt'
  const analytics = vi.fn().mockResolvedValue({
    datasets: [
      dataset,
      { ...dataset, id: 'sales', path: second },
      { ...dataset, path: 'C:\\outside\\private.xlsx' },
    ],
    selectedFiles: [
      { path, state: 'ready', tables: 1 },
      { path: second, state: 'ready', tables: 1 },
      {
        path: notes,
        state: 'unsupported',
        tables: 0,
        message: 'Use native reading for this file.',
      },
      { path: 'C:\\outside\\private.xlsx', state: 'ready', tables: 1 },
    ],
    nextOffset: null,
    nextFileOffset: null,
  })
  const context = JSON.parse(await selectedTableTaskContext({ analytics }, [path, second, notes]))
  expect(analytics).toHaveBeenCalledExactlyOnceWith('discover', { query: '' })
  expect(context.datasets.map((table: { id: string }) => table.id)).toEqual([
    'ready-employees',
    'sales',
  ])
  expect(context.selectedFileCount).toBe(3)
  expect(context.selectedFiles).toHaveLength(3)
  expect(context.selectedFiles[2]).toMatchObject({ path: notes, state: 'unsupported' })
  expect(context.guidance).toContain('Independent calculations')
  expect(context.guidance).toContain('do not union unrelated tables')
})

it('retains both dataset and file pagination when providing schemas for a large selection', async () => {
  const paths = Array.from({ length: 40 }, (_, i) => `C:\\tables\\${i}.csv`)
  const analytics = vi.fn().mockResolvedValue({
    datasets: paths.slice(0, 25).map((path, i) => ({ ...dataset, id: `dataset-${i}`, path })),
    selectedFiles: paths.slice(0, 16).map((path) => ({ path, state: 'ready', tables: 1 })),
    nextOffset: 25,
    nextFileOffset: 16,
  })
  const output = await selectedTableTaskContext({ analytics }, paths)
  const context = JSON.parse(output)
  expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(6000)
  expect(context).toMatchObject({ selectedFileCount: 40, nextOffset: 25, nextFileOffset: 16 })
  expect(context.datasetsOmittedFromThisPage).toBe(25 - context.datasets.length)
  expect(context.selectedFilesOmittedFromThisPage).toBe(16 - context.selectedFiles.length)
})
