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
