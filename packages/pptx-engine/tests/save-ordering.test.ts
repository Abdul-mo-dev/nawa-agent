import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  openPptx,
  savePptx,
  savePptxToFile,
  commitSaved,
  discardSave,
  pendingSaveCount,
  addElement,
  createBlankPptx,
  type SaveReceipt,
} from '../src/index'

const dir = () => mkdtempSync(join(tmpdir(), 'save-order-'))
const out = (d: string, name: string) => join(d, name)
const slideTextOf = async (file: string, slidePath: string) =>
  JSZip.loadAsync(readFileSync(file)).then((zip) => zip.file(slidePath)!.async('string'))

async function blankWith(text: string) {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]!
  addElement(slide, {
    kind: 'textbox',
    offset: { x: 100000, y: 100000, cx: 4000000, cy: 500000 },
    paragraphs: [{ runs: [{ text }] }],
  })
  return { opened, slide }
}

const isDirty = (slide: { structureDirty?: unknown; elements: Array<{ dirty?: unknown }> }) =>
  !!slide.structureDirty || slide.elements.some((el) => !!el.dirty)

describe('out-of-order saves', () => {
  // Regression test for the P1 data-loss defect: commits were paired with
  // snapshots FIFO by start order (shift) while failures dropped the NEWEST
  // snapshot (pop), so a commit could clear dirty flags for edits its own
  // bytes never contained. Receipts pair each commit with the exact operation
  // that finished.
  it('reversed completion: each commit clears only what its own operation wrote', async () => {
    const d = dir()
    const { opened, slide } = await blankWith('FIRST_EDIT')
    // A starts (snapshot: FIRST_EDIT only), then the second edit lands and B
    // starts (snapshot: both edits). buildZip runs synchronously inside
    // savePptxToFile, so the snapshots are taken in call order.
    const saveA = savePptxToFile(opened, out(d, 'a.pptx'))
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 100000, y: 800000, cx: 4000000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'SECOND_EDIT' }] }],
    })
    const saveB = savePptxToFile(opened, out(d, 'b.pptx'))
    expect(pendingSaveCount(opened)).toBe(2)

    const [receiptA, receiptB] = await Promise.all([saveA, saveB])

    // B (started later, carrying both edits) finishes first: everything its
    // bytes contain is baked and the flags clear — truthful, file B is whole.
    commitSaved(opened, receiptB)
    expect(isDirty(slide)).toBe(false)
    expect(pendingSaveCount(opened)).toBe(1)

    // A (stale: its bytes lack SECOND_EDIT) finishes last: its snapshot no
    // longer matches the baked state, so the commit is a no-op instead of
    // clearing flags for an edit the written package lacks. (A stale write
    // finishing last on the same path is prevented one level up by the
    // per-session save lock; the engine guarantees flags never lie here.)
    commitSaved(opened, receiptA)
    expect(isDirty(slide)).toBe(false)
    expect(pendingSaveCount(opened)).toBe(0)

    expect(await slideTextOf(out(d, 'b.pptx'), slide.path)).toContain('SECOND_EDIT')
    expect(await slideTextOf(out(d, 'a.pptx'), slide.path)).not.toContain('SECOND_EDIT')
    // The live deck still holds both edits; the next save persists them.
    expect(await slideTextOf(out(d, 'b.pptx'), slide.path)).toContain('FIRST_EDIT')
    const live = await openPptx(await savePptx(opened))
    const liveXml = live.archive.readText(slide.path)!
    expect(liveXml).toContain('FIRST_EDIT')
    expect(liveXml).toContain('SECOND_EDIT')
  })

  it('earlier save failing while a later save is in flight: the later save still commits, the failed receipt is discarded', async () => {
    const d = dir()
    const { opened, slide } = await blankWith('FIRST_EDIT')
    // A targets an unwritable path (no mkdir, like a failed stream); B is the
    // live save. The old pop()-newest failure path dropped B's snapshot here.
    const saveA = savePptxToFile(opened, '/definitely/not/a/directory/out.pptx')
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 100000, y: 800000, cx: 4000000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'SECOND_EDIT' }] }],
    })
    const saveB = savePptxToFile(opened, out(d, 'b.pptx'))
    await expect(saveA).rejects.toThrow()
    const receiptB = await saveB
    // The failure discarded exactly A's receipt; B is the only one pending.
    expect(pendingSaveCount(opened)).toBe(1)

    commitSaved(opened, receiptB)
    expect(isDirty(slide)).toBe(false)
    expect(pendingSaveCount(opened)).toBe(0)

    const xml = await slideTextOf(out(d, 'b.pptx'), slide.path)
    expect(xml).toContain('FIRST_EDIT')
    expect(xml).toContain('SECOND_EDIT')
  })

  it('sequential edit→save→commit cycles clear flags, persist, and leave no receipts', async () => {
    const d = dir()
    const { opened, slide } = await blankWith('FIRST_CYCLE_EDIT')
    expect(pendingSaveCount(opened)).toBe(0)
    commitSaved(opened, await savePptxToFile(opened, out(d, 'one.pptx')))
    expect(isDirty(slide)).toBe(false)
    expect(pendingSaveCount(opened)).toBe(0)

    addElement(slide, {
      kind: 'textbox',
      offset: { x: 100000, y: 800000, cx: 4000000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'SECOND_CYCLE_EDIT' }] }],
    })
    commitSaved(opened, await savePptxToFile(opened, out(d, 'two.pptx')))
    expect(isDirty(slide)).toBe(false)
    expect(pendingSaveCount(opened)).toBe(0)

    const xml = await slideTextOf(out(d, 'two.pptx'), slide.path)
    expect(xml).toContain('FIRST_CYCLE_EDIT')
    expect(xml).toContain('SECOND_CYCLE_EDIT')
  })

  it('unknown and double-consumed receipts never clear flags (fail dirty)', async () => {
    const { opened, slide } = await blankWith('GUARDED_EDIT')
    expect(isDirty(slide)).toBe(true)

    // A receipt from another deck (or fabricated) is a no-op.
    const foreign = await openPptx(await createBlankPptx())
    const foreignReceipt: SaveReceipt = await savePptxToFile(foreign, out(dir(), 'f.pptx'))
    commitSaved(opened, foreignReceipt)
    expect(isDirty(slide)).toBe(true)
    discardSave(foreign, foreignReceipt)

    // Double commit of the same receipt: the second is a no-op.
    const receipt = await savePptxToFile(opened, out(dir(), 'g.pptx'))
    commitSaved(opened, receipt)
    expect(isDirty(slide)).toBe(false)
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 100000, y: 800000, cx: 4000000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'AFTER_COMMIT' }] }],
    })
    commitSaved(opened, receipt)
    expect(isDirty(slide)).toBe(true)
    expect(pendingSaveCount(opened)).toBe(0)
  })
})
