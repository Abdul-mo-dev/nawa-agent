import { test, expect, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * Arabic mirrors UI chrome while documents retain their own direction.
 *
 * `dir="rtl"` on <html> is inherited by everything, so an English document
 * opened under the Arabic UI was laid out — and, for the canvas editors, drawn —
 * right-to-left on screen while its saved content stayed left-to-right. The six
 * document surfaces pin `direction: ltr`; these cases assert the *computed*
 * style, which is what Konva and Univer pick up through their inherited
 * `ctx.direction`.
 */

/** Create each document through the same API used by the shell's New menu. */
const APPS = [
  { name: 'docs', create: 'newDoc', url: '://docs/', host: '.editor-scroll' },
  { name: 'sheets', create: 'newSheet', url: '://sheets/', host: '#univer-container' },
  { name: 'slides', create: 'newSlide', url: '://slides/', host: '.stage-wrap' },
  { name: 'markdown', create: 'newMarkdown', url: '://markdown/', host: '.editor-scroll' },
  { name: 'html', create: 'newHtml', url: '://html/', host: '.preview-stage' },
  { name: 'pdf', create: 'newPdf', url: '://pdf/', host: '.pdf-scroll' },
] as const

const directionOf = (page: Page, host: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el).direction : null
  }, host)

test('the UI uses Arabic text direction under ar', async () => {
  test.setTimeout(180_000)
  const launched = await launchShell({ onboardingSeen: true, lang: 'ar', videoDir: 'rtl-chrome' })
  try {
    await expect(launched.page.locator('html')).toHaveAttribute('dir', 'rtl')
  } finally {
    await closeAndSaveVideo(launched, 'rtl-chrome')
  }
})

for (const { name, create, url, host } of APPS) {
  test(`${name}: Arabic mirrors toolbars and preserves document direction`, async () => {
    test.setTimeout(240_000)
    const defaultSaveDir = await mkdtemp(join(tmpdir(), 'nawa-rtl-layout-'))
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'en',
      settings: { defaultSaveDir },
      videoDir: `rtl-${name}`,
    })
    try {
      await launched.page.evaluate((method) => window.aiOffice[method](), create)
      const page = await waitForPageWithUrl(launched.app, url)
      const surface = page.locator(host).first()
      await expect(surface).toBeVisible({ timeout: 45_000 })
      const tabs = page.locator('.ribbon-tabs')
      const firstTab = tabs.locator(':scope > button').first()
      const originalTabs = await tabs.boundingBox()
      await launched.page.evaluate(() => window.aiOffice.setLanguage('ar'))
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      await expect(tabs).toHaveCSS('direction', 'rtl')
      await expect(page.locator('[data-ribbon-body]').first()).toHaveCSS('direction', 'rtl')
      await expect(firstTab).toHaveCSS('direction', 'rtl')
      const localizedTabs = await tabs.boundingBox()
      expect(localizedTabs!.x).toBeCloseTo(originalTabs!.x, 0)
      // The leading edge is now on the right.
      expect((await firstTab.boundingBox())!.x).toBeGreaterThan(
        localizedTabs!.x + localizedTabs!.width / 2,
      )
      // the assertion the review asked for
      expect(await directionOf(page, host)).toBe('ltr')
      // and what depends on it: an RTL scroller reports a negative scrollLeft,
      // which is what sent zoom-to-cursor jumping in docs, pdf and slides
      const scrollLeft = await surface.evaluate((el) => el.scrollLeft)
      expect(scrollLeft).toBeGreaterThanOrEqual(0)
      await page.screenshot({ path: screenshotPath(`arabic-${name}-interface`) })
      await launched.page.evaluate(() => window.aiOffice.setLanguage('en'))
      await expect(tabs).toHaveCSS('direction', 'ltr')
      expect(await directionOf(page, host)).toBe('ltr')
    } finally {
      await closeAndSaveVideo(launched, `rtl-${name}`)
    }
  })
}
