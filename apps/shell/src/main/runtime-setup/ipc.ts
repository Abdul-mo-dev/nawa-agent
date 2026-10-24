import { app, ipcMain, shell, type WebContents } from 'electron'
import { mkdir } from 'node:fs/promises'
import { RuntimeSetupService } from './service'
import { RUNTIME_SETUP_CHANNEL } from '../../shared/runtime-setup-api'
import type { LocalModelsService } from '../local-models/service'
import { ensureOcrEngine } from '../pdf2docx-local'

export function registerRuntimeSetupIpc(
  isHomeSender: (sender: WebContents) => boolean,
  models: LocalModelsService,
): RuntimeSetupService {
  const service = new RuntimeSetupService(app.getPath('userData'), models, {
    packaged: app.isPackaged,
    ocrAvailable: () => !!ensureOcrEngine(),
  })
  ipcMain.handle(RUNTIME_SETUP_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !isHomeSender(event.sender))
      throw new Error('Runtime setup is available only in Nawa settings.')
    switch (action) {
      case 'inspect':
        return service.inspect()
      case 'install':
        return service.install(args[0])
      case 'cancel':
        return service.cancel()
      case 'dismiss':
        return service.dismiss()
      case 'activated':
        return service.activated()
      case 'reveal': {
        await mkdir(service.directory, { recursive: true })
        const error = await shell.openPath(service.directory)
        if (error) throw new Error(error)
        return
      }
      case 'openLanguages':
        return shell.openExternal('ms-settings:regionlanguage')
      default:
        throw new Error('Unknown runtime setup action.')
    }
  })
  app.once('will-quit', () => service.cancel())
  // Restore an app-managed Office converter before opening documents.
  void service.inspect().catch((error) => console.warn('[runtime-setup]', String(error)))
  return service
}
