import { DEFAULT_ANALYTICS_SETTINGS, type AnalyticsSettings, type TablePolicy, type DataColumn } from '../../shared/analytics-api'
export function object(value: unknown, label = 'arguments'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected an object.`)
  return value as Record<string, unknown>
}
export function text(value: unknown, label: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw new Error(`Invalid ${label}.`)
  return value
}
export function int(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`)
  return value
}
export function list(value: unknown, label: string, max = 32): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}: at most ${max} entries.`)
  return value
}
export function id(value: unknown, label = 'identifier'): string {
  const result = text(value, label, 128)
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(result)) throw new Error(`Invalid ${label}. Use the identifier from the catalog.`)
  return result
}
export function settings(raw: unknown): AnalyticsSettings {
  const r = { ...DEFAULT_ANALYTICS_SETTINGS, ...object(raw, 'analytics settings') }
  return {
    maxFileMiB: int(r.maxFileMiB, 'Maximum file size', 1, 8192),
    maxRows: int(r.maxRows, 'Maximum rows', 1, 10000000),
    maxColumns: int(r.maxColumns, 'Maximum columns', 1, 1024),
    queryTimeoutSeconds: int(r.queryTimeoutSeconds, 'Query timeout', 5, 600),
    maxGroups: int(r.maxGroups, 'Maximum output groups', 100, 100000),
    resultRows: int(r.resultRows, 'Displayed result rows', 1, 500),
    retainedResults: int(r.retainedResults, 'Retained result records', 10, 10000),
  }
}
export function policy(raw: unknown, maxColumns: number): TablePolicy {
  const r = object(raw, 'table policy')
  const columns = list(r.columns, 'columns', maxColumns).map((v, i): DataColumn => {
    const c = object(v, 'column'), type = text(c.type, 'column type') as DataColumn['type']
    if (!['text', 'integer', 'decimal', 'real', 'date', 'boolean'].includes(type)) throw new Error('Unsupported column type.')
    const role = text(c.role, 'column role') as DataColumn['role']
    if (!['identifier', 'dimension', 'measure'].includes(role)) throw new Error('Invalid column role.')
    if (c.id !== `c${i}`) throw new Error('Keep column IDs in order: c0, c1, ... .')
    if (typeof c.nullable !== 'boolean') throw new Error('nullable must be true or false.')
    return { id: `c${i}`, name: text(c.name, 'column name', 256), type,
      scale: type === 'decimal' ? int(c.scale, 'Decimal scale', 0, 12) : 0, role,
      unit: text(c.unit ?? '', 'unit', 128, true), nullable: c.nullable,
      description: text(c.description ?? '', 'column description', 2000, true) }
  })
  if (!columns.length || new Set(columns.map(c => c.name.normalize('NFKC').toLowerCase())).size !== columns.length) throw new Error('Column names must be nonempty and unique.')
  const firstColumn = int(r.firstColumn, 'First column', 1, 16384), lastColumn = int(r.lastColumn, 'Last column', firstColumn, 16384)
  if (lastColumn - firstColumn + 1 !== columns.length) throw new Error('Column count must match the declared source column range.')
  const firstRow = int(r.firstRow, 'First data row', 1, 10000001)
  const headerRow = int(r.headerRow, 'Header row (0 for none)', 0, firstRow - 1)
  const key = list(r.key ?? [], 'key columns', 16).map(v => id(v))
  const currencyColumn = r.currencyColumn == null || r.currencyColumn === '' ? null : id(r.currencyColumn)
  for (const k of [...key, ...(currencyColumn ? [currencyColumn] : [])]) if (!columns.some(c => c.id === k)) throw new Error(`Unknown policy column: ${k}.`)
  if (!['reject', 'saved-cache'].includes(String(r.formulaPolicy))) throw new Error('Choose reject or saved-cache for formulas.')
  return { name: text(r.name, 'table name', 256), description: text(r.description ?? '', 'description', 4000, true),
    grain: text(r.grain, 'row grain', 1000), headerRow, firstRow,
    lastRow: r.lastRow == null ? null : int(r.lastRow, 'Last data row', firstRow, 10000000), firstColumn, lastColumn, columns, key,
    currencyColumn, includeHiddenRows: r.includeHiddenRows === true,
    skipRows: [...new Set(list(r.skipRows ?? [], 'excluded source rows', 10000).map(v => int(v, 'excluded row', 1, 10000000)))],
    formulaPolicy: r.formulaPolicy as TablePolicy['formulaPolicy'], confirmed: r.confirmed === true }
}
export function message(e: unknown): string { return e instanceof Error ? e.message : String(e) }
