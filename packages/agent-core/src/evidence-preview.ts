/** A bounded preview retains receipts/population and never represents omitted data as complete. */
export function boundedToolEvidence(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    /* Plain text is wrapped with an explicit range notice. */
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>
    const preview: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
      if (
        [
          'rows',
          'Rows',
          'preview',
          'cells',
          'blocks',
          'hits',
          'entries',
          'datasets',
          'tools',
          'columns',
        ].includes(key) &&
        Array.isArray(item)
      ) {
        preview[key] = item.slice(0, key === 'tools' ? 3 : 5)
        if (item.length > (preview[key] as unknown[]).length)
          preview[`${key}Omitted`] = item.length - (preview[key] as unknown[]).length
      } else if (typeof item === 'string' && item.length > maxChars / 2) {
        preview[key] = item.slice(0, Math.floor(maxChars / 2))
        preview[`${key}Truncated`] = true
      } else preview[key] = item
    }
    preview.contextTruncated = true
    preview.outputTruncated = true
    if (Array.isArray(preview.rows)) preview.displayedRows = preview.rows.length
    preview.contextNotice =
      'Only a bounded preview fits this model request. Full source/result remains in Nawa. Use its receipt or request a narrower range; omitted content is not evidence of absence.'
    const encoded = JSON.stringify(preview)
    if (encoded.length <= maxChars) return encoded
    // Large nested data or schemas cannot be safely cut inside JSON.
    const receipt: Record<string, unknown> = {
      contextTruncated: true,
      outputTruncated: true,
      contextNotice:
        'Result omitted from model context. Request a smaller page, range or column limit using this receipt/session. Do not infer values from this notice.',
    }
    for (const key of [
      'id',
      'datasetId',
      'inspectionId',
      'path',
      'sourceHash',
      'generation',
      'totalResultRows',
    ]) {
      const item = source[key]
      if (
        (typeof item === 'string' || typeof item === 'number') &&
        JSON.stringify({ ...receipt, [key]: item }).length <= maxChars
      )
        receipt[key] = item
    }
    if (Array.isArray(source.sources)) receipt.sourceCount = source.sources.length
    return JSON.stringify(receipt)
  }
  return JSON.stringify({
    contextTruncated: true,
    textPreview: output.slice(0, Math.max(100, maxChars - 350)),
    contextNotice:
      'Partial text preview. The remaining content was omitted from model context. Request a narrower range; this is not a complete read.',
  })
}
