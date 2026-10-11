import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.task/employee-count-review')
await fs.mkdir(output, { recursive: true })
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 5193 },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const check = (name, value) => {
  assert.ok(value, name)
  console.log('PASS ' + name)
}
try {
  await page.goto(server.resolvedUrls.local[0] + 'tools/sidebar-review/', {
    timeout: 60000,
    waitUntil: 'domcontentloaded',
  })
  await page.getByRole('textbox', { name: 'Message Nawa' }).waitFor()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.evaluate(() => {
    const folder = 'C:\\Review workspace\\Quarterly reports'
    globalThis.sidebarFixture.state.scenario = 'employee-count'
    globalThis.sidebarFixture.select(
      [
        folder + '\\employee-data.xlsx',
        ...Array.from({ length: 22 }, (_, i) => folder + '\\other-' + i + '.xlsx'),
      ],
      [],
    )
  })
  await page
    .getByRole('textbox', { name: 'Message Nawa' })
    .fill('how may employee in employee-data.xlsx')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByText('There are 500 included records.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  const captured = await page.evaluate(() => ({
    first: globalThis.sidebarFixture.state.requests[0],
    analysis: globalThis.sidebarFixture.state.analyticsRequests,
    messages: globalThis.sidebarFixture.messages(),
    scope: globalThis.sidebarFixture.state.beginScopes.at(-1),
  }))
  check(
    'Native analysis is advertised before the first model response',
    captured.first.tools.some((tool) => tool.name === 'query_data'),
  )
  check(
    'Verified dataset IDs and actual headers are supplied before inspection',
    JSON.stringify(captured.first.messages).includes('ready-employees') &&
      JSON.stringify(captured.first.messages).includes('name\\":\\"name'),
  )
  check(
    'The named Ready dataset is queried without reimporting',
    captured.analysis.some(
      (item) => item.action === 'query' && item.payload.datasetIds[0] === 'ready-employees',
    ) && !captured.analysis.some((item) => item.action === 'prepare'),
  )
  const final = captured.messages.filter((message) => message.role === 'assistant').at(-1)
  const visibleAnswer = (await page.locator('.ws-chat-assistant').allTextContents()).join('\n')
  check(
    'The premature column question is replaced by a verified conditional count',
    final.text.includes('500 included records') &&
      final.text.includes('analysis_employee_count') &&
      !final.text.includes('specify the column') &&
      !visibleAnswer.includes('specify the column') &&
      final.request?.outcome === 'completed',
  )
  check('The request retains the original 23-file selection', captured.scope.files.length === 23)
  check('No renderer errors', errors.length === 0)
  await page.screenshot({ path: path.join(output, 'employee-count.png') })
} catch (error) {
  console.log('Renderer errors:', JSON.stringify(errors))
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser.close()
  await server.close()
}
