import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strings } from '../apps/shell/src/renderer/src/strings'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('offers only English, Japanese and Arabic and migrates a removed language', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    settings: { language: 'fr' },
    env: { GENOFFICE_LANG: '' },
    videoDir: 'ui-languages',
  })
  const { page, userDataDir } = launched
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    expect(await page.evaluate(() => window.aiOffice.getLanguage())).toBe('en')
    await page.getByRole('button', { name: strings.en.settings, exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: strings.en.setSecGeneral }).click()

    const layoutSelectors = [
      '.tab-strip',
      '.ex-history',
      '.ex-search',
      '.ex-navigation',
      '.ex-center',
      '.set-nav',
      '.set-pane',
      '.set-close',
    ]
    const originalLayout = await Promise.all(
      layoutSelectors.map((selector) => page.locator(selector).boundingBox()),
    )

    let current: 'en' | 'ja' | 'ar' = 'en'
    for (const next of ['ja', 'ar', 'en'] as const) {
      await page.getByRole('button', { name: strings[current].language, exact: true }).click()
      await expect(page.getByRole('option')).toHaveText(['العربية', 'English', '日本語'])
      const label = { en: 'English', ja: '日本語', ar: 'العربية' }[next]
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        { en: 'en-US', ja: 'ja-JP', ar: 'ar-SA' }[next],
      )
      await expect(page.locator('html')).toHaveAttribute('dir', next === 'ar' ? 'rtl' : 'ltr')
      const newButton = await page.locator('.ex-new-button').boundingBox()
      const assistantButton = await page.locator('.ex-assistant-toggle').boundingBox()
      expect(assistantButton!.x).toBeGreaterThanOrEqual(newButton!.x + newButton!.width)
      for (const [index, selector] of layoutSelectors.entries()) {
        const box = await page.locator(selector).boundingBox()
        expect(box, `${selector} is visible in ${next}`).not.toBeNull()
        expect(box!.x, `${selector} keeps its horizontal position in ${next}`).toBeCloseTo(
          originalLayout[index]!.x,
          0,
        )
        expect(box!.width, `${selector} keeps its width in ${next}`).toBeCloseTo(
          originalLayout[index]!.width,
          0,
        )
      }
      const textDirection = next === 'ar' ? 'rtl' : 'ltr'
      await expect(page.locator('.set-title')).toHaveCSS('direction', textDirection)
      await expect(page.locator('.set-field-label').first()).toHaveCSS('direction', textDirection)
      await expect(page.locator('.set-dd .gs-dd-value').first()).toHaveCSS(
        'direction',
        textDirection,
      )
      if (next !== 'ja') {
        await page.screenshot({ path: screenshotPath(`ui-layout-${next}`) })
      }
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8')).language,
        )
        .toBe(next)
      current = next
    }
  } finally {
    await closeAndSaveVideo(launched, 'ui-languages')
  }
})
