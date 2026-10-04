import { saveFileWithStaging } from '@genoffice/electron-utils/atomic-write'

export async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  await saveFileWithStaging(filePath, data, { onLockedRename: 'write-in-place' })
}
