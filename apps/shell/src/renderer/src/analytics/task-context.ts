import type { AnalyticsReadAction } from '../../../shared/analytics-api'
import { pathKey } from '../explorer/model'

/** Read-only, source-checked table metadata for a question about one selected file. */
export async function selectedTableTaskContext(
  client: { analytics(action: AnalyticsReadAction, payload: unknown): Promise<unknown> },
  path: string,
): Promise<string> {
  const query = path.replace(/\\/g, '/').split('/').pop()!
  const catalog = (await client.analytics('discover', { query })) as {
    datasets?: Record<string, unknown>[]
    nextOffset?: number | null
  }
  const matching = (catalog.datasets ?? []).filter(
    (dataset) => typeof dataset.path === 'string' && pathKey(dataset.path) === pathKey(path),
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
    reason: dataset.reason,
    grain: dataset.grain,
    columns: dataset.columns,
    totalColumns: dataset.totalColumns,
    moreColumns: dataset.moreColumns,
    warnings: dataset.warnings,
  }))
  const context = () =>
    JSON.stringify({
      path,
      query,
      metadataOnly: true,
      datasets,
      datasetsOmittedFromThisPage: matching.length - datasets.length,
      nextOffset: catalog.nextOffset ?? null,
      guidance:
        'Reuse Ready dataset IDs and actual columns to execute query_data/query_sql/analyze_data. This is schema metadata, not a calculated answer. Do not repeat preparation or inspect_file just to find an employee column. A row count needs no column. If multiple tables could represent the requested population, inspect their schemas and establish coverage before choosing or asking about a genuine ambiguity. Follow discovery/column pagination for omitted tables or columns.',
    })
  while (new TextEncoder().encode(context()).length > 6000 && datasets.length) datasets.pop()
  return context()
}
