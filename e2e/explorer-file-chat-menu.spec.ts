import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DEFAULT_RAG_SETTINGS } from '../apps/shell/src/shared/rag-api'
import { DEFAULT_ANALYTICS_SETTINGS } from '../apps/shell/src/shared/analytics-api'
import { closeAndSaveVideo, launchShell, screenshotPath } from './helpers'

test('file context actions prepare exact tables, index only selected files and reuse unchanged content', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-file-chat-menu-'))
  const documents = join(scratch, 'Documents'),
    userDataDir = join(scratch, 'state')
  await mkdir(documents)
  await mkdir(userDataDir)
  const sales = join(documents, 'sales.csv'),
    unselected = join(documents, 'unselected.csv')
  const original = 'id,amount\nA,0.10\nB,0.20\n'
  await writeFile(sales, original)
  await writeFile(unselected, 'id,amount\nX,99.00\n')
  await writeFile(
    join(userDataDir, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [documents] }),
  )
  await mkdir(join(userDataDir, 'analytics'))
  await writeFile(
    join(userDataDir, 'analytics', 'settings-v1.json'),
    JSON.stringify({
      ...DEFAULT_ANALYTICS_SETTINGS,
      allowAgentPreparation: true,
      allowAgentApproval: true,
    }),
  )
  let embeddings = 0
  let rejectEmbeddings = false
  const endpoints: string[] = []
  const server = createServer(async (request, response) => {
    endpoints.push(request.url ?? '')
    response.setHeader('Content-Type', 'application/json')
    if (request.url !== '/v1/embeddings') {
      response.writeHead(404)
      response.end('{}')
      return
    }
    if (rejectEmbeddings) {
      response.writeHead(404)
      response.end('{"error":"Embedding model unavailable"}')
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const { input } = JSON.parse(body) as { input: string[] }
    embeddings++
    response.end(
      JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.6, 0.8] })) }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'file-chat-menu',
  })
  const { page } = launched
  try {
    await page.getByRole('treeitem', { name: basename(documents), exact: true }).click()
    const row = page.locator('.ex-file-row').filter({ hasText: 'sales.csv' })
    await expect(row).toBeVisible()
    await page.evaluate(async (path) => window.nawaAnalytics.statuses([path], true), sales)
    await row.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Explorer actions' })
    await expect(
      menu.getByRole('menuitem', { name: 'Chat with this file', exact: true }),
    ).toBeEnabled()
    await menu.getByRole('menuitem', { name: 'Index for file chat', exact: true }).click()
    const setupFailure = page.getByRole('dialog', { name: 'Indexing details', exact: true })
    const detailsButton = page.getByRole('button', { name: 'Indexing details', exact: true })
    await expect(detailsButton).toBeVisible()
    await expect(setupFailure).not.toBeVisible()
    await detailsButton.click()
    await expect(setupFailure).toContainText('Choose an embedding model')
    await setupFailure.getByRole('button', { name: 'Close', exact: true }).click()
    const searchIcon = row.locator('.ex-column-indexed [data-state]')
    const searchTooltip = page.getByRole('tooltip').filter({ hasText: /^Search:/ })
    const analysisTooltip = page.getByRole('tooltip').filter({ hasText: /^Analysis:/ })
    await expect(searchIcon).toHaveAttribute('data-state', 'failed')
    await searchIcon.hover()
    await expect(searchTooltip).toContainText('Choose an embedding model')
    await expect(searchTooltip).toContainText('Knowledge')
    await page.screenshot({
      path: screenshotPath('file-chat-setup-failure-tooltip'),
      fullPage: true,
    })
    await row.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Prepare tables for analysis', exact: true }).click()
    await expect(row.locator('.ex-column-data [data-state]')).toHaveAttribute('data-state', 'ready')
    await expect(setupFailure).not.toBeVisible()
    expect(embeddings).toBe(0)
    await expect(
      page
        .locator('.ex-file-row')
        .filter({ hasText: 'unselected.csv' })
        .locator('.ex-column-data [data-state]'),
    ).toHaveAttribute('data-state', 'waiting')

    await page.evaluate(
      async (settings) => {
        await window.nawaRag.save(settings)
      },
      {
        ...DEFAULT_RAG_SETTINGS,
        enabled: true,
        model: 'test-embeddings',
        dimensions: 2,
        tokenizer: 'conservative',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    )
    rejectEmbeddings = true
    await row.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Index for file chat', exact: true }).click()
    await expect(searchIcon).toHaveAttribute('data-state', 'failed')
    await searchIcon.hover()
    await expect(searchTooltip).toContainText('Embedding server HTTP 404')
    await expect(searchTooltip).toContainText('Load an embedding model')
    await expect(setupFailure).not.toBeVisible()
    await page.screenshot({
      path: screenshotPath('file-chat-model-failure-tooltip'),
      fullPage: true,
    })
    rejectEmbeddings = false
    await row.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Index for file chat', exact: true }).click()
    await expect(row.locator('.ex-column-indexed [data-state]')).toHaveAttribute(
      'data-state',
      'ready',
    )
    await searchIcon.hover()
    await expect(searchTooltip).toContainText('Indexed for search')
    await expect(searchTooltip).not.toContainText('HTTP 404')
    expect(embeddings).toBeGreaterThan(0)
    const beforeRefresh = embeddings
    await row.click({ button: 'right' })
    await expect(
      menu.getByRole('menuitem', { name: 'Reindex / refresh for file chat', exact: true }),
    ).toBeEnabled()
    await page.screenshot({ path: screenshotPath('file-chat-menu'), fullPage: true })
    await menu
      .getByRole('menuitem', { name: 'Reindex / refresh for file chat', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: 'Index selected files', exact: true }),
    ).toBeEnabled()
    await expect(setupFailure).not.toBeVisible()
    expect(embeddings).toBe(beforeRefresh)

    await row.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Indexing & analysis details', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Indexing & analysis details' })
    await expect(details).toContainText('Ready for analysis')
    await expect(details).toContainText('2 included rows')
    await expect(details).toContainText('Indexed for search')
    await expect(details).not.toContainText('unselected.csv')
    await page.screenshot({ path: screenshotPath('file-chat-details'), fullPage: true })
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    const catalog = await page.evaluate(
      async (folder) => window.nawaAnalytics.catalog(folder),
      documents,
    )
    expect(catalog.datasets.map((dataset) => dataset.path)).toEqual([sales])
    expect(await readFile(sales, 'utf8')).toBe(original)
    // Pause automatic work so this change must be handled by the context-menu refresh.
    await page.evaluate(async () => {
      await Promise.all([window.nawaRag.cancel(), window.nawaAnalytics.cancel()])
    })
    const updated = 'id,amount\nA,4.00\nB,5.00\nC,6.00\n'
    await writeFile(sales, updated)
    await expect(row.locator('.ex-column-indexed [data-state]')).toHaveAttribute(
      'data-state',
      'attention',
    )
    await expect(row.locator('.ex-column-data [data-state]')).toHaveAttribute(
      'data-state',
      'attention',
    )
    await searchIcon.hover()
    await expect(searchTooltip).toContainText('content changed')
    await expect(searchTooltip).toContainText('Reindex / refresh for file chat')
    await row.locator('.ex-column-data [data-state]').hover()
    await expect(analysisTooltip).toContainText('Prepare tables for analysis')
    await row.click({ button: 'right' })
    await menu
      .getByRole('menuitem', { name: 'Reindex / refresh for file chat', exact: true })
      .click()
    await expect(row.locator('.ex-column-indexed [data-state]')).toHaveAttribute(
      'data-state',
      'ready',
    )
    await expect(row.locator('.ex-column-data [data-state]')).toHaveAttribute('data-state', 'ready')
    await expect(setupFailure).not.toBeVisible()
    const refreshed = await page.evaluate(
      async (folder) => window.nawaAnalytics.catalog(folder),
      documents,
    )
    expect(refreshed.datasets[0].rows).toBe(3)
    expect(refreshed.datasets[0].generation).not.toBe(catalog.datasets[0].generation)
    expect(embeddings).toBeGreaterThan(beforeRefresh)
    expect(await readFile(sales, 'utf8')).toBe(updated)
    expect(endpoints.every((endpoint) => endpoint === '/v1/embeddings')).toBe(true)
  } finally {
    await closeAndSaveVideo(launched, 'file-chat-menu')
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
