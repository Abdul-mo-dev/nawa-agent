import type { Dataset, TablePolicy } from '../../shared/analytics-api'

/** Carry semantic decisions forward only when the source columns still have the same binding. */
export function refreshedPolicy(
  previous: Dataset | undefined,
  current: Dataset,
): {
  policy: TablePolicy
  notes: string[]
  reviewReasons: string[]
} {
  const review =
    'The source table structure changed during background refresh. Review its headers, boundaries and row meaning before analysis.'
  const prior = previous?.preparedPolicy?.policy ?? previous?.policy
  if (
    !previous ||
    !prior ||
    prior.headerRow !== current.policy.headerRow ||
    prior.firstColumn !== current.policy.firstColumn ||
    prior.lastColumn !== current.policy.lastColumn ||
    prior.columns.length !== current.policy.columns.length ||
    prior.columns.some(
      (column, index) =>
        column.id !== current.policy.columns[index]!.id ||
        column.name !== current.policy.columns[index]!.name,
    )
  )
    return {
      policy: { ...current.policy, grain: current.policy.grain || 'One source data record' },
      notes: [review],
      reviewReasons: [review],
    }

  const policy: TablePolicy = {
    ...prior,
    confirmed: false,
    columns: prior.columns.map((column, index) => ({
      ...column,
      // Increasing decimal precision is safe; every value is still validated exactly.
      scale:
        column.type === 'decimal'
          ? Math.max(column.scale, current.policy.columns[index]!.scale)
          : column.scale,
    })),
  }
  if (previous.approval?.by === 'agent') {
    // Automatically approved policies cover the whole imported population.
    policy.firstRow = current.policy.firstRow
    policy.lastRow = current.policy.lastRow
  }
  const reviewReasons: string[] = []
  if (previous.status !== 'ready')
    reviewReasons.push(
      'The previous table policy still needed review. Background refresh does not resolve that decision.',
    )
  const oldBounds = previous.profile.sourceBounds as
    { firstRow: number; lastRow: number | null } | undefined
  const newBounds = current.profile.sourceBounds as
    { firstRow: number; lastRow: number | null } | undefined
  if (oldBounds?.firstRow !== newBounds?.firstRow) reviewReasons.push(review)
  return {
    policy,
    notes: [
      'Previous row meaning, units, keys, types and exclusions were retained for full validation.',
      ...reviewReasons,
    ],
    reviewReasons,
  }
}
