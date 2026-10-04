import { saveFileWithStaging } from '@genoffice/electron-utils/atomic-write'

export async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  await saveFileWithStaging(filePath, data, { onLockedRename: 'write-in-place' })
}

/** 'PK\x03\x04' local-file-header check — cheap docx/zip sanity test. */
export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50
}
