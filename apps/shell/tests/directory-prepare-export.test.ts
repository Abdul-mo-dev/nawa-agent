// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
HTMLElement.prototype.scrollTo = vi.fn()
HTMLElement.prototype.scrollIntoView = vi.fn()
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false }

it('the actual directory-chat button runs agent review and SQLite export in the conversation without setup toggles', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  await act(async () => { await import('../../../tools/sidebar-review/fixture') })
  const fixture = (window as unknown as { sidebarFixture: { state: { requests: unknown[]; beginScopes: { files: string[]; prepareTables?: boolean }[]; exportRequests: { paths: string[] }[] }; analyticsSettings(): { allowAgentPreparation: boolean }; messages(): { text: string }[] } }).sidebarFixture
  await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Prepare & export')).toBe(true))
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Prepare & export')!
  expect(fixture.analyticsSettings().allowAgentPreparation).toBe(false)
  await act(async () => button.click())
  await act(async () => {
    await vi.waitFor(() => expect(fixture.messages().some(message => message.text.includes('SQLite export complete'))).toBe(true), { timeout: 6000 })
  })
  expect(fixture.state.requests.length).toBeGreaterThanOrEqual(7)
  expect(fixture.state.beginScopes.at(-1)?.prepareTables).toBe(true)
  expect(fixture.state.exportRequests).toHaveLength(1)
  expect(fixture.state.exportRequests[0].paths).toEqual(fixture.state.beginScopes.at(-1)?.files)
  expect(fixture.analyticsSettings().allowAgentPreparation).toBe(false)
  expect(fixture.messages().at(-1)?.text).toContain('tables.sqlite3')
  expect(document.querySelector('[aria-label="Prepare and export tables"]')).toBeNull()
})
