import { app, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { registerPrivilegedSchemes } from '../../../html/src/main/preview-protocol'
import { createBrowserServer } from '../../server/http-server.mjs'

process.env.GENOFFICE_BROWSER_MODE = '1'
const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const stateDir = path.resolve(arg('--state-dir') ?? process.env.GENOFFICE_BROWSER_STATE ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local/share'), 'GenOfficeBrowser'))
mkdirSync(stateDir, { recursive: true })
// Never share desktop app state/recovery/credentials with browser mode.
app.setPath('userData', path.join(stateDir, 'engine'))
mkdirSync(app.getPath('userData'), { recursive: true })
registerPrivilegedSchemes()
let service: Awaited<ReturnType<typeof createBrowserServer>> | undefined
let stopping = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (service) void shell.openExternal(service.launchUrl) })
  app.on('window-all-closed', () => { /* HTTP server, not a window, owns lifetime. */ })
  app.on('before-quit', event => {
    if (stopping || !service) return
    event.preventDefault(); stopping = true
    void service.close().finally(() => app.exit(0))
  })
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
  void app.whenReady().then(async () => {
    const { NativeHost } = await import('./host')
    const browserRoot = path.resolve(__dirname, '../..')
    const repoRoot = path.resolve(browserRoot, '../..')
    const engine = new NativeHost(repoRoot, browserRoot)
    service = await createBrowserServer({ stateDir, publicDir: path.join(browserRoot, 'public'), editorsDir: path.join(browserRoot, 'out/editors'), port: Number(arg('--port') ?? process.env.GENOFFICE_BROWSER_PORT ?? 3210), engine } as any)
    const mount = arg('--mount')
    if (mount) await service.workspace.mount(mount)
    console.log(`\nNawa Browser — local Windows service\n${service.launchUrl}\n\nMount folders in the browser. Keep this console open. Ctrl+C stops the service.\n`)
    console.log(`Available rich editors: ${engine.kinds.join(', ')}`)
    if (!engine.kinds.includes('sheets')) console.warn('Spreadsheet rich editing is unavailable: build the Windows xlsx-sidecar first. CSV source editing remains available.')
    if (!process.argv.includes('--no-open')) await shell.openExternal(service.launchUrl)
  }).catch(error => { console.error('Nawa could not start:', error); app.exit(1) })
}
