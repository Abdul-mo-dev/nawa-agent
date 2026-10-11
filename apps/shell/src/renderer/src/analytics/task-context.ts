import type { AnalyticsReadAction } from '../../../shared/analytics-api'
import { pathKey } from '../explorer/model'

/** Bounded, source-checked schemas let the first model turn calculate without catalog discovery. */
export async function selectedTableTaskContext(
  client: { analytics(action: AnalyticsReadAction, payload: unknown): Promise<unknown> },
  selection: string | readonly string[],
): Promise<string> {
  const paths = [
    ...new Map(
      (typeof selection === 'string' ? [selection] : selection).map((path) => [
        pathKey(path),
        path,
      ]),
    ).values(),
  ]
  const allowed = new Set(paths.map(pathKey))
  const path = paths.length === 1 ? paths[0] : undefined
  const query = path ? path.replace(/\\/g, '/').split('/').pop()! : ''
  const catalog = (paths.length ? await client.analytics('discover', { query }) : {}) as {
    datasets?: Record<string, unknown>[]
    nextOffset?: number | null
    selectedFiles?: Record<string, unknown>[]
    nextFileOffset?: number | null
  }
  const matching = (catalog.datasets ?? []).filter(
    (dataset) => typeof dataset.path === 'string' && allowed.has(pathKey(dataset.path)),
  )
  const datasets = matching.slice(0, 8).map((dataset) => ({
    id: dataset.id,
    path: dataset.path,
    sourceHash: dataset.sourceHash,
    generation: dataset.generation,
    name: dataset.name,
    sheet: dataset.sheet,
    range: dataset.range,
    status: dataset.status,
    approval: dataset.approval,
    preparationState: dataset.preparationState,
    reason: dataset.reason,
    grain: dataset.grain,
    columns: dataset.columns,
    totalColumns: dataset.totalColumns,
    moreColumns: dataset.moreColumns,
    warnings: dataset.warnings,
  }))
  const matchingFiles = (catalog.selectedFiles ?? []).filter(
    (file) => typeof file.path === 'string' && allowed.has(pathKey(file.path)),
  )
  const files = matchingFiles.map((file) => ({
    path: file.path,
    state: file.state,
    tables: file.tables,
    message: file.message,
  }))
  const context = () =>
    JSON.stringify({
      path,
      query,
      metadataOnly: true,
      datasets,
      datasetsOmittedFromThisPage: matching.length - datasets.length,
      nextOffset: catalog.nextOffset ?? null,
      ...(!path
        ? {
            selectedFileCount: paths.length,
            selectedFiles: files,
            selectedFilesOmittedFromThisPage: matchingFiles.length - files.length,
            nextFileOffset: catalog.nextFileOffset ?? null,
          }
        : {}),
      guidance:
        'Reuse Ready dataset IDs and actual columns to execute query_data/analyze_data immediately. This is schema metadata, not a calculated answer. Do not repeat preparation or inspect_file just to find a column. A row count needs no column. Independent calculations can be requested together in one model turn; do not union unrelated tables. Use describe_dataset for missing columns, raw SQL decimal scales or ambiguous populations. Follow discovery/column/file pagination for omitted coverage. Keep blocked or unsupported sources explicit.',
    })
  while (new TextEncoder().encode(context()).length > 6000 && (datasets.length || files.length)) {
    if (datasets.length) datasets.pop()
    else files.pop()
  }
  return context()
}
