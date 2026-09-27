import type { DataColumn } from '../../shared/analytics-api'
export const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n
export const pow10 = (n: number): bigint => 10n ** BigInt(n)
/** Parse decimal/scientific source lexemes without routing them through Number. */
export function decimal(value: string): { coefficient: bigint; scale: number } {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim())
  if (!m || value.length > 128) throw new Error(`Not an unambiguous decimal: ${value.slice(0, 80)}`)
  const exponent = Number(m[4] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) throw new Error('Decimal exponent is outside the supported range.')
  let scale = (m[3]?.length ?? 0) - exponent
  let coefficient = BigInt((m[1] === '-' ? '-' : '') + m[2] + (m[3] ?? ''))
  if (scale < 0) { coefficient *= pow10(-scale); scale = 0 }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale-- }
  return { coefficient, scale }
}
export function scaled(value: string, scale: number): bigint {
  const d = decimal(value)
  if (d.scale > scale) throw new Error(`Value ${value} needs ${d.scale} decimal places; declared scale is ${scale}. No rounding was applied.`)
  const n = d.coefficient * pow10(scale - d.scale)
  if (n < MIN_I64 || n > MAX_I64) throw new Error('Value exceeds exact signed 64-bit storage. Keep it as text or change the unit/scale.')
  return n
}
export function display(n: bigint, scale = 0): string {
  const sign = n < 0n ? '-' : '', abs = (n < 0n ? -n : n).toString().padStart(scale + 1, '0')
  return scale ? `${sign}${abs.slice(0, -scale)}.${abs.slice(-scale)}` : sign + abs
}
/** Half-away-from-zero display; retain the exact rational separately in mean/stat outputs. */
export function divide(numerator: bigint, denominator: bigint, scale = 6): string | null {
  if (denominator === 0n) return null
  const negative = (numerator < 0n) !== (denominator < 0n)
  let n = numerator < 0n ? -numerator : numerator, d = denominator < 0n ? -denominator : denominator
  n *= pow10(scale)
  let q = n / d
  if ((n % d) * 2n >= d) q++
  return display(negative ? -q : q, scale)
}
export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00.000Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
}
export function convert(raw: string | null, c: DataColumn): string | bigint | number | null {
  if (raw === null || raw === '') { if (!c.nullable) throw new Error(`Blank value in non-nullable column ${c.name}.`); return c.type === 'text' && raw === '' ? '' : null }
  if (c.type === 'text') return raw
  const s = raw.trim()
  if (c.type === 'integer') return scaled(s, 0)
  if (c.type === 'decimal') return scaled(s, c.scale)
  if (c.type === 'real') { if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) throw new Error(`Invalid real number in ${c.name}.`); const n = Number(s); if (!Number.isFinite(n)) throw new Error('Non-finite number.'); return n }
  if (c.type === 'date') { if (!validDate(s)) throw new Error(`Use ISO YYYY-MM-DD dates in ${c.name}; ambiguous dates are not guessed.`); return s }
  if (/^(true|1)$/i.test(s)) return 1n
  if (/^(false|0)$/i.test(s)) return 0n
  throw new Error(`Invalid boolean in ${c.name}.`)
}
export function cellDisplay(value: unknown, column: DataColumn): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return column.type === 'boolean' ? value !== 0n : display(value, column.type === 'decimal' ? column.scale : 0)
  return value
}
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,jsonSafe(v)]))
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('A numerical operation produced a non-finite result.')
  return value
}
