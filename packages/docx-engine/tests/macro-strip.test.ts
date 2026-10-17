import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { normalizeDocxFormat } from '../src/zip-splice'

const source = resolve('../../test-files/docm-chat/sample.docm')

async function macroZip(): Promise<JSZip> {
  return JSZip.loadAsync(await readFile(source))
}

async function normalized(zip: JSZip, target = 'copy.docx'): Promise<JSZip> {
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return JSZip.loadAsync(await normalizeDocxFormat(bytes, target))
}

/** The .task prefixed-macro repro: legal prefixes on the packaging parts. */
async function withPrefixedPackaging(zip: JSZip): Promise<JSZip> {
  for (const [part, prefix, names] of [
    ['[Content_Types].xml', 'ct', 'Types|Override|Default'],
    ['word/_rels/document.xml.rels', 'r', 'Relationships|Relationship'],
  ] as const) {
    const xml = await zip.file(part)!.async('string')
    zip.file(
      part,
      xml
        .replace('xmlns=', `xmlns:${prefix}=`)
        .replace(new RegExp(`<(\\/?)(?:${names})\\b`, 'g'), (tag) =>
          tag.replace(/^(<\/?)/, `$1${prefix}:`),
        ),
    )
  }
  return zip
}

describe('macro-free Save As strips the VBA graph', () => {
  it('drops the project binary, its Override, and its document relationship', async () => {
    const saved = await normalized(await macroZip())
    expect(saved.file('word/vbaProject.bin')).toBeNull()
    expect(await saved.file('[Content_Types].xml')!.async('string')).not.toContain('vbaProject')
    expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
    expect(await saved.file('[Content_Types].xml')!.async('string')).toContain(
      'wordprocessingml.document.main+xml',
    )
  })

  it('removes prefixed Override and Relationship elements', async () => {
    const saved = await normalized(await withPrefixedPackaging(await macroZip()))
    expect(saved.file('word/vbaProject.bin')).toBeNull()
    expect(await saved.file('[Content_Types].xml')!.async('string')).not.toContain('vbaProject')
    expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
  })

  it('handles spaced, reordered, single-quoted, and paired declarations', async () => {
    const zip = await macroZip()
    const types = await zip.file('[Content_Types].xml')!.async('string')
    zip.file(
      '[Content_Types].xml',
      types.replace(
        /<Override\b[^>]*vbaProject[^>]*\/>/,
        `<Override ContentType = 'application/vnd.ms-office.vbaProject' ` +
          `PartName = "/word/vbaProject.bin">stale</Override>`,
      ),
    )
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    zip.file(
      'word/_rels/document.xml.rels',
      rels.replace(
        /<Relationship\b[^>]*vbaProject[^>]*\/>/,
        `<Relationship Target = 'vbaProject.bin' ` +
          `Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" ` +
          `Id="rIdVbaProject"></Relationship>`,
      ),
    )
    const saved = await normalized(zip)
    expect(saved.file('word/vbaProject.bin')).toBeNull()
    const savedTypes = await saved.file('[Content_Types].xml')!.async('string')
    expect(savedTypes).not.toContain('vbaProject')
    expect(savedTypes).not.toContain('stale')
    expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
  })

  it('strips signed-project and vbaData sidecars with their declarations', async () => {
    const zip = await macroZip()
    zip.file('word/vbaProjectSignature.bin', Buffer.from('signed-project sentinel'))
    zip.file('word/vbaData.xml', '<vbaData/>')
    zip.file(
      'word/_rels/vbaProject.bin.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rSig" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProjectSignature" Target="vbaProjectSignature.bin"/>' +
        '</Relationships>',
    )
    const types = await zip.file('[Content_Types].xml')!.async('string')
    zip.file(
      '[Content_Types].xml',
      types.replace(
        '</Types>',
        '<Override PartName="/word/vbaProjectSignature.bin" ContentType="application/vnd.ms-office.vbaProjectSignature"/>' +
          '<Override PartName="/word/vbaData.xml" ContentType="application/vnd.ms-word.vbaData+xml"/>' +
          '<Override PartName="/word/_rels/vbaProject.bin.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '</Types>',
      ),
    )
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    zip.file(
      'word/_rels/document.xml.rels',
      rels.replace(
        '</Relationships>',
        '<Relationship Id="rSigDoc" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProjectSignature" Target="vbaProjectSignature.bin"/>' +
          '</Relationships>',
      ),
    )
    const saved = await normalized(zip)
    for (const gone of [
      'word/vbaProject.bin',
      'word/vbaProjectSignature.bin',
      'word/vbaData.xml',
      'word/_rels/vbaProject.bin.rels',
    ]) {
      expect(saved.file(gone), gone).toBeNull()
    }
    const savedTypes = await saved.file('[Content_Types].xml')!.async('string')
    expect(savedTypes).not.toContain('vbaProject')
    expect(savedTypes).not.toContain('vbaData')
    expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
  })

  it('cleans VBA rels kept next to a relocated main part', async () => {
    const zip = await macroZip()
    for (const [from, to] of [
      ['word/document.xml', 'word/trial.xml'],
      ['word/_rels/document.xml.rels', 'word/_rels/trial.xml.rels'],
    ] as const) {
      zip.file(to, await zip.file(from)!.async('nodebuffer'))
      zip.remove(from)
    }
    for (const name of ['_rels/.rels', '[Content_Types].xml']) {
      zip.file(
        name,
        (await zip.file(name)!.async('string')).replaceAll('word/document.xml', 'word/trial.xml'),
      )
    }
    const saved = await normalized(zip)
    expect(saved.file('word/vbaProject.bin')).toBeNull()
    expect(await saved.file('[Content_Types].xml')!.async('string')).not.toContain('vbaProject')
    expect(await saved.file('word/_rels/trial.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
  })

  it('keeps the VBA graph when the target stays macro-enabled', async () => {
    const zip = await macroZip()
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(await normalizeDocxFormat(bytes, 'copy.docm')).toBe(bytes)
  })
})
