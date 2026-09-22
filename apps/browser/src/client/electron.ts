/** Browser transport for the original, unmodified Electron preloads. No Node API
 * or filesystem path capability is installed in the browser. */
type Listener = (event: unknown, ...args: any[]) => void
const tabId = new URLSearchParams(location.search).get('browserTab')
const kind = location.pathname.split('/')[2]
const endpoint = `/api/tabs/${encodeURIComponent(tabId ?? '')}`
const listeners = new Map<string, Set<Listener>>()
const backlog = new Map<string, any[][]>()
let csrf = ''
let dirty = false
let pendingSends: Promise<void> = Promise.resolve()

function notify(type: string, details: Record<string, unknown> = {}): void {
  parent.postMessage({ source: 'genoffice-browser', tabId, type, ...details }, location.origin)
}
function setDirty(value: boolean): void {
  if (dirty === value) return
  dirty = value; notify('dirty', { dirty })
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
export function encode(value: any): any {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return { $genofficeBytes: bytesToBase64(view), type: value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
  return value
}
export function decode(value: any): any {
  if (value && typeof value === 'object' && typeof value.$genofficeBytes === 'string') {
    const binary = atob(value.$genofficeBytes)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    if (value.type === 'ArrayBuffer') return bytes.buffer
    const types: Record<string, any> = { Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView }
    const Type = types[value.type]
    if (!Type) throw new Error('Unsupported binary transport type')
    return new Type(bytes.buffer)
  }
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]))
  return value
}
async function request(route: string, data?: unknown): Promise<any> {
  const response = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-GenOffice-CSRF': csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status, code: value.code })
    throw error
  }
  return value
}
function deliver(channel: string, args: any[], queue = true): void {
  const handlers = listeners.get(channel)
  if (!handlers?.size) {
    if (queue) {
      const waiting = backlog.get(channel) ?? []
      waiting.push(args); if (waiting.length > 32) waiting.shift(); backlog.set(channel, waiting)
    }
    return
  }
  for (const handler of [...handlers]) {
    try { handler({}, ...args) } catch (error) { notify('error', { message: String(error) }) }
  }
}
async function showDialog(dialog: any): Promise<void> {
  const host = (parent as any).genofficeWorkspace
  if (!host?.dialog) throw new Error('Open this editor from the Nawa browser workspace.')
  while (true) {
    const value = await host.dialog(tabId, dialog)
    try { await request(`${endpoint}/dialog`, { id: dialog.id, value }); return }
    catch (error: any) {
      if (![400, 403, 409].includes(error.status) || !value) throw error
      host.notify(error.message, true)
      // Keep the engine request alive while correcting an invalid name/path.
    }
  }
}
export const ready = (async () => {
  if (!tabId) throw new Error('No browser tab was selected. Open a file from the Nawa workspace.')
  const session = await request('/api/session'); csrf = session.csrf
  const onPacket = (packet: any) => {
    try {
      const { channel, args: encoded } = packet
      const args = decode(encoded)
      if (channel === 'browser:dialog') { void showDialog(args[0]).catch(error => notify('error', { message: error.message })); return }
      if (channel === 'browser:dirty') { setDirty(args[0] === true); return }
      if (channel === 'browser:saved') { setDirty(false); notify('saved', args[0]); return }
      if (channel === 'browser:copied') { notify('copied', args[0]); return }
      if (channel === 'browser:opened') { notify('opened', args[0]); return }
      if (channel === 'browser:error') { notify('error', { message: args[0] }); return }
      if (channel === 'browser:resync-required') { notify('error', { message: 'The connection missed editor events. Keep any unsaved text, then reload this file.' }); return }
      deliver(channel, args)
    } catch (error) { notify('error', { message: String(error) }) }
  }
  const host = (parent as any).genofficeWorkspace
  if (!host?.subscribe) throw new Error('Open this editor from the Nawa workspace, not as a standalone URL.')
  const unsubscribe = host.subscribe(tabId, onPacket)
  addEventListener('pagehide', unsubscribe, { once: true })
})()

export const ipcRenderer = {
  async invoke(channel: string, ...args: any[]): Promise<any> {
    await ready
    // Match Electron ordering: a preview-update/dirty event sent before invoke
    // reaches main first. New events are not blocked by an invoke awaiting a dialog.
    await pendingSends
    try {
      const response = await request(`${endpoint}/rpc`, { channel, args: encode(args) })
      const result = decode(response.value)
      return result
    } catch (error: any) {
      notify('error', { message: error.message }); throw error
    }
  },
  send(channel: string, ...args: any[]): void {
    if (/:dirty-changed$/.test(channel)) setDirty(args[0] === true)
    if (channel === 'docs:close-check-result') setDirty(args[0]?.dirty === true)
    if (channel === 'workbook:pending-edits') setDirty(Number(args[0]) > 0)
    // These announcements have no listener/job in browser mode. Do not expose
    // the OS automation/MCP command plane merely to accept a readiness signal.
    if (/:mcp-ready$|:headless-export-done$/.test(channel)) return
    pendingSends = pendingSends.then(async () => {
      await ready
      await request(`${endpoint}/event`, { channel, args: encode(args) })
    }).catch(error => { notify('error', { message: error.message }) })
  },
  on(channel: string, listener: Listener) {
    let set = listeners.get(channel)
    if (!set) { set = new Set(); listeners.set(channel, set) }
    set.add(listener)
    queueMicrotask(() => {
      const waiting = backlog.get(channel)
      if (waiting) { backlog.delete(channel); for (const args of waiting) deliver(channel, args) }
    })
    return ipcRenderer
  },
  once(channel: string, listener: Listener) {
    const once: Listener = (event, ...args) => { ipcRenderer.removeListener(channel, once); listener(event, ...args) }
    return ipcRenderer.on(channel, once)
  },
  removeListener(channel: string, listener: Listener) { listeners.get(channel)?.delete(listener); return ipcRenderer },
  removeAllListeners(channel: string) { listeners.delete(channel); return ipcRenderer },
}
export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown): void {
    Object.defineProperty(window, name, { value, configurable: false, enumerable: true, writable: false })
  },
}
export const webUtils = { getPathForFile(_file: File): string { return '' } }

const assetPrefix = `${endpoint}/asset?src=`
const bridge = {
  isDirty(): boolean { if (kind === 'docs') deliver('docs:close-check', [], false); return dirty },
  assetUrl(source: string): string { return assetPrefix + encodeURIComponent(source) },
  originalAssetUrl(source: string): string {
    try { const url = new URL(source, location.href); return url.origin === location.origin && url.pathname === `${endpoint}/asset` ? url.searchParams.get('src') ?? source : source }
    catch { return source }
  },
}
Object.defineProperty(window, 'genofficeBridge', { value: bridge })
addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); event.stopImmediatePropagation()
    void ready.then(() => request(`${endpoint}/command`, { command: event.shiftKey ? 'saveAs' : 'save' })).catch(error => notify('error', { message: error.message }))
  }
}, true)
addEventListener('beforeunload', event => { if (bridge.isDirty()) { event.preventDefault(); event.returnValue = '' } })
// Docs' existing synchronous close-check is also its source of truth for dirty.
if (kind === 'docs') setInterval(() => { if (listeners.has('docs:close-check')) bridge.isDirty() }, 1000)
ready.catch(error => {
  notify('error', { message: error.message })
  const panel = document.createElement('p'); panel.textContent = error.message
  panel.style.cssText = 'padding:32px;font:16px system-ui'; document.body.replaceChildren(panel)
})
