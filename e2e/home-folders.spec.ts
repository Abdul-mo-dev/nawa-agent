import { test, expect } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createNewFile, launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

/** Explorer folder operations against a scratch workspace on the real disk. */
test.describe('home folders panel', () => {
  let root: string

  test.beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-root-')))
    mkdirSync(join(root, 'Clients', 'Contracts'), { recursive: true })
    mkdirSync(join(root, 'Personal'))
    writeFileSync(join(root, 'Clients', 'Contracts', 'deal.md'), '# deal')
  })

  test.afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('browses, creates, moves, renames and deletes folders and files', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: root },
      videoDir: 'home-folders',
    })
    const { page } = launched
    try {
      const tree = page.getByRole('tree', { name: `${basename(root)} documents` })
      await expect(tree.getByRole('treeitem', { name: 'Clients' })).toBeVisible()
      await expect(tree.getByRole('treeitem', { name: 'Personal' })).toBeVisible()
      await tree
        .getByRole('treeitem', { name: 'Clients' })
        .getByRole('button', { name: 'Expand Clients' })
        .click()
      await tree.getByRole('treeitem', { name: 'Contracts' }).click()
      await expect(page.locator('.ex-file-row', { hasText: 'deal.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-folders-contracts') })

      await page.locator('.ex-new-button').click()
      await page.getByRole('menuitem', { name: 'Folder', exact: true }).click()
      const createDialog = page.getByRole('dialog', { name: 'Create folder' })
      await createDialog.getByRole('textbox', { name: 'Name' }).fill('Drafts')
      await createDialog.getByRole('button', { name: 'Save' }).click()
      await expect(page.locator('.ex-file-row', { hasText: 'Drafts' })).toBeVisible()
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Drafts'))).toBe(true)

      await page.locator('.ex-file-row', { hasText: 'deal.md' }).click()
      await page.getByRole('button', { name: 'Cut', exact: true }).click()
      await tree.getByRole('treeitem', { name: 'Personal' }).click()
      await page.getByRole('button', { name: 'Paste', exact: true }).click()
      await expect(page.locator('.ex-file-row', { hasText: 'deal.md' })).toBeVisible()
      expect(existsSync(join(root, 'Personal', 'deal.md'))).toBe(true)
      expect(existsSync(join(root, 'Clients', 'Contracts', 'deal.md'))).toBe(false)

      await tree.getByRole('treeitem', { name: 'Contracts' }).click()
      await page.locator('.ex-file-row', { hasText: 'Drafts' }).click()
      await page.getByRole('button', { name: 'Rename', exact: true }).click()
      const renameDialog = page.getByRole('dialog', { name: 'Rename item' })
      await renameDialog.getByRole('textbox', { name: 'Name' }).fill('Final')
      await renameDialog.getByRole('button', { name: 'Save' }).click()
      await expect(page.locator('.ex-file-row', { hasText: 'Final' })).toBeVisible()
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Final'))).toBe(true)

      await page.locator('.ex-file-row', { hasText: 'Final' }).click()
      await page.getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Move selected items to Recycle Bin?' })
        .getByRole('button', { name: 'Move to Recycle Bin' })
        .click()
      await expect(page.locator('.ex-file-row', { hasText: 'Final' })).toHaveCount(0)
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Final'))).toBe(false)

      await tree.getByRole('treeitem', { name: 'Personal' }).click()
      await expect(page.locator('.ex-file-row', { hasText: 'deal.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-folders-personal') })
    } finally {
      await closeAndSaveVideo(launched, 'home-folders')
    }
  })

  test('new files created from a folder view land in that folder', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: root },
      videoDir: 'home-folders-new-file',
    })
    const { page } = launched
    try {
      await page.getByRole('treeitem', { name: 'Personal' }).click()
      await expect(page.locator('.ex-content-heading h1')).toHaveText('Personal')
      await createNewFile(page, 'PDF')
      const hasFile = (dir: string, extension: string) =>
        existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(extension))
      await expect.poll(() => hasFile(join(root, 'Personal'), '.pdf')).toBe(true)
      expect(hasFile(root, '.pdf')).toBe(false)
      await expect(page.locator('.tab-bar .tab-item', { hasText: '.pdf' })).toBeVisible()

      await page.locator('.tab-bar .tab-item.tab-home').click()
      await expect(page.locator('.ex-content-heading h1')).toHaveText('Personal')
      await createNewFile(page, 'Spreadsheet')
      expect(hasFile(join(root, 'Personal'), '.xlsx')).toBe(false)
      expect(hasFile(root, '.xlsx')).toBe(false)
    } finally {
      await closeAndSaveVideo(launched, 'home-folders-new-file')
    }
  })
})
