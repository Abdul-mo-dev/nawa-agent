import type { AnalyticsReadAction } from '../../../shared/analytics-api'

type Analytics = (action: AnalyticsReadAction, payload: unknown) => Promise<unknown>
interface CatalogDataset { id: string; generation: string; name: string; status: string; reason?: string }
interface ReviewedDataset { generation: string; total: number; seen: Set<number> }

/** Guides a clicked export through the same paginated descriptions the backend requires. */
export class ExportReview {
  private prepared = false
  private catalog: CatalogDataset[] | null = null
  private pages = new Map<number, { datasets: CatalogDataset[]; nextOffset: number | null }>()
  private reviewed = new Map<string, ReviewedDataset>()

  markPrepared(value: unknown): void {
    this.prepared = true
    this.catalog = null
    this.pages.clear()
    this.reviewed.clear()
    this.discover(value, 0)
  }

  hasPrepared(): boolean { return this.prepared }

  discover(value: unknown, offset: number): void {
    if (!this.prepared || !value || typeof value !== 'object') return
    const page = value as { datasets?: unknown; nextOffset?: unknown }
    if (!Array.isArray(page.datasets) || !('nextOffset' in page)) return
    if (page.nextOffset !== null && (!Number.isInteger(page.nextOffset) || (page.nextOffset as number) <= offset)) return
    this.pages.set(offset, { datasets: page.datasets as CatalogDataset[], nextOffset: page.nextOffset as number | null })
  }

  describe(value: unknown, offset: number): void {
    if (!value || typeof value !== 'object') return
    const result = value as { id?: unknown; generation?: unknown; totalColumns?: unknown; policy?: { columns?: unknown[] } }
    if (typeof result.id !== 'string' || typeof result.generation !== 'string' ||
        !Number.isInteger(result.totalColumns) || (result.totalColumns as number) < 0 ||
        !Array.isArray(result.policy?.columns)) return
    const total = result.totalColumns as number
    let record = this.reviewed.get(result.id)
    if (!record || record.generation !== result.generation || record.total !== total) {
      record = { generation: result.generation, total, seen: new Set() }
      this.reviewed.set(result.id, record)
    }
    for (let index = offset; index < Math.min(total, offset + result.policy.columns.length); index++) record.seen.add(index)
  }

  policy(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const result = value as { datasetId?: unknown; generation?: unknown; status?: unknown }
    if (typeof result.datasetId !== 'string' || typeof result.generation !== 'string') return
    const reviewed = this.reviewed.get(result.datasetId)
    if (reviewed) reviewed.generation = result.generation
    for (const catalog of [this.catalog, ...[...this.pages.values()].map(page => page.datasets)]) {
      const dataset = catalog?.find(entry => entry.id === result.datasetId)
      if (!dataset) continue
      dataset.generation = result.generation
      if (typeof result.status === 'string') dataset.status = result.status
    }
  }

  async next(analytics: Analytics, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!this.prepared) return { status: 'preparation-required', next: 'Call prepare_data with {} for the entire clicked selection before exporting.' }
    if (!this.catalog) {
      const datasets: CatalogDataset[] = []
      let offset = 0
      for (let page = 0; page < 1000; page++) {
        if (signal?.aborted) throw new Error('Analysis cancelled.')
        const result = this.pages.get(offset) ?? await analytics('discover', { offset }) as { datasets?: CatalogDataset[]; nextOffset?: number | null }
        if (!Array.isArray(result.datasets)) throw new Error('Dataset discovery did not return a catalog. Retry the selection.')
        datasets.push(...result.datasets)
        if (result.nextOffset == null) { this.catalog = datasets; break }
        if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) throw new Error('Dataset discovery pagination did not advance.')
        offset = result.nextOffset
      }
      if (!this.catalog) throw new Error('Too many dataset catalog pages to review in one request. Select fewer files.')
    }
    const unavailable = this.catalog.filter(dataset => dataset.status === 'unavailable')
    if (unavailable.length) return { status: 'source-unavailable', datasets: unavailable, next: 'A selected source changed or became unavailable. Restart Prepare & export with the current files.' }
    for (const dataset of this.catalog) {
      if (signal?.aborted) throw new Error('Analysis cancelled.')
      const record = this.reviewed.get(dataset.id)
      if (record?.generation === dataset.generation && record.seen.size === record.total) continue
      let offset = 0
      if (record?.generation === dataset.generation) while (record.seen.has(offset)) offset++
      const description = await analytics('describe', { datasetId: dataset.id, columnOffset: offset, columnLimit: 32 })
      this.describe(description, offset)
      return {
        status: 'review-required', datasetId: dataset.id, datasetName: dataset.name, columnOffset: offset,
        description, remainingTables: this.catalog.length - this.catalog.indexOf(dataset) - 1,
        next: 'Review this table schema and source evidence. Apply a clear draft using propose_table_policy; leave genuinely ambiguous tables pending. Call export_sqlite again to continue reviewing missing pages or publish Ready tables. No export has been written yet.',
      }
    }
    return null
  }
}
