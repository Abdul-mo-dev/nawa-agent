import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { openPptx, pendingSaveCount, savePptxToFile, commitSaved } from '../src/index'

let failWrite = false
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args)
      if (failWrite) {
        const write = stream._write.bind(stream)
        stream._write = (chunk, encoding, callback) =>
          write(chunk.subarray(0, 32), encoding, (error) =>
            callback(error ?? new Error('Injected ENOSPC after 32 bytes')),
          )
      }
      return stream
    },
  }
})

it('preserves an existing deck on stream failure, detects external changes, and returns the committed hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawa-pptx-atomic-'))
  try {
    const original = await readFile(
      resolve('../../test-files/legacy-office/source/presentation-sample.pptx'),
    )
    const target = join(dir, 'target.pptx')
    await writeFile(target, original)
    const doc = await openPptx(original)
    failWrite = true
    await expect(savePptxToFile(doc, target)).rejects.toThrow('Injected ENOSPC')
    expect(await readFile(target)).toEqual(original)
    expect(await readdir(dir)).toEqual(['target.pptx'])
    expect(pendingSaveCount(doc)).toBe(0)
    failWrite = false
    await expect(savePptxToFile(doc, target, { expectedRevision: 'outdated' })).rejects.toThrow(
      'changed outside',
    )
    expect(await readFile(target)).toEqual(original)
    const receipt = await savePptxToFile(doc, target, {
      expectedRevision: createHash('sha256').update(original).digest('hex'),
    })
    expect(receipt.outputHash).toBe(
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
    )
    commitSaved(doc, receipt)
    expect(pendingSaveCount(doc)).toBe(0)
  } finally {
    failWrite = false
    await rm(dir, { recursive: true, force: true })
  }
})
