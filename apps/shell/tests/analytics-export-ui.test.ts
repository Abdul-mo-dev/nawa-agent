// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { PrepareExportButton } from '../src/renderer/src/analytics/PrepareExportButton'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined, host: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })
const render = async (paths: string[], onPrepare = vi.fn(), disabled = false) => {
  if (!host || !root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
  await act(async () => root!.render(createElement(LocaleProvider, { initial: 'en' }, createElement(PrepareExportButton, { paths, folder: 'C:/Workspace', disabled, onPrepare }))))
  return host.querySelector('button')!
}

it('starts the existing chat agent with a frozen selection, without a separate preparation IPC or dialog', async () => {
  let finish!: () => void
  const onPrepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const paths = ['C:/Workspace/data.csv', 'C:/Workspace/formula.xlsx']
  const button = await render(paths, onPrepare)
  await act(async () => { button.click(); button.click() })
  expect(onPrepare).toHaveBeenCalledExactlyOnceWith(paths, 'C:/Workspace')
  expect(onPrepare.mock.calls[0][0]).not.toBe(paths)
  await render(['C:/Workspace/other.csv'], onPrepare, true)
  expect(onPrepare.mock.calls[0][0]).toEqual(paths)
  expect(document.querySelector('dialog')).toBeNull()
  await act(async () => finish())
  expect((await render(paths, onPrepare)).disabled).toBe(false)
})

it('disables preparation for empty, oversized and active chat scopes', async () => {
  const onPrepare = vi.fn()
  expect((await render([], onPrepare)).disabled).toBe(true)
  expect((await render(Array.from({ length: 257 }, (_, i) => `C:/Workspace/${i}.csv`), onPrepare)).disabled).toBe(true)
  expect((await render(['C:/Workspace/data.csv'], onPrepare, true)).disabled).toBe(true)
  expect(onPrepare).not.toHaveBeenCalled()
})
