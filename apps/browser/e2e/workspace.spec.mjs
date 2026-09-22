/** Real-browser/real-loopback regression. Run on Windows after npm ci:
 * npx playwright install chromium
 * npm run browser:test:ui
 * Unlike the authoring-environment DOM harness, this tests actual navigation,
 * authentication cookies, CSP and the real fetch transport. */
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../../../', import.meta.url))
let proc, temp, directory, launchUrl

test.beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'genoffice-ui-'))
  directory = path.join(temp, 'My Documents')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'welcome.txt'), '\ufeffWelcome\r\n')
  proc = spawn(process.execPath, ['apps/browser/server/start.mjs', '--port', '0', '--state-dir', path.join(temp, 'state')], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  launchUrl = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000)
    const consume = chunk => {
      output += chunk
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    }
    proc.stdout.on('data', consume); proc.stderr.on('data', consume)
    proc.once('error', error => { clearTimeout(timer); reject(error) })
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)) })
  })
})
test.afterAll(async () => {
  if (proc && proc.exitCode === null) { const exited = new Promise(resolve => proc.once('exit', resolve)); proc.kill(); await exited }
  if (temp) await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('mount, edit, conflict, Save As, create, reload and unsaved warning', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(launchUrl)
  await expect(page.locator('#connection-status')).toHaveText('Connected to this computer')
  await expect(page).not.toHaveURL(/token=/)
  await page.locator('#mount-top').click()
  await page.getByLabel('Windows folder path').fill(directory)
  await page.getByRole('button', { name: 'Mount folder', exact: true }).click()
  await page.locator('#file-list').getByText('welcome.txt', { exact: true }).click()
  let editor = page.getByRole('textbox', { name: 'Edit welcome.txt' })
  await editor.fill('Edited from the browser\n')
  await page.keyboard.press('Control+s')
  await expect(page.locator('#notice')).toHaveText('Saved welcome.txt')
  expect(await fs.readFile(path.join(directory, 'welcome.txt'), 'utf8')).toBe('\ufeffEdited from the browser\r\n')
  await fs.writeFile(path.join(directory, 'welcome.txt'), 'Changed by another application\n')
  await editor.fill('Keep my unsaved browser copy\n')
  await page.locator('#save').click()
  await expect(page.locator('#notice')).toContainText('changed on disk')
  expect(await fs.readFile(path.join(directory, 'welcome.txt'), 'utf8')).toBe('Changed by another application\n')
  await expect(editor).toHaveValue('Keep my unsaved browser copy\n')
  await page.locator('#save-as').click()
  await page.getByLabel('Filename (a new file; existing files are not overwritten)').fill('recovered.txt')
  await page.locator('#modal-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('#notice')).toHaveText('Saved recovered.txt')
  expect(await fs.readFile(path.join(directory, 'recovered.txt'), 'utf8')).toContain('Keep my unsaved browser copy')
  await page.locator('#home').click(); await page.locator('#new-file').click()
  await page.getByLabel('File type', { exact: true }).selectOption('md')
  await page.getByLabel('Name', { exact: true }).fill('created.md')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  editor = page.getByRole('textbox', { name: 'Edit created.md' })
  await editor.fill('# Browser-created document\n')
  await page.keyboard.press('Control+s')
  await expect(page.locator('#notice')).toHaveText('Saved created.md')
  expect(await fs.readFile(path.join(directory, 'created.md'), 'utf8')).toBe('# Browser-created document\n')
  await page.locator('#home').click(); await page.locator('#new-file').click()
  await page.getByLabel('File type', { exact: true }).selectOption('directory')
  await page.getByLabel('Name', { exact: true }).fill('New Folder')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('#file-list').getByText('New Folder', { exact: true })).toBeVisible()
  expect((await fs.stat(path.join(directory, 'New Folder'))).isDirectory()).toBe(true)
  await page.reload()
  await expect(page.locator('#file-list').getByText('created.md', { exact: true })).toBeVisible()
  await expect(page.locator('#new-file')).toBeEnabled()
  await page.locator('#file-list').getByText('created.md', { exact: true }).click()
  editor = page.getByRole('textbox', { name: 'Edit created.md' }); await editor.fill('Unsaved')
  page.once('dialog', dialog => dialog.dismiss())
  await page.locator('#reload').click()
  await expect(editor).toHaveValue('Unsaved')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#reload').click()
  await expect(page.getByRole('textbox', { name: 'Edit created.md' })).toHaveValue('# Browser-created document\n')
  expect(errors).toEqual([])
})
