import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { expect, it, vi } from 'vitest'

async function listen(server: Server, hostname = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, hostname, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return `http://${hostname}:${(server.address() as AddressInfo).port}`
}

it.each([
  { label: 'NO_PROXY', variable: 'NO_PROXY', hostname: '127.0.0.2' },
  { label: 'no_proxy', variable: 'no_proxy', hostname: '127.0.0.2' },
  { label: 'no bypass setting', variable: undefined, hostname: '127.0.0.1' },
])(
  'keeps local fetches direct after cloud initialization with $label',
  async ({ variable, hostname }) => {
    vi.resetModules()
    const { prepareCloud } = await import('../src/cloud')
    const previousDispatcher = getGlobalDispatcher()
    let proxyRequests = 0
    const proxy = createServer((_req, res) => {
      proxyRequests++
      res.writeHead(502).end()
    })
    proxy.on('connect', (_req, socket) => {
      proxyRequests++
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    const local = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ sessions: 2 }))
    })
    try {
      const proxyUrl = await listen(proxy)
      const localUrl = await listen(local, hostname)
      await prepareCloud({ HTTPS_PROXY: proxyUrl, ...(variable ? { [variable]: hostname } : {}) })
      const response = await fetch(`${localUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ sessions: 2 })
      expect(proxyRequests).toBe(0)
    } finally {
      const cloudDispatcher = getGlobalDispatcher()
      setGlobalDispatcher(previousDispatcher)
      if (cloudDispatcher !== previousDispatcher) await cloudDispatcher.close()
      for (const server of [proxy, local]) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  },
)
