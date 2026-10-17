import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { commitSaved, createBlankPptx, openPptx, savePptxToFile } from '../src'

it.each(['pptx', 'ppsx', 'potx'])(
  'preserves VBA for macro saves and removes its graph on .%s Save As',
  async (extension) => {
    const dir = await mkdtemp(join(tmpdir(), 'slides-macros-'))
    try {
      const opened = await openPptx(await createBlankPptx())
      const vba = Buffer.from('opaque VBA byte-preservation sentinel')
      opened.archive.entries.set('ppt/custom-project.bin', vba)
      opened.archive.entries.set('ppt/signed-project.bin', Buffer.from('signed-project sentinel'))
      const types = opened.archive
        .readText('[Content_Types].xml')!
        .replace(
          '</Types>',
          '<Override PartName="/ppt/custom-project.bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/ppt/signed-project.bin" ContentType="application/vnd.ms-office.vbaProjectSignature"/></Types>',
        )
      opened.archive.entries.set('[Content_Types].xml', Buffer.from(types))
      const rels = opened.archive
        .readText('ppt/_rels/presentation.xml.rels')!
        .replace(
          '</Relationships>',
          '<Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="custom-project.bin"/></Relationships>',
        )
      opened.archive.entries.set('ppt/_rels/presentation.xml.rels', Buffer.from(rels))
      opened.archive.entries.set(
        'ppt/_rels/custom-project.bin.rels',
        Buffer.from(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSig" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProjectSignature" Target="signed-project.bin"/></Relationships>',
        ),
      )
      const macroPath = join(dir, 'deck.potm')
      commitSaved(opened, await savePptxToFile(opened, macroPath))
      const macro = await JSZip.loadAsync(await readFile(macroPath))
      expect(await macro.file('ppt/custom-project.bin')!.async('nodebuffer')).toEqual(vba)
      expect(await macro.file('[Content_Types].xml')!.async('string')).toContain(
        'ms-powerpoint.template.macroEnabled.main+xml',
      )
      const path = join(dir, `deck.${extension}`)
      commitSaved(opened, await savePptxToFile(opened, path))
      const saved = await JSZip.loadAsync(await readFile(path))
      for (const name of [
        'ppt/custom-project.bin',
        'ppt/signed-project.bin',
        'ppt/_rels/custom-project.bin.rels',
      ]) {
        expect(saved.file(name)).toBeNull()
        expect(opened.archive.entries.has(name)).toBe(false)
      }
      expect(await saved.file('[Content_Types].xml')!.async('string')).not.toContain('vbaProject')
      expect(await saved.file('ppt/_rels/presentation.xml.rels')!.async('string')).not.toContain(
        'custom-project',
      )
      expect((await openPptx(await readFile(path))).deck.slides).toHaveLength(1)
      // A subsequent macro-enabled save cannot resurrect the removed payload.
      commitSaved(opened, await savePptxToFile(opened, macroPath))
      expect(
        (await JSZip.loadAsync(await readFile(macroPath))).file('ppt/custom-project.bin'),
      ).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
