import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { reviewFileChanges } from '../src/review'

const source = resolve('../../test-files/xlsm-chat/sample.xlsm')
let scratch: string | undefined

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

it('reviews XLSM cell changes and reports any VBA-part mutation', async () => {
  await mkdir(resolve('../../.task'), { recursive: true })
  scratch = await mkdtemp(join(resolve('../../.task'), 'xlsm-review-'))
  const edited = await JSZip.loadAsync(await readFile(source))
  const sheet = await edited.file('xl/worksheets/sheet1.xml')!.async('string')
  expect(sheet).toContain('00123')
  edited.file('xl/worksheets/sheet1.xml', sheet.replace('00123', 'changed'))
  const changedSheet = join(scratch, 'changed.xlsm')
  await writeFile(changedSheet, await edited.generateAsync({ type: 'nodebuffer' }))
  const review = await reviewFileChanges(source, changedSheet)
  expect(review.complete).toBe(true)
  expect(review.entries.some((entry) => entry.kind === 'cell / formula / formatting')).toBe(true)
  expect(review.entries.some((entry) => entry.location === 'xl/vbaProject.bin')).toBe(false)
  expect(review.warnings.join(' ')).toContain('does not run or validate macros')

  edited.file('xl/vbaProject.bin', Buffer.from('changed VBA bytes'))
  const changedVba = join(scratch, 'changed-vba.xlsm')
  await writeFile(changedVba, await edited.generateAsync({ type: 'nodebuffer' }))
  const vbaReview = await reviewFileChanges(source, changedVba)
  expect(vbaReview.entries).toContainEqual(
    expect.objectContaining({ location: 'xl/vbaProject.bin', kind: 'VBA project' }),
  )
})
