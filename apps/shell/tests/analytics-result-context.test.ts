import { expect, it, vi } from 'vitest'
import { analyticalResultContext } from '../src/renderer/src/analytics/result-context'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'

const source = {
  path: 'C:\\tables\\sales.xlsx',
  hash: 'a'.repeat(64),
  datasetId: 'sales',
  generation: 'current',
}
const receipt = () => ({
  id: 'result-sales',
  createdAt: 1,
  operation: 'query',
  sources: [source],
  sql: ['SELECT category, analytics_exact_sum(amount) FROM sales GROUP BY category'],
  parameters: [[]],
  request: { datasetIds: ['sales'], metrics: [{ op: 'sum', column: 'c1', as: 'revenue' }] },
  population: {
    sourceRows: [{ grain: 'One source data record', rows: 10000 }],
    matchedRows: 10000,
  },
  columns: [{ name: 'revenue', type: 'decimal', scale: 2 }],
  rows: Array.from({ length: 100 }, (_, index) => ({
    category: `Product ${index}`,
    revenue: '9007199254740993.01',
  })),
  totalResultRows: 100,
  displayedRows: 100,
  outputTruncated: false,
  inputSampled: false,
  warnings: ['Saved formula caches were explicitly approved.'],
  citations: [
    {
      id: 'RAG:result-sales:1',
      path: source.path,
      sourceHash: source.hash,
      locator: 'Analysis result-sales',
      excerpt: 'Duplicated source evidence '.repeat(300),
    },
  ],
})

it('keeps exact values, source versions and complete-population evidence in a bounded preview', () => {
  const original = receipt()
  const before = structuredClone(original)
  const compact = analyticalResultContext(original) as ReturnType<typeof receipt>
  expect(compact).toMatchObject({
    id: original.id,
    sources: original.sources,
    population: original.population,
    columns: original.columns,
    inputSampled: false,
    totalResultRows: 100,
    displayedRows: 20,
    outputTruncated: true,
  })
  expect(compact.rows).toEqual(original.rows.slice(0, 20))
  expect(compact.rows[0].revenue).toBe('9007199254740993.01')
  expect(compact.warnings).toContain(original.warnings[0])
  expect(compact.citations).toEqual([
    {
      id: 'RAG:result-sales:1',
      path: source.path,
      sourceHash: source.hash,
      locator: 'Analysis result-sales',
    },
  ])
  expect(compact).not.toHaveProperty('sql')
  expect(compact).not.toHaveProperty('parameters')
  expect(compact.request).toEqual(original.request)
  expect(compact).toHaveProperty('receiptDetails.resultId', original.id)
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length / 2)
  expect(original).toEqual(before)
})

it('preserves statistical precision and existing upstream omissions even for a small result', () => {
  const original = {
    ...receipt(),
    operation: 'statistics',
    rows: [],
    totalResultRows: 0,
    displayedRows: 0,
    outputTruncated: true,
    summary: {
      mean: { rational: '100/3', display: '33.3333' },
      precision: 'Variance is approximate floating point.',
    },
  }
  const compact = analyticalResultContext(original) as typeof original
  expect(compact.summary).toEqual(original.summary)
  expect(compact.outputTruncated).toBe(true)
  expect(compact.warnings).toEqual(original.warnings)
})

it('retains filters and join policies while raw SQL execution details remain retrievable', () => {
  const request = {
    datasetIds: ['sales'],
    filters: [{ column: 'c1', op: 'gte', value: '0.10' }],
    join: { datasetId: 'products', leftKeys: ['c0'], rightKeys: ['c0'], kind: 'left' },
    sql: 'SELECT * FROM sales WHERE c1 >= ?',
    parameters: ['10'],
  }
  const context = analyticalResultContext({ ...receipt(), request }) as { request: typeof request }
  expect(context.request).toMatchObject({
    datasetIds: request.datasetIds,
    filters: request.filters,
    join: request.join,
  })
  expect(context.request).not.toHaveProperty('sql')
  expect(context.request).not.toHaveProperty('parameters')
})

it('does not alter metadata or incomplete receipts', () => {
  for (const value of [null, { datasets: [] }, { id: 'draft', rows: [] }])
    expect(analyticalResultContext(value)).toBe(value)
})

it.each(['query_data', 'query_sql', 'analyze_data'])(
  'compacts %s while inspect_result retains execution details',
  async (name) => {
    const saved = receipt()
    const analytics = vi.fn().mockResolvedValue(saved)
    const skill = analyticsSkill({ analytics, cancel() {} })
    const calculation = await skill.executeTool({ id: 'calculate', name, input: {} })
    const context = JSON.parse(calculation.output)
    expect(context.rows).toHaveLength(20)
    expect(context).not.toHaveProperty('sql')
    const inspected = await skill.executeTool({
      id: 'inspect',
      name: 'inspect_result',
      input: { resultId: saved.id },
    })
    expect(JSON.parse(inspected.output)).toEqual(saved)
    expect(analytics).toHaveBeenLastCalledWith('result', { resultId: saved.id })
  },
)

it('keeps drill-down source row references while bounding displayed records', async () => {
  const saved = {
    ...receipt(),
    rows: Array.from({ length: 40 }, (_, row) => ({
      __dataset_id: 'sales',
      __source_row: String(row + 2),
      amount: '0.10',
    })),
    totalResultRows: 40,
    displayedRows: 40,
  }
  const analytics = vi.fn().mockResolvedValue(saved)
  const skill = analyticsSkill({ analytics, cancel() {} })
  const output = await skill.executeTool({
    id: 'drill',
    name: 'inspect_result',
    input: { resultId: saved.id, drill: true },
  })
  const context = JSON.parse(output.output)
  expect(context.rows[0]).toEqual(saved.rows[0])
  expect(context.sources).toEqual(saved.sources)
  expect(context).toMatchObject({
    displayedRows: 20,
    totalResultRows: 40,
    outputTruncated: true,
    inputSampled: false,
  })
})
