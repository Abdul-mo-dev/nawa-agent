import type { DirectoryInspection } from '../../../shared/directory-actions-api'

export const WORKSHEET_BOUNDS_GUIDANCE = 'Worksheet dimensions and used-range endpoints describe bounds, not employee, record, non-empty or distinct counts. Do not subtract a presumed header from the last row to answer a count. Use a scoped MyAgent SQL aggregate, an approved analytical query, or inspect the header and aggregate_range over the relevant ID column. Check blanks, duplicates, hidden rows and coverage; report what was actually counted.'

/** The live editor's size shortcut is inappropriate for directory record counts. */
export function worksheetContextEvidence(context: string): string {
  return context.replace(/ \(answer data-size questions directly from this[^)]*\)/g, ' (worksheet bounds only)') +
    '\n\nDirectory analysis guidance: ' + WORKSHEET_BOUNDS_GUIDANCE
}

export function inspectionEvidence(inspection: DirectoryInspection): DirectoryInspection {
  if (inspection.kind !== 'sheets') return inspection
  return { ...inspection, context: worksheetContextEvidence(inspection.context), tools: inspection.tools.map(tool => {
    if (tool.name === 'get_workbook_context') return { ...tool,
      description: 'Get sheet names/IDs, worksheet bounds, current selection and known cells. Bounds do not count data records. ' + WORKSHEET_BOUNDS_GUIDANCE }
    if (tool.name === 'read_range') return { ...tool,
      description: 'Read values/formulas in a rectangular range with cell locations, at most 2000 cells. Use it to inspect headers and concrete values. A bounded read or ending row cannot establish a complete record count; use SQL or aggregate_range over the appropriate column.' }
    return tool
  }) }
}
