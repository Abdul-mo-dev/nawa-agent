import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('shows Explorer navigation, contextual file controls and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.getByTestId('nawa-explorer')).toBeVisible()
      await expect(page.getByRole('toolbar', { name: 'File commands' })).toHaveCount(0)
      await expect(page.locator('.ex-address-row .ex-layout-controls')).toBeVisible()
      await page.locator('.ex-content-heading .ex-new-button').click()
      for (const kind of ['Document', 'Spreadsheet', 'Presentation', 'Markdown', 'HTML', 'PDF']) {
        await expect(page.getByRole('menuitem', { name: kind, exact: true })).toBeVisible()
      }
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when GENOFFICE_LANG=ja', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'ja',
      videoDir: 'home-ja',
    })
    const { page } = launched
    try {
      await expect(page.locator('.ex-new-button')).toContainText('新規')
      await page.screenshot({ path: screenshotPath('home-ja') })
    } finally {
      await closeAndSaveVideo(launched, 'home-ja')
    }
  })

  test('recent files outside workspace folders do not request analytics status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nawa-external-recent-'))
    const file = join(dir, 'external.md')
    await writeFile(file, '# External recent\n')
    try {
      const launched = await launchShell({
        onboardingSeen: true,
        openFile: file,
        videoDir: 'home-external-recent',
      })
      try {
        const { page } = launched
        await expect(page.locator('.tab-bar .tab-item:not(.tab-home)')).toHaveCount(1)
        await page.locator('.tab-bar .tab-item.tab-home').click()
        const row = page.locator('.ex-file-row', { hasText: 'external.md' })
        await expect(row).toBeVisible()
        await expect(row.locator('.ex-column-indexed')).toHaveText('—')
        await expect(row.locator('.ex-column-data')).toHaveText('—')
      } finally {
        await closeAndSaveVideo(launched, 'home-external-recent')
      }
    } finally {
      await unlink(file)
      await rmdir(dir)
    }
  })
})
