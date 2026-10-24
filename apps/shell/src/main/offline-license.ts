import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog } from 'electron'
import {
  assertOfflineLicense,
  offlineLicenseHelper,
  parseOfflineLicensePolicy,
} from '@genoffice/electron-utils/offline-license'

/** Runs before headless settings/export, windows, model services, or CLI setup. */
export async function requirePcApproval(headless: boolean): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'win32') return true
  try {
    // Read from the validated ASAR, never userData or an environment override.
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      nawaOfflineLicense?: unknown
    }
    const policy = parseOfflineLicensePolicy(metadata.nawaOfflineLicense)
    try {
      assertOfflineLicense(process.resourcesPath, policy)
      return true
    } catch (error) {
      if (headless) throw error
    }
    const helper = offlineLicenseHelper(process.resourcesPath, policy)
    try {
      await promisify(execFile)(
        helper,
        ['activate', '--lang', process.env.GENOFFICE_LANG || app.getLocale().split('-')[0]],
        {
          // This is an interactive activation window, not a background helper.
          windowsHide: false,
          // The user may leave the offline request dialog open while waiting for approval.
          maxBuffer: 64 * 1024,
        },
      )
    } catch {
      app.exit(3)
      return false
    }
    assertOfflineLicense(process.resourcesPath, policy)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (headless)
      process.stdout.write(
        JSON.stringify({ status: 'error', code: 4, error: 'license_required', message }) + '\n',
      )
    else dialog.showErrorBox('Nawa — PC approval', message)
    app.exit(4)
    return false
  }
}
