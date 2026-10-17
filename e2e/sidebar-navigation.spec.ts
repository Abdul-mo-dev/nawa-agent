import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo } from './helpers'

for (const [lang, removedLabel] of [
  ['en', 'Ask AI'],
  ['ja', 'AIに質問'],
  ['ar', 'اسأل الذكاء الاصطناعي'],
] as const) {
  test(`${lang}: sidebar navigation has no standalone Ask AI screen`, async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang,
      videoDir: `sidebar-navigation-${lang}`,
    })
    const { page } = launched
    try {
      const navigation = page.locator('.ex-quick-nav')
      await expect(navigation.locator('button')).toHaveCount(4)
      await expect(page.getByRole('button', { name: removedLabel, exact: true })).toHaveCount(0)

      for (const index of [1, 2, 0]) {
        const button = navigation.locator('button').nth(index)
        await button.click()
        await expect(button).toHaveAttribute('aria-current', 'page')
      }

      // The remaining search entry opens the document home without an Ask AI route.
      await navigation.locator('button').nth(3).click()
      await expect(page.locator('.home.workspace-home')).toBeVisible()
      await expect(page.locator('.sidebar-nav button')).toHaveCount(3)
      await expect(page.getByRole('button', { name: removedLabel, exact: true })).toHaveCount(0)
      await expect(page.locator('.kb-ask')).toHaveCount(0)
      await page.locator('.ex-legacy-back').click()
      await expect(page.locator('.ex-quick-nav')).toBeVisible()
    } finally {
      await closeAndSaveVideo(launched, `sidebar-navigation-${lang}`)
    }
  })
}
