/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { policy as validatePolicy } from '../src/main/analytics/validation'
import { ReviewTable } from '../src/renderer/src/analytics/AnalyticsToolbar'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { Dataset } from '../src/shared/analytics-api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const dataset: Dataset = {
  id: 'dataset',
  path: 'C:/Docs/sales.csv',
  sourceHash: 'hash',
  generation: 'generation',
  name: 'Sales',
  sheet: '',
  range: 'all records',
  kind: 'csv',
  status: 'needs-review',
  policy: {
    name: 'Sales',
    description: '',
    grain: '',
    headerRow: 1,
    firstRow: 2,
    lastRow: 3,
    firstColumn: 1,
    lastColumn: 1,
    columns: [
      {
        id: 'c0',
        name: 'Amount',
        type: 'decimal',
        scale: 2,
        role: 'measure',
        unit: 'JPY',
        nullable: false,
        description: '',
      },
    ],
    key: [],
    currencyColumn: null,
    includeHiddenRows: false,
    skipRows: [],
    formulaPolicy: 'reject',
    confirmed: false,
  },
  rows: 0,
  rawRows: 2,
  excludedRows: 0,
  formulaCells: 0,
  warnings: [],
  profile: {},
  preview: [],
  importedAt: 0,
}

let host: HTMLDivElement, root: Root
const review = vi.fn().mockResolvedValue(dataset)
const onSaved = vi.fn()
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')!
const approve = () => dialog().querySelector<HTMLButtonElement>('footer button.primary')!
const confirm = () => dialog().querySelector<HTMLInputElement>('footer input[type="checkbox"]')!
const grain = () =>
  dialog().querySelector<HTMLInputElement>(
    'input[placeholder="One invoice line, one customer, one sensor observation…"]',
  )!
const button = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === name,
  )!
const click = (element: HTMLElement) => act(async () => element.click())
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const render = (value: Dataset = dataset) =>
  act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(ReviewTable, { dataset: value, onSaved, onClose: vi.fn() }),
      ),
    ),
  )

beforeEach(() => {
  vi.clearAllMocks()
  review.mockReset().mockResolvedValue(dataset)
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
      },
    },
  })
  Object.assign(window, { nawaAnalytics: { review } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('table review row description', () => {
  it('prefills a validated agent policy but still requires a fresh user confirmation', async () => {
    const proposed = { ...dataset.policy, grain: 'One invoice line', description: 'Prepared sales table', confirmed: false }
    await render({ ...dataset, preparedPolicy: { policy: proposed, validatedRows: 2, excludedRows: 1, createdAt: 1 } })
    expect(grain().value).toBe('One invoice line')
    expect(dialog().textContent).toContain('Agent-prepared policy: 2 data rows validated')
    expect(confirm().checked).toBe(false)
    await click(approve())
    expect(review).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(confirm())
    await click(confirm())
    await click(approve())
    expect(review).toHaveBeenCalledExactlyOnceWith(dataset.id, dataset.generation, { ...proposed, confirmed: true })
  })

  it('shows provisional row meaning and optional-key notes without disabling a valid draft', async () => {
    const proposed = { ...dataset.policy, grain: 'One source data record', confirmed: false }
    await render({ ...dataset, preparedPolicy: { policy: proposed, validatedRows: 2, excludedRows: 1, createdAt: 1, notes: ['Row meaning is provisional. Confirm the business meaning of one row before approval.', 'No unique business key is declared. Single-table analysis is available after approval; combining exports or joining tables requires a verified key.'] } })
    expect(dialog().textContent).toContain('Row meaning is provisional')
    expect(dialog().textContent).toContain('No unique business key is declared')
    expect(approve().disabled).toBe(false)
    await click(confirm())
    await click(approve())
    expect(review).toHaveBeenCalledExactlyOnceWith(dataset.id, dataset.generation, { ...proposed, confirmed: true })
  })
  it.each(['', ' \t '])(
    'keeps approval clickable and focuses a blank row description (%j) before IPC',
    async (value) => {
      await render()
      await fill(grain(), value)
      await click(confirm())
      expect(approve().disabled).toBe(false)
      expect(dialog().textContent).toContain(
        'Describe what one row represents before approving the table',
      )
      expect(grain().getAttribute('aria-invalid')).toBe('true')
      await click(approve())
      expect(review).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(grain())
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
        'Describe what one row represents before approving the table',
      )
    },
  )

  it('approves a corrected description only after confirmation', async () => {
    await render()
    await click(confirm())
    await fill(grain(), 'One invoice line')
    expect(confirm().checked).toBe(false)
    expect(approve().disabled).toBe(false)
    await click(approve())
    expect(review).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(confirm())
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      'Select the confirmation checkbox after reviewing the table policy.',
    )
    await click(confirm())
    expect(approve().disabled).toBe(false)
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
    await click(approve())
    expect(review).toHaveBeenCalledExactlyOnceWith(dataset.id, dataset.generation, {
      ...dataset.policy,
      grain: 'One invoice line',
      confirmed: true,
    })
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('validates blank, malformed and corrected advanced JSON before approval', async () => {
    await render()
    await click(button('Advanced policy JSON'))
    const json = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    await click(confirm())
    expect(approve().disabled).toBe(false)
    await click(approve())
    expect(review).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(json)
    await fill(json, '{')
    await click(confirm())
    expect(approve().disabled).toBe(false)
    await click(approve())
    expect(review).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(json)
    expect(dialog().textContent).toContain('Enter valid policy JSON before approving the table.')
    await fill(json, JSON.stringify({ ...dataset.policy, grain: 'One customer' }))
    expect(confirm().checked).toBe(false)
    await click(confirm())
    expect(approve().disabled).toBe(false)
    await click(approve())
    expect(review).toHaveBeenCalledExactlyOnceWith(dataset.id, dataset.generation, {
      ...dataset.policy,
      grain: 'One customer',
      confirmed: true,
    })
  })

  it.each(['x'.repeat(1001), 'One\0customer'])(
    'blocks invalid advanced row descriptions before IPC',
    async (value) => {
      await render()
      await click(button('Advanced policy JSON'))
      await fill(
        dialog().querySelector<HTMLTextAreaElement>('textarea')!,
        JSON.stringify({ ...dataset.policy, grain: value }),
      )
      await click(confirm())
      expect(approve().disabled).toBe(false)
      await click(approve())
      expect(review).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(dialog().querySelector('textarea'))
    },
  )

  it('disables approval only while validation is running and enables retry after failure', async () => {
    let rejectReview!: (error: Error) => void
    review.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectReview = reject
        }),
    )
    await render()
    await fill(grain(), 'One invoice line')
    await click(confirm())
    await click(approve())
    expect(approve().disabled).toBe(true)
    expect(approve().textContent).toBe('Validating…')
    await act(async () => rejectReview(new Error('Source changed. Reopen the review.')))
    expect(approve().disabled).toBe(false)
    expect(approve().textContent).toBe('Validate and approve table')
    expect(onSaved).not.toHaveBeenCalled()
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Source changed')
  })

  it.each([undefined, null, '', ' \t ', 123])(
    'returns actionable worker validation for a missing description (%j)',
    (value) => {
      expect(() => validatePolicy({ ...dataset.policy, grain: value }, 512)).toThrow(
        'Describe what one row represents before approving the table',
      )
    },
  )

  it('keeps the same length and character constraints in worker validation', () => {
    expect(() => validatePolicy({ ...dataset.policy, grain: 'x'.repeat(1001) }, 512)).toThrow(
      'at most 1,000 characters',
    )
    expect(() => validatePolicy({ ...dataset.policy, grain: 'One\0customer' }, 512)).toThrow(
      'invalid character',
    )
    expect(validatePolicy({ ...dataset.policy, grain: 'One invoice line' }, 512).grain).toBe(
      'One invoice line',
    )
  })
})
