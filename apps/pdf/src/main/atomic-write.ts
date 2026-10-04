import { saveFileWithStaging } from '@genoffice/electron-utils/atomic-write'

/** Write PDF bytes beside the destination, then atomically replace it. */
export async function writePdfAtomically(targetPath: string, bytes: Uint8Array): Promise<void> {
  await saveFileWithStaging(targetPath, bytes)
}
