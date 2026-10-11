/** Keep numerical evidence in chat; execution details remain in the saved receipt. */
export function analyticalResultContext(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = value as Record<string, unknown>
  if (
    typeof result.id !== 'string' ||
    !Array.isArray(result.sources) ||
    !Array.isArray(result.rows) ||
    typeof result.totalResultRows !== 'number' ||
    typeof result.displayedRows !== 'number'
  )
    return value

  const details = new Set(['sql', 'parameters', 'request', 'createdAt'])
  const context = Object.fromEntries(Object.entries(result).filter(([key]) => !details.has(key)))
  const rows = result.rows.slice(0, 20)
  context.rows = rows
  context.displayedRows = rows.length
  context.outputTruncated = result.outputTruncated === true || rows.length < result.rows.length
  context.receiptDetails = { tool: 'inspect_result', resultId: result.id }
  if (result.request && typeof result.request === 'object' && !Array.isArray(result.request))
    context.request = Object.fromEntries(
      Object.entries(result.request).filter(([key]) => !['sql', 'parameters'].includes(key)),
    )
  if (rows.length < result.rows.length)
    context.warnings = [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      'The chat preview is limited to 20 result rows. Calculation coverage is unchanged; saved receipt display limits still apply.',
    ]
  if (Array.isArray(result.citations))
    context.citations = result.citations.map((citation: unknown) =>
      citation && typeof citation === 'object' && !Array.isArray(citation)
        ? Object.fromEntries(Object.entries(citation).filter(([key]) => key !== 'excerpt'))
        : citation,
    )
  return context
}
