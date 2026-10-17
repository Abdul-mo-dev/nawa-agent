import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import {
  commitSaved,
  createBlankPptx,
  discardSave,
  insertBlankSlide,
  openPptx,
  savePptxToFile,
} from '../src'

it.each(['ppsx', 'potx'])(
  'edits and round-trips .%s, then saves a regular presentation',
  async (ext) => {
    const directory = await mkdtemp(join(tmpdir(), 'presentation-format-'))
    try {
      const opened = await openPptx(await createBlankPptx())
      const originalMaster = opened.archive.readBytes('ppt/slideMasters/slideMaster1.xml')
      expect(insertBlankSlide(opened, 0)).not.toBeNull()
      const variantPath = join(directory, `deck.${ext}`)
      const variantReceipt = await savePptxToFile(opened, variantPath)
      const lateDeclaration =
        '<Override PartName="/custom/late.xml" ContentType="application/xml"/>'
      opened.archive.entries.set(
        '[Content_Types].xml',
        Buffer.from(
          opened.archive
            .readText('[Content_Types].xml')!
            .replace('</Types>', `${lateDeclaration}</Types>`),
        ),
      )
      opened.archive.entries.set('custom/late.xml', Buffer.from('<late/>'))
      // The receipt pairs this commit with the variant save above: its
      // formatPath normalizes [Content_Types] to the variant main type while
      // preserving the declaration added after the snapshot.
      commitSaved(opened, variantReceipt)
      expect(opened.archive.readText('[Content_Types].xml')).toContain(lateDeclaration)
      const type = ext === 'ppsx' ? 'slideshow' : 'template'
      expect(opened.archive.readText('[Content_Types].xml')).toContain(
        `presentationml.${type}.main+xml`,
      )
      const reopened = await openPptx(await readFile(variantPath))
      expect(reopened.deck.slides).toHaveLength(2)
      expect(reopened.archive.readBytes('ppt/slideMasters/slideMaster1.xml')).toEqual(
        originalMaster,
      )
      const regularPath = join(directory, 'deck.pptx')
      discardSave(reopened, await savePptxToFile(reopened, regularPath))
      const regular = await JSZip.loadAsync(await readFile(regularPath))
      expect(await regular.file('[Content_Types].xml')!.async('text')).toContain(
        'presentationml.presentation.main+xml',
      )
      expect((await openPptx(await readFile(regularPath))).deck.slides).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
