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
  optimizeDeps: { entries: ['tools/sidebar-review/index.html'] },
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
  check('Check again is visible', await visible(page.getByRole('button', { name: 'Check again' })))
  await page.getByRole('textbox', { name: 'Message Nawa' }).fill('Retained draft')
  await shot('chat-360')
  const transcript = await page.locator('.ws-chat-scroll').boundingBox()
  check('Chat has room for the transcript', transcript.height > 250)
  await page.getByRole('tab', { name: 'Models', exact: true }).click()
  await page.locator('input[id$="-set-ai-model"]').waitFor()
  check('Profiles start collapsed', (await page.locator('.nawa-model-card[open]').count()) === 0)
  await page.locator('input[id$="-set-ai-model"]').fill('edited-model')
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  check(
    'Closing preserves model edits',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'edited-model',
  )
  await shot('models-360')
  await page.getByRole('button', { name: '300px', exact: true }).click()
  const narrow = await bounds()
  check(
    '300px model form stays inside sidebar',
    narrow.width === 300 && narrow.overflow.length === 0,
  )
  await shot('models-300')
  await page.evaluate(() => {
    window.sidebarFixture.state.failSave = true
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Could not save model settings' }).waitFor()
  check(
    'Failed save preserves edits',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'edited-model',
  )
  await page.evaluate(() => {
    window.sidebarFixture.state.failSave = false
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.sidebarFixture.state.saved === 1)
  await page.locator('input[id$="-set-ai-model"]').fill('discard-this')
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  check(
    'Discard restores last saved model',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'edited-model',
  )
  await page.locator('input[id$="-set-ai-model"]').fill('unsaved-again')
  await page.getByRole('button', { name: '+ Add current model', exact: true }).click()
  check(
    'Adding a profile expands only its form',
    (await page.locator('.nawa-model-card[open]').count()) === 1,
  )
  check('Profile fields fit 300px sidebar', (await bounds()).overflow.length === 0)
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  check(
    'Switching tabs preserves chat draft',
    (await page.getByRole('textbox', { name: 'Message Nawa' }).inputValue()) === 'Retained draft',
  )
  check(
    'Hidden model edits have a visible indicator',
    await visible(page.getByRole('button', { name: /Models · Unsaved model settings/ })),
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
  await page.getByRole('button', { name: 'Manage history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Manage history', exact: true })
  await history.waitFor()
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
        .getByRole('button', { name: 'Manage history', exact: true })
        .evaluate((e) => e === document.activeElement)),
  )
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  await page.locator('.nawa-capability-status').first().filter({ hasText: 'Ready' }).waitFor()
  check(
    'Knowledge starts with two compact cards',
    (await page.locator('.nawa-knowledge-card').count()) === 2 &&
      (await page.locator('.nawa-knowledge-card[open]').count()) === 0,
  )
  await shot('knowledge-300')
  await page.locator('.nawa-knowledge-card').first().locator(':scope > summary').click()
  await page.locator('.nawa-inline-settings > summary').first().click()
  await page.getByLabel('Embedding model ID / server alias').fill('changed-embedding')
  await page.getByRole('tab', { name: 'Models', exact: true }).click()
  check(
    'Hidden search settings report unsaved changes',
    await visible(page.getByRole('button', { name: /Knowledge · Unsaved search settings/ })),
  )
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  check(
    'Search settings retain drafts',
    (await page.getByLabel('Embedding model ID / server alias').inputValue()) ===
      'changed-embedding',
  )
  await page
    .locator('.nawa-rag-settings')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  check(
    'Search discard restores persisted configuration',
    (await page.getByLabel('Embedding model ID / server alias').inputValue()) === 'local-embedding',
  )
  check('Search settings controls fit 300px sidebar', (await bounds()).overflow.length === 0)
  await page.getByLabel('RAG backend', { exact: true }).selectOption('myagent')
  check('MyAgent URL is shown', await visible(page.getByLabel('MyAgent server URL', { exact: true })))
  await page.getByText('MyAgent document tools', { exact: true }).click()
  check('MyAgent tools explain model processing and saved classifications', await visible(page.getByText('Visual analysis and text classification use MyAgent’s configured models, which may be remote. Classifications are saved on the server. Document-tool calls allow at least 3 minutes; classification allows at least 10 minutes. Stop in chat cancels the request.', { exact: true })))
  await page.getByText('MyAgent document tools', { exact: true }).scrollIntoViewIfNeeded()
  await shot('myagent-document-tools-300')
  check('Local embedding controls are hidden for MyAgent', !(await visible(page.getByLabel('Embedding model ID / server alias'))))
  await page.getByLabel('MyAgent server URL', { exact: true }).fill('http://127.0.0.1:5187')
  await page.getByRole('button', { name: 'Save search settings', exact: true }).click()
  check('MyAgent clear action only forgets mappings', (await page.getByRole('button', { name: 'Forget file mappings', exact: true, includeHidden: true }).count()) === 1)
  check('MyAgent controls fit 300px sidebar', (await bounds()).overflow.length === 0)
  await shot('myagent-search-settings-300')

  await page.locator('.nawa-knowledge-card').nth(1).locator(':scope > summary').click()
  await page.getByRole('button', { name: 'Review table', exact: true }).click()
  const review = page.getByRole('dialog', { name: /Review table/ })
  await review.waitFor()
  check('Table review uses a wide modal', (await review.boundingBox()).width > 900)
  await review.getByLabel('What does one row represent? (required)').fill('One invoice')
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
  await page.getByRole('button', { name: 'Review table', exact: true }).click()
  await review.getByLabel('What does one row represent? (required)').fill('Unsaved policy')
  await page.evaluate(() => window.sidebarFixture.job(true))
  await page.waitForFunction(() =>
    document.querySelector('.nawa-capability-status')?.textContent.includes('Indexing'),
  )
  await page.evaluate(() => {
    window.sidebarFixture.job(false)
    window.sidebarFixture.refresh()
  })
  await page.waitForFunction(
    () => document.querySelector('.nawa-capability-status')?.textContent === 'Ready',
  )
  check(
    'Background catalog refresh preserves review edits',
    (await review.getByLabel('What does one row represent? (required)').inputValue()) ===
      'Unsaved policy',
  )
  await review.getByRole('checkbox', { name: /I confirm/ }).check()
  await review.getByRole('button', { name: 'Validate and approve table', exact: true }).click()
  await review.getByRole('alert').filter({ hasText: 'Source changed' }).waitFor()
  check(
    'Stale source cannot be silently approved',
    (await page.evaluate(() => window.sidebarFixture.state.reviewed)) === 0,
  )
  await review.getByRole('button', { name: 'Close', exact: true }).click()
  await review.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.evaluate(() => window.sidebarFixture.job(true))
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: /Knowledge · Indexing/ }).waitFor()
  check(
    'Hidden jobs identify their directory',
    await page
      .getByRole('button', { name: /Knowledge · Indexing/ })
      .textContent()
      .then((x) => x.includes('Other directory')),
  )
  await page.setViewportSize({ width: 800, height: 700 })
  await page.locator('.nawa-workspace-control-panel.is-drawer').waitFor()
  check(
    'Narrow window opens a drawer',
    (await page.locator('.nawa-workspace-control-panel').getAttribute('role')) === 'dialog',
  )
  await page.getByRole('tab', { name: 'Chat', exact: true }).focus()
  await page.keyboard.press('Shift+Tab')
  check(
    'Drawer traps keyboard focus',
    await page
      .locator('.nawa-workspace-control-panel')
      .evaluate((e) => e.contains(document.activeElement)),
  )
  check(
    'Resize retains chat draft',
    (await page.getByRole('textbox', { name: 'Message Nawa' }).inputValue()) === 'Retained draft',
  )
  await shot('chat-drawer')
  await page.keyboard.press('Escape')
  check('Escape closes drawer', !(await page.locator('.nawa-workspace-control-panel').isVisible()))
  check(
    'Drawer restores background interaction',
    !(await page.locator('.ex-center').evaluate((e) => e.inert)),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '560px', exact: true }).click()
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await page.getByRole('tab', { name: 'Models', exact: true }).click()
  check('560px model form stays within the panel', (await bounds()).width === 560 && (await bounds()).overflow.length === 0)
  await page.setViewportSize({ width: 720, height: 450 })
  await page.locator('.nawa-workspace-control-panel.is-drawer').waitFor()
  const saveBounds = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox()
  check('Short windows keep save actions on screen', saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 450)
  await shot('models-short-window')
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  await page.getByRole('button', { name: 'Stop import', exact: true }).focus()
  await page.keyboard.press('Escape')
  check('Escape works from Knowledge controls in the drawer', !(await page.locator('.nawa-workspace-control-panel').isVisible()))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '300px', exact: true }).click()
  await page.getByRole('button', { name: 'Arabic dark', exact: true }).click()
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await page.getByRole('tab', { name: 'النماذج', exact: true }).click()
  check(
    'Arabic sidebar uses RTL',
    (await page.locator('.nawa-workspace-control-panel').getAttribute('dir')) === 'rtl',
  )
  check('Arabic form stays within narrow panel', (await bounds()).overflow.length === 0)
  await shot('models-ar-dark')
  await page.getByRole('tab', { name: 'النماذج', exact: true }).focus()
  await page.keyboard.press('ArrowLeft')
  check(
    'RTL arrows move focus without activating',
    (await page
      .getByRole('tab', { name: 'المحادثة', exact: true })
      .evaluate((e) => e === document.activeElement)) &&
      (await page
        .getByRole('tab', { name: 'النماذج', exact: true })
        .getAttribute('aria-selected')) === 'true',
  )
  await page.reload()
  await page.getByRole('textbox', { name: 'Message Nawa' }).waitFor()
  await page.evaluate(() => {
    window.sidebarFixture.state.failLoad = true
  })
  await page.getByRole('tab', { name: 'Models', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Could not load model settings' }).waitFor()
  await page.evaluate(() => {
    window.sidebarFixture.state.failLoad = false
  })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.locator('input[id$="-set-ai-model"]').waitFor()
  check(
    'Model load failure can be retried',
    (await page.locator('input[id$="-set-ai-model"]').inputValue()) === 'local-model',
  )
  check('No renderer errors', errors.length === 0)
  console.log(`Screenshots: ${output}`)
} finally {
  await browser.close()
  await server.close()
}
