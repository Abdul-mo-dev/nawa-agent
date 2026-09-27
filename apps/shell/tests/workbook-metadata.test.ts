import { expect, it } from 'vitest'
import { workbookOverviewMetadata } from '../src/renderer/src/directory-actions/workbook-metadata'

it('retains sheet and column evidence and exact dataset identities without duplicate schema text', () => {
  const citation = { id: 'RAG:one', path: 'C:\\Survey data.xlsx', sourceHash: 'a'.repeat(64), locator: 'spreadsheet_catalog_search' }
  const packed = JSON.parse(workbookOverviewMetadata(JSON.stringify({ datasets: [{ Id: 'dataset', SqlObjectName: 'sql_id', DisplayName: 'Logical survey', IsLogical: true, SheetNames: ['Survey 1', 'Survey 2'], ColumnNames: ['Safety perception', 'Neighbor interaction'], ColumnCount: 2, SchemaSignature: 'repeated definitions', RowCount: 123 }] }), [citation])!)
  expect(packed.datasets[0]).toMatchObject({ Id: 'dataset', SqlObjectName: 'sql_id', SheetNames: ['Survey 1', 'Survey 2'], ColumnNames: ['Safety perception', 'Neighbor interaction'] })
  expect(packed.datasets[0].SchemaSignature).toBeUndefined(); expect(packed.datasets[0].RowCount).toBeUndefined()
  expect(packed.coverage).toMatchObject({ completeWorkbook: false, metadataTruncated: false })
  expect(packed.citations).toEqual([citation])
})
it('keeps later sheets and reports reductions when long survey questions exceed the context budget', () => {
  const content = JSON.stringify({ datasets: Array.from({ length: 10 }, (_, index) => ({ Id: `id-${index}`, SqlObjectName: `sql-${index}`,
    SheetNames: [`Survey ${index}`], ColumnNames: Array.from({ length: 65 }, (_, c) => `Question ${c}: ${'long survey wording '.repeat(25)}`), ColumnCount: 65 })) })
  const packed = workbookOverviewMetadata(content)!, value = JSON.parse(packed)
  expect(packed.length).toBeLessThanOrEqual(12000)
  expect(value.datasets.at(-1).SheetNames).toEqual(['Survey 9'])
  expect(value.coverage).toMatchObject({ returnedDatasets: 10, includedDatasets: 10, catalogLimitReached: true, metadataTruncated: true, completeWorkbook: false })
  const reused = JSON.parse(workbookOverviewMetadata(packed)!)
  expect(reused.coverage.metadataTruncated).toBe(true)
})
it.each(['broken JSON', 'null', '{"datasets":[]}', '{"resultId":"retained"}', '{"datasets":[null]}', '{"datasets":[{}]}'])('leaves missing metadata for the reader fallback: %s', content => {
  expect(workbookOverviewMetadata(content)).toBeUndefined()
})
