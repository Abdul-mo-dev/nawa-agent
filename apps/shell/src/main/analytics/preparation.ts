import { basename, isAbsolute } from 'node:path'
import type { Dataset, TablePolicy } from '../../shared/analytics-api'
import { samePath } from '../directory-actions/file-safety'
import type { RawRow } from './stream'
import { quotedTable, type AnalyticsStore, type StoredDataset } from './store'
import { object } from './validation'

/** Resolve model-supplied names against the selection, never against a working directory. */
export function preparationTargets(selectedPaths: string[], requestedPaths: string[]): string[] {
  const targets: string[] = []
  const fileName = (path: string) => process.platform === 'win32' ? basename(path).toLowerCase() : basename(path)
  for (const requested of requestedPaths) {
    const matches = isAbsolute(requested)
      ? selectedPaths.filter(path => samePath(path, requested))
      : requested === basename(requested) && !/[\\/]/.test(requested) && requested !== '.' && requested !== '..'
        ? selectedPaths.filter(path => fileName(path) === fileName(requested)) : []
    const unique = matches.filter((path, index) => matches.findIndex(other => samePath(path, other)) === index)
    if (unique.length > 1) throw new Error(`Ambiguous selected filename: ${requested}. Use its full selected path, or omit paths to prepare all selected files.`)
    const selected = unique[0]
    if (!selected) throw new Error('Preparation can only import individually selected files. Omit paths for the full selection, or use a selected full path or unique filename.')
    if (!targets.some(path => samePath(path, selected))) targets.push(selected)
  }
  return targets
}

/** Suggestions are metadata hints. The agent must supply row meaning and validate its proposed policy. */
export function suggestedPolicy(store: AnalyticsStore, record: StoredDataset): TablePolicy {
  const base = record.data.policy
  const header = base.headerRow ? store.db.prepare(`SELECT data FROM ${quotedTable(record.rawTable)} WHERE row=?`).get(base.headerRow) as { data: string } | undefined : undefined
  const cells = header ? (JSON.parse(header.data) as RawRow).cells : {}
  const columns = base.columns.map((column, index) => {
    const visible = cells[base.firstColumn + index]?.value?.trim()
    const name = /^column\s*\d+$/i.test(column.name) && visible && visible.length <= 256 ? visible : column.name
    const numeric = ['integer', 'decimal', 'real'].includes(column.type)
    const unit = column.unit || (numeric ? name.match(/\b(bytes?|JPY|USD|EUR|GBP|kg|km)\b/i)?.[0] ?? (name.includes('%') ? 'percent' : '') : '')
    const identifier = /^(?:relative[ _]path|path|id|identifier)$|(?:[ _]id)$/i.test(name)
    return { ...column, name, unit, role: identifier ? 'identifier' as const : column.role }
  })
  // Preserve a valid schema if visible headers conflict with table metadata or each other.
  const names = columns.map(column => column.name.normalize('NFKC').toLowerCase())
  if (new Set(names).size !== names.length) return { ...base, confirmed: false }
  return { ...base, columns, confirmed: false }
}

/** A structural baseline is safe to draft without inventing business units or mandatory keys. */
export function baselinePolicy(store: AnalyticsStore, record: StoredDataset): { policy: TablePolicy; notes: string[] } {
  const policy = suggestedPolicy(store, record)
  const names = new Set(policy.columns.map(column => column.name.normalize('NFKC').toLowerCase()))
  if (!policy.grain.trim()) {
    if (names.has('name') && names.has('type') && names.has('relative path')) policy.grain = 'One directory entry (file or folder)'
    else {
      policy.grain = 'One source data record'
    }
  }
  return { policy, notes: preparationNotes(policy) }
}

export function preparationNotes(policy: TablePolicy): string[] {
  const notes: string[] = []
  if (policy.grain === 'One source data record') notes.push('Row meaning is provisional. Confirm the business meaning of one row before approval.')
  if (policy.columns.some(column => column.role === 'measure' && !column.unit)) notes.push('Some units are unspecified. Confirm units and currencies before treating these columns as business measures.')
  if (!policy.key.length) notes.push('No unique business key is declared. Single-table analysis is available after approval; combining exports or joining tables requires a verified key.')
  return notes
}

/** Automatic publication preserves the imported population and leaves ambiguous exclusions for review. */
export function automaticApprovalIssues(dataset: Dataset, policy: TablePolicy): string[] {
  const issues: string[] = []
  if (dataset.status === 'ready' && dataset.approval?.by !== 'agent') issues.push('A user-approved table already has an applied policy. Review any replacement policy before applying it.')
  if (policy.formulaPolicy !== 'reject') issues.push('Accepting saved formula caches requires a user decision.')
  if (policy.includeHiddenRows || Number(dataset.profile.hiddenRows ?? 0) > 0) issues.push('Hidden source rows require a decision about the intended population.')
  if (Array.isArray(dataset.profile.possibleSubtotalRows) && dataset.profile.possibleSubtotalRows.length) issues.push('Possible total/subtotal rows require a decision about the intended population.')
  const population = ['headerRow', 'firstRow', 'lastRow', 'firstColumn', 'lastColumn'] as const
  if (policy.skipRows.length || population.some(key => policy[key] !== dataset.policy[key])) issues.push('Changed row boundaries or exclusions require a decision about the intended population.')
  if (policy.columns.some(column => /^column\s*\d+$/i.test(column.name))) issues.push('Generic column names require clarification of the table headers.')
  return issues
}

/** Partial policy updates preserve omitted columns, keys and exclusions, including wide schemas. */
export function mergePolicy(base: TablePolicy, raw: unknown): TablePolicy {
  const patch = object(raw, 'proposed policy')
  const allowed = new Set(Object.keys(base))
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unknown table policy field: ${key}.`)
  const columns = base.columns.map(column => ({ ...column }))
  if (patch.columns !== undefined) {
    if (!Array.isArray(patch.columns) || patch.columns.length > columns.length) throw new Error('Propose column changes using existing column IDs.')
    const seen = new Set<string>()
    for (const rawColumn of patch.columns) {
      const change = object(rawColumn, 'proposed column')
      const index = columns.findIndex(column => column.id === change.id)
      if (index < 0 || seen.has(String(change.id))) throw new Error('Proposed column IDs must exist and be unique.')
      const allowedColumn = new Set(Object.keys(columns[index]!))
      for (const key of Object.keys(change)) if (!allowedColumn.has(key)) throw new Error(`Unknown column policy field: ${key}.`)
      seen.add(String(change.id))
      columns[index] = { ...columns[index]!, ...change }
    }
  }
  return { ...base, ...patch, columns, confirmed: false } as TablePolicy
}
