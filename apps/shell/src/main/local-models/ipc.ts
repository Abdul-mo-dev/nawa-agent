import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LOCAL_MODELS_CHANNEL } from '../../shared/local-models-api'
import { LocalModelsService } from './service'

export function registerLocalModelsIpc(
  isHomeSender: (sender: WebContents) => boolean,
): LocalModelsService {
  const service = new LocalModelsService(join(app.getPath('userData'), 'local-models'))
  ipcMain.handle(LOCAL_MODELS_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !isHomeSender(event.sender))
      throw new Error('Local model controls are available only in Nawa settings.')
    switch (action) {
      case 'inspect':
        return service.inspect()
      case 'save':
        return service.save(args[0], args[1])
      case 'control': {
        const [operation, id] = args
        if (!['start', 'stop', 'restart'].includes(String(operation)) || typeof id !== 'string')
          throw new Error('Invalid runtime action.')
        if (operation !== 'start') await service.stop(id)
        if (operation !== 'stop') await service.start(id)
        return service.inspect()
      }
      case 'releases':
        return service.downloads.releases()
      case 'installEngine':
        return service.downloads.installEngine(args[0])
      case 'searchModels':
        return service.downloads.search(args[0])
      case 'modelFiles':
        return service.downloads.modelFiles(args[0])
      case 'downloadModel':
        return service.downloads.downloadModel(args[0], args[1], args[2])
      case 'cancelDownload':
        return service.downloads.cancel()
      case 'removeModel':
        return service.removeModel(args[0])
      case 'revealDirectory':
        await mkdir(service.directory, { recursive: true })
        return shell.openPath(service.directory).then((error) => {
          if (error) throw new Error(error)
        })
      case 'choosePath': {
        if (args[0] !== 'engine' && args[0] !== 'model')
          throw new Error('Choose an engine or model file.')
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) throw new Error('Nawa settings have closed.')
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile'],
          filters:
            args[0] === 'model'
              ? [{ name: 'GGUF', extensions: ['gguf'] }]
              : [
                  {
                    name: 'llama-server',
                    extensions: process.platform === 'win32' ? ['exe'] : ['*'],
                  },
                ],
        })
        return result.canceled ? null : (result.filePaths[0] ?? null)
      }
      default:
        throw new Error('Unknown local model action.')
    }
  })
  app.once('will-quit', () => service.dispose())
  void app
    .whenReady()
    .then(() => service.autoStart())
    .catch((error) =>
      console.warn('[local-models]', error instanceof Error ? error.message : String(error)),
    )
  return service
}
