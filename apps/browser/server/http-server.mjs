import http from 'node:http'
import path from 'node:path'
import * as fs from 'node:fs/promises'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { HttpError, requireValue, publicError } from './errors.mjs'
import { Workspace, inside } from './workspace.mjs'
import { encodeWire, decodeWire } from './wire.mjs'

export const EDITOR_KINDS = {
  '.docx': 'docs',
  '.xlsx': 'sheets',
  '.xlsm': 'sheets',
  '.csv': 'sheets',
  '.pptx': 'slides',
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
const PREVIEW_CSP =
  "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'self'"
const secret = () => randomBytes(32).toString('hex')
const same = (a, b) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieValue = (req, key) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${key}=`))
    ?.slice(key.length + 1)

async function body(req, limit) {
  requireValue(
    !req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity',
    415,
    'Compressed requests are not supported.',
  )
  const length = Number(req.headers['content-length'])
  requireValue(!Number.isFinite(length) || length <= limit, 413, 'The request is too large.')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'The request is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function jsonBody(req, limit = 2 * 1024 * 1024) {
  requireValue(
    (req.headers['content-type'] ?? '').split(';')[0] === 'application/json',
    415,
    'Send application/json.',
  )
  try {
    return JSON.parse((await body(req, limit)).toString('utf8'))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Invalid JSON.')
  }
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

/** HTTP layer has no Electron or npm dependency; its API/security can be tested under Node. */
export async function createBrowserServer({
  stateDir,
  publicDir,
  editorsDir,
  port = 3210,
  engine = null,
  maxBytes,
  token = secret(),
}) {
  requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 400, 'Invalid port.')
  const workspace = new Workspace({ stateDir, maxBytes })
  await workspace.initialize()
  const sessions = new Map()
  const tabs = new Map()
  const resources = new Map()
  let actualPort = port
  let closing = false
  const origin = () => `http://127.0.0.1:${actualPort}`
  const allowedOrigins = () => new Set([origin(), `http://localhost:${actualPort}`])
  const getTab = (id, session) => {
    const tab = tabs.get(id)
    requireValue(
      tab && tab.owner === session.id,
      404,
      'This editor tab is no longer available.',
      'TAB_NOT_FOUND',
    )
    tab.seen = Date.now()
    return tab
  }
  const broadcastSession = (tab, channel, args) => {
    const session = sessions.get(tab.owner)
    if (!session) return
    const payload = `id: ${++session.sequence}\ndata: ${JSON.stringify({ tabId: tab.id, channel, args: encodeWire(args) })}\n\n`
    session.events.push({ id: session.sequence, payload })
    session.eventBytes += Buffer.byteLength(payload)
    while (session.events.length > 256 || session.eventBytes > 16 * 1024 * 1024)
      session.eventBytes -= Buffer.byteLength(session.events.shift().payload)
    for (const res of session.clients) {
      if (res.writableLength > 16 * 1024 * 1024) {
        res.end()
        session.clients.delete(res)
      } else res.write(payload)
    }
  }
  const emit = (tab, channel, ...args) => {
    if (!tabs.has(tab.id)) return
    broadcastSession(tab, channel, args)
    const payload = `id: ${++tab.sequence}\ndata: ${JSON.stringify({ channel, args: encodeWire(args) })}\n\n`
    tab.events.push({ id: tab.sequence, payload })
    tab.eventBytes += Buffer.byteLength(payload)
    while (tab.events.length > 128 || tab.eventBytes > 16 * 1024 * 1024) {
      tab.eventBytes -= Buffer.byteLength(tab.events.shift().payload)
    }
    for (const res of tab.clients) {
      // A suspended client cannot grow the server's socket buffer indefinitely.
      if (res.writableLength > 16 * 1024 * 1024) {
        res.end()
        tab.clients.delete(res)
      } else res.write(payload)
    }
  }
  const addResource = (tab, descriptor) => {
    const id = secret()
    resources.set(id, { tab, ...descriptor })
    return `/api/resource/${id}/`
  }
  const closeTab = async (tab) => {
    for (const client of tab.clients) client.end()
    for (const [id, resource] of resources) if (resource.tab === tab) resources.delete(id)
    tabs.delete(tab.id)
    await engine?.closeTab(tab)
  }
  const services = { workspace, tabs, emit, addResource, origin }
  engine?.attach(services)

  async function authenticate(req, mutating) {
    const id = cookieValue(req, 'genoffice_session')
    const session = sessions.get(id)
    requireValue(
      session && session.expires > Date.now(),
      401,
      'Connect using the browser URL printed by Start Nawa.',
      'NOT_CONNECTED',
    )
    if (mutating)
      requireValue(
        same(req.headers['x-genoffice-csrf'], session.csrf),
        403,
        'The security token is missing or expired.',
        'CSRF_FAILED',
      )
    return session
  }
  async function serveStatic(res, root, pathname) {
    requireValue(
      typeof root === 'string',
      404,
      'The editor assets are not built. Run setup-windows.cmd.',
    )
    const parts = pathname.split('/').filter(Boolean)
    requireValue(
      parts.every((p) => p !== '.' && p !== '..' && !/[\\\0:]/.test(p)),
      400,
      'Invalid asset path.',
    )
    const target = path.resolve(root, ...parts)
    requireValue(inside(root, target), 403, 'Invalid asset path.')
    const contentType = MIME[path.extname(target).toLowerCase()]
    requireValue(contentType, 404, 'Asset not found.')
    const bytes = await fs.readFile(target)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Content-Length': bytes.length,
    })
    res.end(bytes)
  }
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()')
    const host = req.headers.host
    requireValue(
      host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`,
      403,
      'Invalid Host header.',
      'HOST_BLOCKED',
    )
    const requestOrigin = req.headers.origin
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', origin())
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      throw new HttpError(400, 'Invalid URL encoding.')
    }

    // Resource capabilities carry only read authority and are needed by opaque,
    // sandboxed HTML previews, where a SameSite cookie may not be sent.
    const resourceMatch = /^\/api\/resource\/([a-f0-9]{64})\/(.*)$/.exec(pathname)
    if (resourceMatch && method === 'GET') {
      const resource = resources.get(resourceMatch[1])
      requireValue(resource && tabs.has(resource.tab.id), 404, 'This resource expired.')
      const result = await engine.readResource(resource, resourceMatch[2], url.searchParams)
      res.setHeader('Content-Security-Policy', resource.preview ? PREVIEW_CSP : CSP)
      if (resource.preview) {
        // Null-origin previews can read only their capability-scoped assets;
        // never grant CORS for the authenticated filesystem or RPC endpoints.
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      }
      res.writeHead(result.status ?? 200, {
        'Content-Type': result.type ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(result.bytes)
      return
    }
    requireValue(
      requestOrigin === undefined || allowedOrigins().has(requestOrigin),
      403,
      'Cross-origin requests are not permitted.',
      'ORIGIN_BLOCKED',
    )
    requireValue(
      req.headers['sec-fetch-site'] !== 'cross-site',
      403,
      'Cross-site requests are not permitted.',
      'ORIGIN_BLOCKED',
    )
    if (pathname === '/api/session' && method === 'POST') {
      const data = await jsonBody(req, 4096)
      requireValue(same(data.token, token), 401, 'The connection token is not valid.', 'BAD_TOKEN')
      const old = cookieValue(req, 'genoffice_session')
      let session = sessions.get(old)
      if (!session || session.expires <= Date.now()) {
        session = {
          id: secret(),
          csrf: secret(),
          expires: Date.now() + 24 * 60 * 60 * 1000,
          clients: new Set(),
          events: [],
          eventBytes: 0,
          sequence: 0,
        }
        sessions.set(session.id, session)
      }
      res.setHeader(
        'Set-Cookie',
        `genoffice_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      )
      json(res, { csrf: session.csrf })
      return
    }
    if (pathname.startsWith('/api/')) {
      const session = await authenticate(req, !['GET', 'HEAD'].includes(method))
      if (pathname === '/api/session' && method === 'GET') {
        json(res, { csrf: session.csrf })
        return
      }
      // One multiplexed stream per workspace avoids HTTP/1.1's connection limit
      // deadlocking RPC when multiple editor iframes are open.
      if (pathname === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        const last = Number(req.headers['last-event-id'] ?? 0)
        if (last && session.events[0]?.id > last + 1)
          res.write(`data: ${JSON.stringify({ channel: 'browser:resync-required', args: [] })}\n\n`)
        for (const event of session.events) if (event.id > last) res.write(event.payload)
        session.clients.add(res)
        const heartbeat = setInterval(() => {
          for (const tab of tabs.values()) if (tab.owner === session.id) tab.seen = Date.now()
          res.write(': heartbeat\n\n')
        }, 15000)
        req.once('close', () => {
          clearInterval(heartbeat)
          session.clients.delete(res)
        })
        return
      }
      if (pathname === '/api/status' && method === 'GET') {
        json(res, {
          mode: engine ? 'native-editors' : 'source-only',
          maxBytes: workspace.maxBytes,
          nativeFolderPicker: !!engine,
          editors: engine?.kinds ?? [],
          version: 1,
        })
        return
      }
      if (pathname === '/api/mounts' && method === 'GET') {
        json(res, [...workspace.mounts.values()])
        return
      }
      if (pathname === '/api/mounts' && method === 'POST') {
        const data = await jsonBody(req, 16384)
        json(res, await workspace.mount(data.path, { readOnly: data.readOnly === true }), 201)
        return
      }
      if (pathname === '/api/mounts/pick' && method === 'POST') {
        requireValue(engine, 501, 'Paste a Windows folder path to mount it in source-only mode.')
        const directory = await engine.pickMount()
        json(res, directory ? await workspace.mount(directory) : null, directory ? 201 : 200)
        return
      }
      const unmount = /^\/api\/mounts\/([^/]+)$/.exec(pathname)
      if (unmount && method === 'DELETE') {
        requireValue(
          ![...tabs.values()].some((t) => t.mount === unmount[1]),
          409,
          'Close all editors using this folder before unmounting it.',
        )
        await workspace.unmount(unmount[1])
        json(res, { ok: true })
        return
      }
      const mount = url.searchParams.get('mount')
      const relative = url.searchParams.get('path') ?? ''
      if (pathname === '/api/tree' && method === 'GET') {
        json(res, await workspace.list(mount, relative))
        return
      }
      if (pathname === '/api/text' && method === 'GET') {
        json(res, await workspace.text(mount, relative))
        return
      }
      if (pathname === '/api/file' && method === 'GET') {
        const file = await workspace.read(mount, relative)
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(relative))}`,
          ETag: `"${file.revision}"`,
          'Cache-Control': 'no-store',
        })
        res.end(file.bytes)
        return
      }
      if (pathname === '/api/file' && method === 'PUT') {
        const expected =
          req.headers['if-none-match'] === '*'
            ? null
            : req.headers['if-match']?.replace(/^"|"$/g, '')
        json(
          res,
          await workspace.write(mount, relative, await body(req, workspace.maxBytes), expected),
        )
        return
      }
      if (pathname === '/api/files' && method === 'POST') {
        const data = await jsonBody(req, 64 * 1024)
        if (data.kind === 'directory') {
          json(res, await workspace.mkdir(data.mount, data.path), 201)
          return
        }
        const ext = path.extname(data.path ?? '').toLowerCase()
        const kind = EDITOR_KINDS[ext]
        let bytes
        if (['docs', 'sheets', 'slides', 'pdf'].includes(kind) && ext !== '.csv') {
          requireValue(
            engine?.kinds.includes(kind),
            501,
            'The native editor service is not built. Run setup-windows.cmd.',
          )
          requireValue(
            ext !== '.xlsm',
            400,
            'Create an .xlsx workbook, not a macro-enabled workbook.',
          )
          bytes = await engine.blank(kind)
        } else {
          const templates = {
            '.md': '# New document\n\n',
            '.html':
              '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>New document</title></head>\n<body><h1>New document</h1><p>Start writing here.</p></body>\n</html>\n',
            '.json': '{}\n',
          }
          bytes = Buffer.from(templates[ext] ?? '', 'utf8')
        }
        json(
          res,
          { path: data.path, ...(await workspace.write(data.mount, data.path, bytes, null)) },
          201,
        )
        return
      }
      if (pathname === '/api/tabs' && method === 'POST') {
        requireValue(
          engine,
          501,
          'The native editor service is not running. Use the source editor or run Start Nawa.cmd.',
        )
        const data = await jsonBody(req, 16384)
        const kind = EDITOR_KINDS[path.extname(data.path ?? '').toLowerCase()]
        requireValue(
          engine.kinds.includes(kind),
          415,
          'This format has no native browser editor. Use the source editor or download the file.',
        )
        requireValue(
          [...tabs.values()].filter((t) => t.owner === session.id).length < 12,
          429,
          'Close an editor before opening more than 12 tabs.',
        )
        const absolute = await workspace.resolve(data.mount, data.path)
        const snapshot = await workspace.read(data.mount, data.path)
        const tab = {
          id: randomUUID(),
          owner: session.id,
          mount: data.mount,
          path: data.path,
          absolute,
          kind,
          revision: snapshot.revision,
          clients: new Set(),
          events: [],
          eventBytes: 0,
          sequence: 0,
          seen: Date.now(),
        }
        tabs.set(tab.id, tab)
        try {
          await engine.openTab(tab)
        } catch (error) {
          await closeTab(tab)
          throw error
        }
        json(
          res,
          { id: tab.id, kind, url: `/editors/${kind}/index.html?mode=tab&browserTab=${tab.id}` },
          201,
        )
        return
      }
      const tabRoute = /^\/api\/tabs\/([^/]+)(?:\/(rpc|event|events|dialog|command|asset))?$/.exec(
        pathname,
      )
      if (tabRoute) {
        const tab = getTab(tabRoute[1], session)
        const action = tabRoute[2]
        if (!action && method === 'DELETE') {
          await closeTab(tab)
          json(res, { ok: true })
          return
        }
        if (action === 'asset' && method === 'GET') {
          const result = await engine.readAsset(tab, url.searchParams.get('src'))
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
          res.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'no-store' })
          res.end(result.bytes)
          return
        }
        if (action === 'events' && method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(': connected\n\n')
          const last = Number(req.headers['last-event-id'] ?? 0)
          if (last && tab.events[0]?.id > last + 1)
            res.write(
              `data: ${JSON.stringify({ channel: 'browser:resync-required', args: [] })}\n\n`,
            )
          for (const event of tab.events) if (event.id > last) res.write(event.payload)
          tab.clients.add(res)
          const heartbeat = setInterval(() => {
            tab.seen = Date.now()
            res.write(': heartbeat\n\n')
          }, 15000)
          req.once('close', () => {
            clearInterval(heartbeat)
            tab.clients.delete(res)
            tab.seen = Date.now()
          })
          return
        }
        if (action === 'rpc' && method === 'POST') {
          const data = await jsonBody(req, Math.ceil(workspace.maxBytes * 1.6))
          json(res, {
            value: encodeWire(await engine.invoke(tab, data.channel, decodeWire(data.args))),
          })
          return
        }
        if (action === 'event' && method === 'POST') {
          const data = await jsonBody(req, Math.ceil(workspace.maxBytes * 1.6))
          await engine.send(tab, data.channel, decodeWire(data.args))
          json(res, { ok: true })
          return
        }
        if (action === 'dialog' && method === 'POST') {
          await engine.replyDialog(tab, await jsonBody(req, 16384))
          json(res, { ok: true })
          return
        }
        if (action === 'command' && method === 'POST') {
          const data = await jsonBody(req, 4096)
          requireValue(
            ['save', 'saveAs', 'queryDirty'].includes(data.command),
            400,
            'Unknown editor command.',
          )
          await engine.command(tab, data.command)
          json(res, { ok: true })
          return
        }
      }
      throw new HttpError(404, 'API route not found.')
    }
    requireValue(method === 'GET' || method === 'HEAD', 405, 'Method not allowed.')
    if (pathname === '/service.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Nawa engine host</title>')
      return
    }
    if (pathname.startsWith('/editors/')) {
      await serveStatic(res, editorsDir, pathname.slice('/editors/'.length))
      return
    }
    await serveStatic(res, publicDir, pathname === '/' ? 'index.html' : pathname)
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const safe = publicError(error)
      if (safe.status >= 500) console.error('[Nawa browser]', error)
      if (!res.headersSent) json(res, { error: safe.error, code: safe.code }, safe.status)
      else res.end()
    })
  })
  server.requestTimeout = 300000 // Large document saves; dialog requests may wait for a user.
  server.headersTimeout = 15000
  server.maxHeadersCount = 80
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  actualPort = server.address().port
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions)
      if (session.expires <= now) {
        for (const client of session.clients) client.end()
        for (const tab of tabs.values()) if (tab.owner === id) void closeTab(tab)
        sessions.delete(id)
      }
    for (const tab of tabs.values())
      if (!tab.clients.size && now - tab.seen > 30 * 60 * 1000) void closeTab(tab)
  }, 60000)
  sweep.unref()
  return {
    workspace,
    tabs,
    server,
    token,
    origin: origin(),
    launchUrl: `${origin()}/#token=${token}`,
    async close() {
      if (closing) return
      closing = true
      clearInterval(sweep)
      for (const tab of [...tabs.values()]) await closeTab(tab)
      for (const session of sessions.values()) for (const client of session.clients) client.end()
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
      await engine?.shutdown?.()
    },
  }
}
