import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const clients: JSDOM[] = []
afterEach(async () => {
  // A successful Save also refreshes the tree; drain that work before closing
  // the DOM so an in-flight action cannot notify a disposed document.
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const client of clients.splice(0)) client.window.close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function workspaceClient() {
  const publicDir = new URL('../public/', import.meta.url)
  const dom = new JSDOM(await readFile(new URL('index.html', publicDir), 'utf8'), {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  })
  clients.push(dom)
  const { window } = dom
  const mounts = [
    { id: 'first', root: '/first', name: 'First folder' },
    { id: 'second', root: '/second', name: 'Second folder' },
  ]
  const writes: Array<{ mount: string | null; path: string | null; text: string }> = []
  const gate = {
    text: null as ReturnType<typeof deferred<void>> | null,
    tree: null as ReturnType<typeof deferred<void>> | null,
  }
  const started = { text: deferred<void>(), tree: deferred<void>() }
  Object.assign(window, { TextEncoder, confirm: () => true })
  window.fetch = vi.fn(async (route: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(route), 'http://localhost')
    let result: unknown
    if (url.pathname === '/api/session') result = { csrf: 'test' }
    else if (url.pathname === '/api/status') result = { mode: 'source-only', editors: [] }
    else if (url.pathname === '/api/mounts') result = mounts
    else if (url.pathname === '/api/tree') {
      const mount = url.searchParams.get('mount')
      if (mount === 'second' && gate.tree) {
        const pending = gate.tree
        started.tree.resolve()
        await pending.promise
      }
      result = ['shared.txt', `${mount}-only.txt`].map((name) => ({
        name,
        path: name,
        kind: 'file',
        size: 8,
        modified: null,
      }))
    } else if (url.pathname === '/api/text') {
      if (gate.text) {
        const pending = gate.text
        started.text.resolve()
        await pending.promise
      }
      result = { text: 'original', revision: 'a'.repeat(64), bom: false, eol: 'lf' }
    } else if (url.pathname === '/api/file' && init?.method === 'PUT') {
      writes.push({
        mount: url.searchParams.get('mount'),
        path: url.searchParams.get('path'),
        text: new TextDecoder().decode(init.body as Uint8Array),
      })
      result = { revision: 'b'.repeat(64) }
    } else throw new Error(`Unexpected workspace request: ${url}`)
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof window.fetch
  window.eval(await readFile(fileURLToPath(new URL('workspace.js', publicDir)), 'utf8'))
  await vi.waitFor(() =>
    expect(window.document.querySelector('#file-list')?.textContent).toContain('first-only.txt'),
  )
  const selectMount = (name: string) => {
    const button = [...window.document.querySelectorAll<HTMLButtonElement>('.mount-button')].find(
      (candidate) => candidate.textContent?.includes(name),
    )
    expect(button).toBeDefined()
    button!.click()
  }
  return { window, gate, started, writes, selectMount }
}

describe('browser workspace navigation races', () => {
  it('a file opened before a mount switch still saves to its original mount', async () => {
    const { window, gate, started, writes, selectMount } = await workspaceClient()
    gate.text = deferred<void>()
    const file = [...window.document.querySelectorAll<HTMLElement>('.file-entry')].find((row) =>
      row.textContent?.includes('shared.txt'),
    )!
    file.click()
    await started.text.promise
    selectMount('Second folder')
    await vi.waitFor(() =>
      expect(window.document.querySelector('#file-list')?.textContent).toContain('second-only.txt'),
    )
    gate.text.resolve()
    await vi.waitFor(() => expect(window.document.querySelector('.source-editor')).not.toBeNull())
    const editor = window.document.querySelector<HTMLTextAreaElement>('.source-editor')!
    editor.value = 'edited first file'
    editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    const save = window.document.querySelector<HTMLButtonElement>('#save')!
    await save.onclick!.call(save, new window.MouseEvent('click'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ mount: 'first', path: 'shared.txt', text: 'edited first file' })
  })

  it('a late folder response cannot replace a newer folder listing', async () => {
    const { window, gate, started, selectMount } = await workspaceClient()
    gate.tree = deferred<void>()
    selectMount('Second folder')
    await started.tree.promise
    expect(window.document.querySelector('#folder-title')?.textContent).toBe('Second folder')
    expect(window.document.querySelector('#file-list')?.textContent).not.toContain('first-only.txt')
    selectMount('First folder')
    await vi.waitFor(() =>
      expect(window.document.querySelector('#folder-title')?.textContent).toBe('First folder'),
    )
    gate.tree.resolve()
    // Let the released in-memory response finish its promise/JSON work.
    await gate.tree.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(window.document.querySelector('#file-list')?.textContent).toContain('first-only.txt')
    expect(window.document.querySelector('#file-list')?.textContent).not.toContain(
      'second-only.txt',
    )
  })
})
