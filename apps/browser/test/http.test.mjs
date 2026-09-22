import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { createBrowserServer } from '../server/http-server.mjs'
import { encodeWire, decodeWire } from '../server/wire.mjs'

async function fixture(t, engine = null) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'genoffice-http-'))
  const directory = path.join(temp, 'files'); await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'test.txt'), 'original')
  const service = await createBrowserServer({ stateDir: path.join(temp, 'state'), publicDir: fileURLToPath(new URL('../public', import.meta.url)), port: 0, engine })
  t.after(async () => { await service.close(); await fs.rm(temp, { recursive: true, force: true }) })
  let cookie = '', csrf = ''
  async function raw(route, { method = 'GET', data, body, headers = {}, auth = true } = {}) {
    return fetch(service.origin + route, { method, headers: { ...(auth ? { Cookie: cookie, 'X-GenOffice-CSRF': csrf } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data === undefined ? body : JSON.stringify(data) })
  }
  const login = await raw('/api/session', { method: 'POST', data: { token: service.token } })
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf = (await login.json()).csrf
  const mountResponse = await raw('/api/mounts', { method: 'POST', data: { path: directory } })
  const mount = await mountResponse.json()
  const fileUrl = '/api/file?' + new URLSearchParams({ mount: mount.id, path: 'test.txt' })
  return { service, temp, directory, mount, cookie, csrf, raw, fileUrl }
}

test('authentication, CSRF, Origin and Host are enforced; errors reveal no paths', async t => {
  const f = await fixture(t)
  assert.equal((await f.raw('/api/mounts', { auth: false })).status, 401)
  assert.equal((await f.raw('/api/session', { method: 'POST', data: { token: 'bad' } })).status, 401)
  assert.equal((await f.raw('/api/mounts', { method: 'POST', data: { path: f.directory }, headers: { 'X-GenOffice-CSRF': 'bad' } })).status, 403)
  assert.equal((await f.raw('/api/mounts', { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await f.raw('/api/mounts', { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await f.raw('/api/mounts', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  const status = await new Promise((resolve, reject) => {
    const request = http.get(f.service.origin + '/api/mounts', { headers: { Host: 'evil.example', Cookie: f.cookie } }, response => { response.resume(); resolve(response.statusCode) }); request.on('error', reject)
  })
  assert.equal(status, 403)
  const missing = await f.raw('/api/text?' + new URLSearchParams({ mount: f.mount.id, path: 'missing.txt' }))
  assert.equal(missing.status, 404); assert.ok(!(await missing.text()).includes(f.directory))
})

test('HTTP reads, revision saves, conflict responses, new files and folders persist on disk', async t => {
  const f = await fixture(t)
  const file = await f.raw(f.fileUrl); assert.equal(file.status, 200)
  const etag = file.headers.get('etag'); assert.equal(await file.text(), 'original')
  let saved = await f.raw(f.fileUrl, { method: 'PUT', body: 'edited', headers: { 'If-Match': etag } })
  assert.equal(saved.status, 200)
  assert.equal(await fs.readFile(path.join(f.directory, 'test.txt'), 'utf8'), 'edited')
  assert.equal((await f.raw(f.fileUrl, { method: 'PUT', body: 'stale', headers: { 'If-Match': etag } })).status, 409)
  assert.equal((await f.raw(f.fileUrl, { method: 'PUT', body: 'missing revision' })).status, 428)
  assert.equal((await f.raw('/api/files', { method: 'POST', data: { mount: f.mount.id, path: 'folder', kind: 'directory' } })).status, 201)
  assert.equal((await f.raw('/api/files', { method: 'POST', data: { mount: f.mount.id, path: 'folder/new.md' } })).status, 201)
  assert.match(await fs.readFile(path.join(f.directory, 'folder/new.md'), 'utf8'), /New document/)
  assert.equal((await f.raw('/api/files', { method: 'POST', data: { mount: f.mount.id, path: 'new.docx' } })).status, 501)
})

test('workspace HTML is static and authored HTML downloads instead of executing', async t => {
  const f = await fixture(t)
  const home = await f.raw('/'); assert.equal(home.status, 200)
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(await home.text(), /Browser workspace/)
  await fs.writeFile(path.join(f.directory, 'evil.html'), '<script>globalThis.bad=true</script>')
  const file = await f.raw('/api/file?' + new URLSearchParams({ mount: f.mount.id, path: 'evil.html' }))
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
  assert.match(file.headers.get('content-disposition'), /attachment/)
  assert.equal((await f.raw('/api/text?' + new URLSearchParams({ mount: f.mount.id, path: '../outside.txt' }))).status, 400)
})

function fakeEngine() {
  return {
    kinds: ['docs'], closed: [], attach(services) { this.services = services },
    async openTab(tab) { tab.resource = this.services.addResource(tab, { preview: true }); this.services.emit(tab, 'browser:ready', true) },
    async closeTab(tab) { this.closed.push(tab.id) },
    async invoke(_tab, _channel, args) { return args }, async send() {}, async command() {}, async replyDialog() {},
    async readResource() { return { type: 'text/html', bytes: Buffer.from('<p>scoped preview</p>') } },
  }
}

test('native relay roundtrips binary, enforces tab ownership and revokes resource capabilities', async t => {
  const engine = fakeEngine(), f = await fixture(t, engine)
  await fs.writeFile(path.join(f.directory, 'sample.docx'), 'fixture')
  const opened = await f.raw('/api/tabs', { method: 'POST', data: { mount: f.mount.id, path: 'sample.docx' } })
  assert.equal(opened.status, 201); const tab = await opened.json()
  const response = await f.raw(`/api/tabs/${tab.id}/rpc`, { method: 'POST', data: { channel: 'echo', args: encodeWire([new Uint8Array([3, 7, 255])]) } })
  assert.deepEqual([...decodeWire((await response.json()).value)[0]], [3, 7, 255])
  const secondLogin = await f.raw('/api/session', { method: 'POST', data: { token: f.service.token }, auth: false })
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0], secondCsrf = (await secondLogin.json()).csrf
  assert.equal((await f.raw(`/api/tabs/${tab.id}/command`, { method: 'POST', data: { command: 'save' }, headers: { Cookie: secondCookie, 'X-GenOffice-CSRF': secondCsrf } })).status, 404)
  const resource = f.service.tabs.get(tab.id).resource
  const preview = await f.raw(resource, { auth: false, headers: { Origin: 'null' } })
  assert.equal(preview.status, 200); assert.match(preview.headers.get('content-security-policy'), /sandbox/)
  assert.equal(preview.headers.get('access-control-allow-origin'), '*')
  assert.equal((await f.raw(`/api/mounts/${f.mount.id}`, { method: 'DELETE' })).status, 409)
  assert.equal((await f.raw(`/api/tabs/${tab.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await f.raw(resource, { auth: false })).status, 404)
  assert.deepEqual(engine.closed, [tab.id])
})

test('one workspace SSE stream multiplexes tab events and replays by sequence', async t => {
  const engine = fakeEngine(), f = await fixture(t, engine)
  await fs.writeFile(path.join(f.directory, 'sample.docx'), 'fixture')
  const opened = await f.raw('/api/tabs', { method: 'POST', data: { mount: f.mount.id, path: 'sample.docx' } })
  const tab = await opened.json()
  const controller = new AbortController()
  const response = await fetch(f.service.origin + '/api/events', { headers: { Cookie: f.cookie }, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const packet = new TextDecoder().decode((await reader.read()).value)
  assert.ok(packet.includes(tab.id)); assert.ok(packet.includes('browser:ready'))
  controller.abort(); await reader.cancel().catch(() => {})
  const again = new AbortController()
  const replay = await fetch(f.service.origin + '/api/events', { headers: { Cookie: f.cookie, 'Last-Event-ID': '1' }, signal: again.signal })
  const replayReader = replay.body.getReader(); const text = new TextDecoder().decode((await replayReader.read()).value)
  assert.ok(!text.includes('browser:ready'))
  engine.services.emit(f.service.tabs.get(tab.id), 'browser:dirty', true)
  const next = new TextDecoder().decode((await replayReader.read()).value)
  assert.ok(next.includes('browser:dirty')); assert.ok(next.includes(tab.id))
  again.abort(); await replayReader.cancel().catch(() => {})
})
