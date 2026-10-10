/* Real components with synthetic desktop bridges; no provider calls. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.task/file-status-review')
await fs.mkdir(output, { recursive: true })
const server = await createServer({ root, configFile: false, plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime'] }, server: { host: '127.0.0.1', port: 5191 }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const check = (label, condition) => { assert.ok(condition, label); console.log('PASS ' + label) }
try {
  await page.goto(server.resolvedUrls.local[0] + 'tools/sidebar-review/?file-status', { timeout: 90000, waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: 'Message Nawa' }).waitFor()
  await page.getByRole('img', { name: 'Search: Indexed for search', exact: true }).waitFor()
  check('Chat has no duplicate selected-file list', await page.locator('.ws-chat-scope, .nawa-selection-items').count() === 0)
  check('Settings and preparation controls are hidden by default', await page.getByRole('tab').count() === 0 && await page.getByRole('button', { name: 'Prepare & export', exact: true }).count() === 0)
  assert.deepEqual(await page.locator('.ex-file-row .ex-column-indexed [data-state]').evaluateAll(nodes => nodes.map(node => node.dataset.state)), ['ready', 'waiting', 'busy', 'failed', 'attention', 'attention', 'waiting'])
  assert.deepEqual(await page.locator('.ex-file-row .ex-column-data [data-state]').evaluateAll(nodes => nodes.map(node => node.dataset.state)), ['ready', 'busy', 'unavailable', 'failed', 'unavailable', 'waiting', 'unavailable'])
  console.log('PASS search and analysis states appear in the file table')
  await page.getByRole('img', { name: 'Search: Indexing…', exact: true }).hover()
  await page.getByRole('tooltip').waitFor()
  check('Hover shows measured embedding progress', (await page.getByRole('tooltip').innerText()).includes('4 of 10 passages embedded · 40%'))
  check('Embedding icon spins', await page.locator('.ex-column-indexed .nawa-file-status.is-busy .nawa-file-status-spinner').evaluate(node => getComputedStyle(node).animationName === 'nawa-file-status-spin'))
  await page.screenshot({ path: path.join(output, 'files-and-chat.png') })
  await page.mouse.move(10, 10)
  await page.getByRole('img', { name: 'Analysis: Preparing data…', exact: true }).focus()
  check('Keyboard focus shows analysis progress', (await page.getByRole('tooltip').innerText()).includes('42 rows processed'))
  await page.getByRole('textbox', { name: 'Message Nawa' }).focus()
  await page.getByRole('button', { name: 'More chat options', exact: true }).click()
  await page.getByRole('dialog', { name: 'Chat options', exact: true }).waitFor()
  check('Export and file checks remain available on demand', await page.getByRole('button', { name: 'Prepare & export', exact: true }).isVisible() && await page.getByRole('button', { name: 'Check again', exact: true }).isVisible())
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Knowledge settings', exact: true }).click()
  await page.locator('.set-dialog').getByRole('button', { name: 'AI Model', exact: true }).click()
  await page.locator('input[id$="-set-ai-model"]').waitFor()
  check('Model settings remain reachable', await page.locator('input[id$="-set-ai-model"]').isVisible())
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '300px', exact: true }).click()
  check('Chat fits a 300px panel', await page.locator('.nawa-workspace-control-panel').evaluate(node => node.scrollWidth <= node.clientWidth + 2))
  await page.setViewportSize({ width: 1150, height: 800 })
  await page.getByRole('img', { name: 'Search: Indexing…', exact: true }).hover()
  const tooltipBounds = await page.getByRole('tooltip').boundingBox()
  check('Tooltip stays in the viewport', tooltipBounds.x >= 0 && tooltipBounds.x + tooltipBounds.width <= 1150)
  await page.screenshot({ path: path.join(output, 'narrow-files-and-chat.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Arabic dark', exact: true }).click()
  await page.mouse.move(10, 10)
  await page.screenshot({ path: path.join(output, 'arabic-dark.png') })
  check('No browser runtime errors', errors.length === 0)
} finally { await browser.close(); await server.close() }
