/* global window, document */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.task/sidebar-review')
await fs.mkdir(output, { recursive: true })
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 5189 },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const check = (name, ok) => {
  assert.ok(ok, name)
  console.log(`PASS ${name}`)
}
const shot = (name) => page.screenshot({ path: path.join(output, name + '.png') })
const visible = (locator) => locator.isVisible()
const bounds = async () =>
  page.locator('.nawa-workspace-control-panel').evaluate((node) => {
    const outer = node.getBoundingClientRect()
    const overflow = [...node.querySelectorAll('input:not([type=checkbox]),select,textarea,button')]
      .filter((e) => e.getClientRects().length && e.getBoundingClientRect().width)
      .filter((e) => {
        const b = e.getBoundingClientRect()
        return b.left < outer.left - 2 || b.right > outer.right + 2
      })
      .map((e) => e.outerHTML.slice(0, 130))
    return { width: outer.width, overflow }
  })
try {
  await page.goto(server.resolvedUrls.local[0] + 'tools/sidebar-review/', { timeout: 60000 })
  await page.getByRole('textbox', { name: 'Message Nawa' }).waitFor()
  check(
    'Opened folder name row is removed',
    (await page.locator('.nawa-workspace-context').count()) === 0,
  )
  check(
    'New chat and More are immediately before the settings gear',
    await page.locator('.nawa-workspace-tabs-header').evaluate((node) => {
      const actions = node.querySelector('.nawa-workspace-chat-actions')
      return (
        actions?.nextElementSibling?.classList.contains('nawa-workspace-settings') &&
        actions.querySelectorAll('button').length === 2
      )
    }),
  )
  const beforeIndexModels = await page.evaluate(() => window.sidebarFixture.state.requests.length)
  await page.locator('.nawa-index-selected').click()
  await page.waitForFunction(
    () =>
      window.sidebarFixture.state.preparationRequests.length === 1 &&
      window.sidebarFixture.state.indexRequests.length === 1,
  )
  check(
    'Index starts embeddings and native table preparation for the same selection without a model or export request',
    await page.evaluate((before) => {
      const state = window.sidebarFixture.state
      return (
        state.indexRequests[0].paths.length === 2 &&
        JSON.stringify(state.indexRequests[0].paths) ===
          JSON.stringify(state.preparationRequests[0].paths) &&
        state.requests.length === before &&
        state.exportRequests.length === 0
      )
    }, beforeIndexModels),
  )
  check(
    'File checks are optional',
    !(await visible(page.getByRole('button', { name: 'Check again' }))),
  )
  check(
    'Selected files stay in the main panel',
    (await page.locator('.ws-chat-scope').count()) === 0,
  )
  await page.getByRole('button', { name: 'More chat options', exact: true }).click()
  check(
    'Prepare/export is available in More',
    await visible(page.getByRole('button', { name: 'Prepare & export', exact: true })),
  )
  const beforeExportModels = await page.evaluate(() => window.sidebarFixture.state.requests.length)
  await page.getByRole('button', { name: 'Prepare & export', exact: true }).click()
  await page.getByText('SQLite export complete:', { exact: false }).waitFor()
  check(
    'Export click invokes the existing chat agent with scoped preparation authority',
    await page.evaluate(
      (before) =>
        window.sidebarFixture.state.exportRequests.length === 1 &&
        window.sidebarFixture.state.exportRequests[0].paths.length === 2 &&
        window.sidebarFixture.state.requests.length > before &&
        window.sidebarFixture.state.beginScopes.at(-1).prepareTables === true,
      beforeExportModels,
    ),
  )
  check(
    'Export shows a concise user action while the agent receives the detailed instruction',
    await page.evaluate(
      () =>
        window.sidebarFixture
          .messages()
          .some(
            (message) =>
              message.role === 'user' && message.text === 'Prepare & export selected files',
          ) &&
        window.sidebarFixture.state.requests.some((request) =>
          JSON.stringify(request.messages).includes('Inspect every table and its source evidence'),
        ) &&
        !document
          .querySelector('.ws-chat-log')
          ?.textContent.includes('Inspect every table and its source evidence'),
    ),
  )
  check(
    'Export stays in the conversation and reports remaining decisions',
    await page.evaluate(
      () =>
        window.sidebarFixture.messages().at(-1).text.includes('1 table needs a header decision') &&
        window.sidebarFixture.messages().at(-1).text.includes('tables.sqlite3'),
    ),
  )
  check(
    'No separate preparation dialog or settings opt-in is required',
    await page.evaluate(
      () =>
        !document.querySelector('dialog[open]') &&
        window.sidebarFixture.analyticsSettings().allowAgentPreparation === false,
    ),
  )
  await shot('prepare-export-result-360')
  await page.getByRole('button', { name: '300px', exact: true }).click()
  check(
    'Prepare/export fits the 300px sidebar beside New chat',
    (await bounds()).overflow.length === 0,
  )
  await shot('prepare-export-button-300')
  await page.getByRole('button', { name: '360px', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message Nawa' }).fill('Retained draft')
  await page.evaluate(() => window.sidebarFixture.select(['C:\\External folder\\outside.xlsx']))
  await page
    .getByText('A selected path is outside the opened workspace folders.', { exact: false })
    .waitFor()
  check(
    'External recent files cannot be sent as Chat scope',
    await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(),
  )
  await page.getByRole('button', { name: 'Add / open folder', exact: true }).click()
  check(
    'External scope offers a folder action',
    await page.evaluate(() => window.sidebarFixture.state.addFolderRequests === 1),
  )
  check(
    'External selection shows an actionable warning without a second file list',
    (await page.locator('.ws-chat-scope').count()) === 0,
  )
  await page.evaluate(() => window.sidebarFixture.restoreSelection())
  await page.waitForFunction(
    () => document.querySelector('.ws-chat-footer button[aria-label="Send"]')?.disabled === false,
  )
  check(
    'Restoring valid scope keeps the Chat draft',
    (await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()) &&
      (await page.getByRole('textbox', { name: 'Message Nawa' }).inputValue()) === 'Retained draft',
  )
  await shot('chat-360')
  const transcript = await page.locator('.ws-chat-scroll').boundingBox()
  check('Chat has room for the transcript', transcript.height > 250)

  check(
    'Chat contains no knowledge or model settings forms',
    (await page.locator('.nawa-workspace-control-panel .set-input').count()) === 0,
  )
  await page.getByRole('button', { name: 'Knowledge settings', exact: true }).click()
  const settingsDialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settingsDialog.waitFor()
  const section = async (name) =>
    settingsDialog.locator('.set-nav-item').filter({ hasText: name }).click()
  check(
    'Gear opens main Settings on Knowledge',
    (await settingsDialog.locator('.set-nav-item.active').innerText()) === 'Knowledge',
  )
  check(
    'Knowledge has one llama.cpp connection',
    (await settingsDialog.getByLabel('Server address', { exact: true }).count()) === 1 &&
      (await settingsDialog.getByText('llama.cpp', { exact: true }).first().isVisible()),
  )
  check(
    'Advanced embedding and analysis controls start collapsed',
    (await page.locator('.nawa-embedding-advanced[open], .nawa-analysis-limits[open]').count()) ===
      0,
  )
  check(
    'Credentials and technical limits stay out of the default form',
    !(await page.getByLabel('API key (optional)', { exact: true }).isVisible()) &&
      !(await page.getByText('Maximum source file size (MiB)', { exact: true }).isVisible()),
  )
  await settingsDialog.getByRole('button', { name: 'Load models', exact: true }).click()
  check(
    'Llama.cpp model is selected from the server',
    (await settingsDialog.getByLabel('Embedding model', { exact: true }).inputValue()) ===
      'local-embedding',
  )
  await settingsDialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await settingsDialog.getByText('Connection successful.', { exact: true }).waitFor()
  await settingsDialog
    .getByLabel('Server address', { exact: true })
    .fill('http://127.0.0.1:8099/v1')
  await section(/^General$/)
  await section(/^Knowledge$/)
  check(
    'Knowledge edits survive main section changes',
    (await settingsDialog.getByLabel('Server address', { exact: true }).inputValue()) ===
      'http://127.0.0.1:8099/v1',
  )
  await page.keyboard.press('Escape')
  await settingsDialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
  check('Escape protects unsaved settings', await settingsDialog.isVisible())
  await settingsDialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await shot('main-settings-knowledge')
  await page.setViewportSize({ width: 520, height: 720 })
  await settingsDialog.getByLabel('Server address', { exact: true }).focus()
  check(
    'Resizing with Settings open keeps the form interactive',
    await settingsDialog
      .getByLabel('Server address', { exact: true })
      .evaluate((node) => node === document.activeElement && !node.closest('[inert]')),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await section(/^AI Model$/)
  await page.locator('input[id$="-set-ai-model"]').waitFor()
  check(
    'Local model settings preserve the saved output limit',
    (await page.locator('input[id$="-set-ai-max-tokens"]').inputValue()) === '8192',
  )
  check(
    'Custom connection suggests the local chat server',
    (await page.locator('input[id$="-set-ai-base-url"]').getAttribute('placeholder')) ===
      'http://127.0.0.1:8082/v1',
  )
  check(
    'Keys remain protected in main model settings',
    (await page.locator('input[id$="-set-ai-key"]').inputValue()) === '',
  )
  const modelCards = settingsDialog.locator('.nawa-model-card')
  await modelCards.first().locator('summary').first().click()
  check(
    'Profile limits start collapsed',
    !(await modelCards.first().getByLabel('Context limit (tokens)').isVisible()),
  )
  await modelCards.first().locator('.nawa-model-policy summary').click()
  check(
    'Local profile starts with a 16K context and 4K output',
    (await modelCards.first().getByLabel('Context limit (tokens)').inputValue()) === '16384' &&
      (await modelCards.first().getByLabel('Output limit (tokens)').inputValue()) === '4096',
  )
  await modelCards.first().getByLabel('Output limit (tokens)').fill('2048')
  await modelCards.nth(1).locator('summary').first().click()
  await modelCards.nth(1).locator('.nawa-model-policy summary').click()
  check(
    'Changing one profile limit preserves the other profile',
    (await modelCards.nth(1).getByLabel('Output limit (tokens)').inputValue()) === '4096',
  )
  await shot('main-settings-model-limits')
  await modelCards.first().locator('summary').first().click()
  await modelCards.nth(1).locator('summary').first().click()
  await page.locator('input[id$="-set-ai-model"]').fill('edited-model')
  await section(/^Knowledge$/)
  await section(/^AI Model$/)
  check(
    'Model draft survives section switches',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'edited-model',
  )
  await page.evaluate(() => {
    window.sidebarFixture.state.failSave = true
  })
  await settingsDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await settingsDialog
    .getByRole('alert')
    .filter({ hasText: 'Could not save model settings' })
    .waitFor()
  check(
    'Failed model save keeps the draft',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'edited-model',
  )
  await page.evaluate(() => {
    window.sidebarFixture.state.failSave = false
  })
  await settingsDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.sidebarFixture.state.saved === 1)
  check(
    'Saving preserves the protected model key',
    await page.evaluate(
      () => window.sidebarFixture.settings().providers.custom.apiKey === 'fixture-key',
    ),
  )
  await page.locator('input[id$="-set-ai-model"]').fill('draft-model')
  await page.evaluate(() => window.sidebarFixture.externalModelChange('newer-model'))
  await settingsDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await settingsDialog
    .getByRole('alert')
    .filter({ hasText: 'Model settings changed in another editor' })
    .waitFor()
  check(
    'Stale settings cannot overwrite a newer save',
    await page.evaluate(() => window.sidebarFixture.state.saved === 1),
  )
  await settingsDialog.getByRole('button', { name: 'Reload current settings', exact: true }).click()
  await section(/^Knowledge$/)
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  check(
    'Settings closes back to the chat gear',
    await page
      .getByRole('button', { name: 'Knowledge settings', exact: true })
      .evaluate((node) => node === document.activeElement),
  )
  check(
    'Opening settings preserves the chat draft',
    (await page.getByRole('textbox', { name: 'Message Nawa' }).inputValue()) === 'Retained draft',
  )
  await page.evaluate(() => {
    window.sidebarFixture.state.failHistorySave = true
  })
  await page.getByRole('textbox', { name: 'Message Nawa' }).fill('Draft with failed save')
  await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor()
  check(
    'Failed chat save exposes retry',
    await visible(page.getByRole('button', { name: 'Retry saving', exact: true })),
  )
  await page.evaluate(() => {
    window.sidebarFixture.state.failHistorySave = false
  })
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
  await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: 'Message Nawa' }).fill('Retained draft')
  await page.getByRole('button', { name: 'More chat options', exact: true }).click()
  await page.getByRole('button', { name: 'Manage history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Manage history', exact: true })
  await history.waitFor()
  await history.getByRole('button', { name: 'Delete', exact: true }).waitFor()
  check(
    'History delete and database buttons are visible',
    (await visible(history.getByRole('button', { name: 'Delete', exact: true }))) &&
      (await visible(history.getByRole('button', { name: 'Show database', exact: true }))),
  )
  await history.getByRole('button', { name: 'Rename', exact: true }).click()
  check(
    'Rename cancel is visible',
    await visible(history.getByRole('button', { name: 'Cancel', exact: true })),
  )
  await page.keyboard.press('Escape')
  check(
    'Escape closes history and returns focus',
    !(await history.isVisible()) &&
      (await page
        .getByRole('button', { name: 'More chat options', exact: true })
        .evaluate((e) => e === document.activeElement)),
  )
  await page.getByRole('button', { name: 'Review table data', exact: true }).click()
  await page.getByRole('button', { name: 'Review table', exact: true }).click()
  const review = page.getByRole('dialog', { name: /^Review table ·/ })
  await review.waitFor()
  check('Table review uses a wide modal', (await review.boundingBox()).width > 900)
  const approveTable = review.getByRole('button', {
    name: 'Validate and approve table',
    exact: true,
  })
  const rowDescription = review.getByLabel('What does one row represent? (required)')
  const confirmTable = review.getByRole('checkbox', { name: /I confirm/ })
  check(
    'Approval action stays available before required fields are completed',
    await approveTable.isEnabled(),
  )
  await approveTable.click()
  await review.getByRole('alert').filter({ hasText: 'Describe what one row represents' }).waitFor()
  check(
    'Missing row description receives focus',
    await rowDescription.evaluate((element) => element === document.activeElement),
  )
  await review.getByLabel('What does one row represent? (required)').fill('One invoice')
  await approveTable.click()
  await review.getByRole('alert').filter({ hasText: 'Select the confirmation checkbox' }).waitFor()
  check(
    'Missing confirmation receives focus',
    await confirmTable.evaluate((element) => element === document.activeElement),
  )
  await confirmTable.check()
  check(
    'Confirmation clears the prompt and keeps approval available',
    (await approveTable.isEnabled()) && (await review.getByRole('alert').count()) === 0,
  )
  check(
    'Incomplete review never calls approval',
    (await page.evaluate(() => window.sidebarFixture.state.reviewed)) === 0,
  )
  await shot('table-review')
  await page.keyboard.press('Escape')
  check(
    'Closing edited review asks before discarding',
    await visible(review.getByRole('button', { name: 'Keep editing', exact: true })),
  )
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await review.getByRole('button', { name: 'Close', exact: true }).click()
  await review.getByRole('button', { name: 'Discard changes', exact: true }).click()
  check(
    'Modal focus returns to review trigger',
    await page
      .getByRole('button', { name: 'Review table', exact: true })
      .evaluate((e) => e === document.activeElement),
  )

  await page
    .getByRole('dialog', { name: 'Review table data', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.locator('.ws-chat-empty').waitFor()
  check(
    'New chat still resets the conversation from the panel header',
    (await page.locator('.ws-chat-log .ws-chat-msg').count()) === 0,
  )
  await page.setViewportSize({ width: 520, height: 720 })
  await page.getByRole('button', { name: 'Knowledge settings', exact: true }).click()
  await settingsDialog.waitFor()
  check(
    'Knowledge fits a narrow window',
    await settingsDialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  )
  await shot('main-settings-narrow')
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  check(
    'Settings stays above the narrow chat drawer',
    await page.locator('.nawa-workspace-control-panel.is-drawer').isVisible(),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Arabic dark', exact: true }).click()
  await page.getByRole('button', { name: 'إعدادات المعرفة', exact: true }).click()
  const arabicSettings = page.locator('.set-dialog')
  await arabicSettings.getByRole('heading', { name: 'المعرفة', exact: true }).waitFor()
  check(
    'Knowledge settings follow Arabic direction',
    await arabicSettings.evaluate((node) => getComputedStyle(node).direction === 'rtl'),
  )
  check(
    'Server address remains readable left to right',
    (await arabicSettings.getByLabel('عنوان الخادم', { exact: true }).getAttribute('dir')) ===
      'ltr',
  )
  check(
    'Arabic settings fit the dialog',
    await arabicSettings.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  )
  await shot('main-settings-arabic-dark')
  check('No renderer errors', errors.length === 0)
  console.log('Screenshots: ' + output)
} finally {
  await browser.close()
  await server.close()
}
