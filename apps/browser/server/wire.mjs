import { HttpError } from './errors.mjs'
const TYPES = new Set(['ArrayBuffer', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array'])
const TAG = '$genofficeBytes'
/** Structured-clone-like binary transport; JSON.stringify(Buffer) is not suitable for IPC. */
export function encodeWire(value, depth = 0) {
  if (depth > 80) throw new HttpError(400, 'The request is nested too deeply.')
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const type = value instanceof ArrayBuffer ? 'ArrayBuffer' : Buffer.isBuffer(value) ? 'Uint8Array' : value.constructor.name
    return { [TAG]: Buffer.from(bytes).toString('base64'), type }
  }
  if (Array.isArray(value)) return value.map(v => encodeWire(v, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeWire(v, depth + 1)]))
  return value === undefined ? null : value
}
export function decodeWire(value, depth = 0) {
  if (depth > 80) throw new HttpError(400, 'The request is nested too deeply.')
  if (value && typeof value === 'object' && Object.hasOwn(value, TAG)) {
    const base64 = value[TAG]
    if (typeof base64 !== 'string' || !TYPES.has(value.type) || base64.length > 96 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new HttpError(400, 'Invalid binary payload.')
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
    if (value.type === 'ArrayBuffer') return bytes.buffer
    const Constructor = globalThis[value.type]
    if (bytes.byteLength % Constructor.BYTES_PER_ELEMENT !== 0) throw new HttpError(400, 'Invalid typed-array length.')
    return new Constructor(bytes.buffer)
  }
  if (Array.isArray(value)) return value.map(v => decodeWire(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, 'Invalid object key.')
      out[key] = decodeWire(item, depth + 1)
    }
    return out
  }
  return value
}
