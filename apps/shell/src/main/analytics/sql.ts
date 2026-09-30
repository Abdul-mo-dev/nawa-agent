import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type { AnalyticsResult } from '../../shared/analytics-api'
import { QuerySession } from './query'
import { jsonSafe } from './numeric'
import { int, list, object, text } from './validation'

const { constants } = createRequire(import.meta.url)('node:' + 'sqlite') as typeof import('node:sqlite')

/** SQLite itself authorizes every referenced object, including nested CTEs and subqueries. */
export function executeSql(session: QuerySession, raw: unknown): AnalyticsResult {
  const request = object(raw, 'SQLite query')
  const ids = list(request.datasetIds, 'dataset IDs', 16).map(value => text(value, 'dataset ID', 80))
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Choose 1 to 16 distinct Ready datasets.')
  const datasets = ids.map(id => session.dataset(id))
  const allowed = new Set(datasets.map(record => record.typedTable!))
  if (typeof session.db.setAuthorizer !== 'function') throw new Error('Read-only SQL requires a current Nawa build with SQLite authorizer support.')
  session.db.setAuthorizer((action, first, second, database) => {
    // SQLite reports no database name for its COUNT(*) fast path; the table still must be allowed.
    if (action === constants.SQLITE_READ) return (database === 'main' || database === null) && allowed.has(first ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK
    if (action === constants.SQLITE_FUNCTION && !['load_extension', 'readfile', 'writefile'].includes((second ?? '').toLowerCase())) return constants.SQLITE_OK
    return constants.SQLITE_DENY
  })
  const sql = text(request.sql, 'SQL', 16000).trim().replace(/;\s*$/, '')
  const parameters: SQLInputValue[] = list(request.parameters ?? [], 'SQL parameters', 128).map(value => {
    if (value === null || typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value
    throw new Error('SQL parameters must be null, strings or finite safe numbers. Pass large integers as strings and CAST(? AS INTEGER).')
  })
  const limit = request.limit === undefined ? session.settings.resultRows : int(request.limit, 'displayed rows', 1, session.settings.resultRows)
  // Wrapping accepts one SELECT/WITH statement only and caps displayed rows, never aggregate inputs.
  const executed = `SELECT * FROM (${sql}\n) AS nawa_result WHERE analytics_guard() LIMIT ?`
  const statement = session.statement(executed, [...parameters, limit + 1])
  const rows: Record<string, unknown>[] = []
  for (const row of statement.iterate(...parameters, limit + 1)) {
    session.check()
    if (Object.values(row).some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('SQL returned a non-finite number. Narrow or correct the calculation.')
    rows.push(jsonSafe(row) as Record<string, unknown>)
  }
  const truncated = rows.length > limit
  const count = rows.length
  if (truncated) rows.pop()
  const sources = datasets.map(({ data }) => ({ path: data.path, hash: data.sourceHash, datasetId: data.id, generation: data.generation }))
  return {
    id: randomUUID(), createdAt: Date.now(), operation: 'sql', sources, sql: [executed], parameters: [jsonSafe([...parameters, limit + 1]) as unknown[]],
    population: { datasets: datasets.map(({ data, typedTable }) => ({ datasetId: data.id, sqlTable: typedTable, path: data.path, rows: data.rows, excludedRows: data.excludedRows, grain: data.policy.grain })), queryPopulation: 'Defined by the recorded SQL, including filters and joins.' },
    columns: statement.columns().map(column => ({ name: column.name, declaredType: column.type })), rows,
    totalResultRows: count, displayedRows: rows.length, outputTruncated: truncated, inputSampled: false,
    summary: { totalResultRowsExact: !truncated }, request,
    warnings: [...new Set(datasets.flatMap(record => record.data.warnings)), 'SQL integers are serialized as strings. Decimal columns store exact scaled integers: use the declared scale. SQLite SUM may overflow and AVG/REAL math is approximate; use query_data/analyze_data for exact decimal arithmetic. Check join multiplicity and mixed units before interpreting totals.', ...(truncated ? ['Displayed result is capped; totalResultRows is a lower bound. Aggregates run over the SQL-defined input population.'] : [])],
  }
}
