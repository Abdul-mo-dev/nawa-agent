export const MAX_ROW_GRAIN_LENGTH = 1000

/** The review form and worker must require the same explicit row definition. */
export function rowGrainError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return 'Describe what one row represents before approving the table, for example one invoice line or one customer.'
  }
  if (value.length > MAX_ROW_GRAIN_LENGTH) {
    return 'The row description must be at most 1,000 characters.'
  }
  if (value.includes('\0')) {
    return 'The row description contains an invalid character.'
  }
  return null
}
