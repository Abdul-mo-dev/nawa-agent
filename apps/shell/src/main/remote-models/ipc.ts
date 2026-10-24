import { app, ipcMain, safeStorage, webContents, type WebContents } from 'electron'
import { REMOTE_EMBEDDING_CHANNEL, REMOTE_EMBEDDING_CHANGED } from '../../shared/remote-models-api'
import type { RagService } from '../rag/service'
import { RemoteEmbeddingProfiles } from './embeddings'
export function registerRemoteEmbeddingIpc(
  isHomeSender: (sender: WebContents) => boolean,
  rag: RagService,
) {
  const service = new RemoteEmbeddingProfiles(app.getPath('userData'), safeStorage, rag)
  ipcMain.handle(REMOTE_EMBEDDING_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !isHomeSender(event.sender))
      throw new Error('Remote model profiles are available only in Nawa settings.')
    let result: unknown
    switch (action) {
      case 'list':
        return service.list()
      case 'save':
        result = await service.save(args[0], args[1], args[2] as string | undefined)
        break
      case 'remove':
        result = await service.remove(args[0], args[1])
        break
      case 'apply':
        return service.apply(args[0], args[1])
      case 'test':
        return service.test(args[0], args[1] as string | undefined)
      case 'models':
        return service.models(args[0], args[1] as string | undefined)
      default:
        throw new Error('Unknown remote profile action.')
    }
    for (const sender of webContents.getAllWebContents())
      if (!sender.isDestroyed() && isHomeSender(sender)) sender.send(REMOTE_EMBEDDING_CHANGED)
    return result
  })
  return service
}
