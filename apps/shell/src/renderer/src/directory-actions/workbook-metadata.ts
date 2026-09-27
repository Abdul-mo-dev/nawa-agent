import type { DirectoryCitation } from '../../../shared/directory-evidence'

/** Bounded, valid JSON for model context. Never slice a serialized result mid-field. */
export function workbookOverviewMetadata(content: string, citations: readonly DirectoryCitation[] = []): string | undefined {
  let value: { datasets?: unknown[]; coverage?: { metadataTruncated?: boolean; catalogLimitReached?: boolean } }
  try { value = JSON.parse(content) } catch { return undefined }
  if (!value || !Array.isArray(value.datasets) || !value.datasets.length) return undefined
  let truncated = value.coverage?.metadataTruncated === true
  const datasets = value.datasets.slice(0, 10).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)).map(item => {
    const row: Record<string, unknown> = {}
    // Exact identities remain usable; omit an overlong identity rather than inventing one.
    for (const key of ['Id', 'SqlObjectName', 'DisplayName']) if (typeof item[key] === 'string') {
      if (item[key].length <= 500) row[key] = item[key]
      else truncated = true
    }
    if (typeof item.IsLogical === 'boolean') row.IsLogical = item.IsLogical
    for (const key of ['ColumnCount', 'MemberCount']) if (typeof item[key] === 'number') row[key] = item[key]
    for (const key of ['SheetNames', 'ColumnNames']) if (Array.isArray(item[key])) {
      const values = item[key].filter((field): field is string => typeof field === 'string')
      row[key] = values.slice(0, 80).map(field => {
        if (field.length <= 600) return field
        truncated = true; return field.slice(0, 600) + '…'
      })
      if (values.length > 80 || key === 'ColumnNames' && typeof item.ColumnCount === 'number' && item.ColumnCount > values.length) truncated = true
    }
    return row
  }).filter(row => Object.keys(row).length > 0)
  if (!datasets.length) return undefined
  const result = { kind: 'workbook-overview', datasets, coverage: {
    returnedDatasets: value.datasets.length, includedDatasets: datasets.length,
    catalogLimitReached: value.datasets.length >= 10 || value.coverage?.catalogLimitReached === true, completeWorkbook: false,
    metadataTruncated: truncated || value.datasets.length !== datasets.length,
  }, citations: citations.slice(0, 4).map(({ id, path, sourceHash, locator }) => ({ id, path, sourceHash, locator })) }
  let encoded = JSON.stringify(result)
  // Reduce each dataset evenly so later sheets survive long survey column labels.
  while (encoded.length > 12000) {
    let reduced = false
    for (const row of datasets) if (Array.isArray(row.ColumnNames) && row.ColumnNames.length > 1) {
      row.ColumnNames = row.ColumnNames.slice(0, Math.ceil(row.ColumnNames.length / 2)); reduced = true
    }
    if (!reduced) {
      if (datasets.length <= 1) return undefined
      datasets.pop()
    }
    result.coverage.includedDatasets = datasets.length; result.coverage.metadataTruncated = true
    encoded = JSON.stringify(result)
  }
  return encoded
}
