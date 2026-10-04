import { test, expect } from '@playwright/test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNewFile,
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  zipText,
} from './helpers'

/**
 * Regression for "new spreadsheet cannot be saved" (feedback 2368785): the
 * quick-create card must create a real backing .xlsx up front so the save
 * pipeline works from the first edit.
 */
test.describe('sheets: new blank workbook', () => {
  test('quick-create writes a backing file and saves the first edit', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-sheets-blank-'))
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: join(scratch, 'GenOffice') },
      videoDir: 'sheets-new-blank',
    })
    try {
      const { app, page } = launched
      await createNewFile(page, 'Spreadsheet')

      const sheets = await waitForPageWithUrl(app, '://sheets/')
      await sheets.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
        timeout: 30_000,
      })
      await sheets.waitForTimeout(1_500)

      // the backing file exists before any edit
      const saveDir = join(scratch, 'GenOffice')
      const created = (await readdir(saveDir)).filter((f) => f.endsWith('.xlsx'))
      expect(created).toHaveLength(1)
      const workbook = join(saveDir, created[0])

      const grid = await sheets.evaluate(() => {
        for (const canvas of document.querySelectorAll('canvas')) {
          const rect = canvas.getBoundingClientRect()
          if (rect.width > 500 && rect.height > 300) return { x: rect.x, y: rect.y }
        }
        return null
      })
      if (!grid) throw new Error('worksheet canvas not found')
      await sheets.mouse.click(grid.x + 46 + 43, grid.y + 24 + 12)
      await expect(sheets.locator('[data-u-comp="defined-name"] input')).toHaveValue('A1')
      await sheets.keyboard.type('42', { delay: 50 })
      await sheets.keyboard.press('Enter')
      await sheets.screenshot({ path: screenshotPath('sheets-new-blank-edited') })

      await app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('://sheets/'))
        wc?.send('menu:action', 'save')
      })
      await expect(async () => {
        const xml = await zipText(workbook, 'xl/worksheets/sheet1.xml')
        expect(xml).toContain('<v>42</v>')
      }).toPass({ timeout: 15_000 })
    } finally {
      await closeAndSaveVideo(launched, 'sheets-new-blank')
    }
  })
})
