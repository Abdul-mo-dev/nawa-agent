import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { findLibreOffice, importLegacyOffice, MAX_LEGACY_IMPORT_BYTES } from '../src/legacy-office'

const converter = await findLibreOffice()
const roots: string[] = []
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'nawa-legacy-test-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('legacy Office import failures', () => {
  it.each(['odt', 'odp'])(
    'rejects encrypted or mislabeled .%s packages before conversion',
    async (extension) => {
      const root = await temporaryDirectory()
      const source = join(root, `locked.${extension}`)
      const zip = new JSZip()
      const mime = extension === 'odt' ? 'text' : 'presentation'
      zip.file('mimetype', `application/vnd.oasis.opendocument.${mime}`)
      zip.file('content.xml', 'encrypted payload')
      zip.file(
        'META-INF/manifest.xml',
        '<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry><m:encryption-data/></m:file-entry></m:manifest>',
      )
      await writeFile(source, await zip.generateAsync({ type: 'uint8array' }))
      const original = await readFile(source)
      await expect(
        importLegacyOffice(source, { executablePath: process.execPath, tempRoot: root }),
      ).rejects.toMatchObject({ code: 'encrypted' })
      expect(await readFile(source)).toEqual(original)
      zip.file('mimetype', 'application/zip')
      await writeFile(source, await zip.generateAsync({ type: 'uint8array' }))
      await expect(
        importLegacyOffice(source, { executablePath: process.execPath, tempRoot: root }),
      ).rejects.toMatchObject({ code: 'failed' })
      expect(await readdir(root)).toEqual([`locked.${extension}`])
    },
  )
  it('reports a missing explicit converter without falling back to another installation', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'source.doc')
    await writeFile(source, 'unchanged')
    const missing = join(root, 'missing-soffice')
    expect(await findLibreOffice(missing)).toBeNull()
    await expect(
      importLegacyOffice(source, { executablePath: missing, tempRoot: root }),
    ).rejects.toMatchObject({ code: 'missing' })
    expect(await readdir(root)).toEqual(['source.doc'])
    expect(await readFile(source, 'utf8')).toBe('unchanged')
  })

  it('rejects oversized sources before looking for a converter', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'big.doc')
    const file = await open(source, 'w')
    try {
      await file.truncate(MAX_LEGACY_IMPORT_BYTES + 1)
    } finally {
      await file.close()
    }
    await expect(
      importLegacyOffice(source, { executablePath: join(root, 'missing'), tempRoot: root }),
    ).rejects.toMatchObject({ code: 'tooLarge' })
    expect(await readdir(root)).toEqual(['big.doc'])
  })

  it('rejects corrupt input and cleans the private conversion directory', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'broken.ppt')
    await writeFile(source, 'not a presentation')
    await expect(
      importLegacyOffice(source, { executablePath: process.execPath, tempRoot: root }),
    ).rejects.toMatchObject({ code: 'failed' })
    expect(await readdir(root)).toEqual(['broken.ppt'])
  })

  it('rejects encrypted OOXML mislabeled with a legacy suffix', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'locked.ppt')
    await writeFile(
      source,
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.from('EncryptedPackage', 'utf16le'),
      ]),
    )
    await expect(
      importLegacyOffice(source, { executablePath: process.execPath, tempRoot: root }),
    ).rejects.toMatchObject({ code: 'encrypted' })
    expect(await readdir(root)).toEqual(['locked.ppt'])
  })

  it('handles a failed process without retaining temporary files', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'valid.doc')
    await copyFile(
      resolve(import.meta.dirname, '../../file-parse/tests/fixtures/legacy-sample.doc'),
      source,
    )
    const before = await readFile(source)
    await expect(
      importLegacyOffice(source, { executablePath: process.execPath, tempRoot: root }),
    ).rejects.toMatchObject({ code: 'failed' })
    expect(await readdir(root)).toEqual(['valid.doc'])
    expect(await readFile(source)).toEqual(before)
  })
})

describe.skipIf(!converter)('real LibreOffice legacy imports', () => {
  it('imports genuine RTF text and formatting into DOCX without changing the original', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'sample.rtf')
    const original = Buffer.from(
      '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0 Nawa RTF Import\\par \\b Bold text\\b0  and \\u26085?\\u26412?\\u35486?\\par}',
    )
    await writeFile(source, original)
    const imported = await importLegacyOffice(source, {
      executablePath: converter!,
      tempRoot: root,
    })
    const zip = await JSZip.loadAsync(imported.bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    expect(document).toContain('Nawa RTF Import')
    expect(document).toContain('Bold text')
    expect(document).toContain('日本語')
    expect(document).toMatch(/<w:b(?:\s|\/|>)/)
    expect(imported.suggestSaveAs).toBe(join(root, 'sample.docx'))
    expect(await readFile(source)).toEqual(original)
  }, 120000)
  it.each(['odt', 'odp'])(
    'imports real .%s into modern bytes and preserves the source and an existing sibling',
    async (extension) => {
      const root = await temporaryDirectory()
      const target = extension === 'odt' ? 'docx' : 'pptx'
      const source = join(root, `source.${extension.toUpperCase()}`)
      const fixture = extension === 'odt' ? 'document-sample.odt' : 'presentation-sample.odp'
      await copyFile(
        resolve(import.meta.dirname, '../../../test-files/opendocument', fixture),
        source,
      )
      const original = await readFile(source)
      const sibling = join(root, `source.${target}`)
      await writeFile(sibling, 'existing sibling')
      const result = await importLegacyOffice(source, {
        executablePath: converter!,
        tempRoot: root,
      })
      const zip = await JSZip.loadAsync(result.bytes)
      const part = target === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml'
      expect(await zip.file(part)!.async('string')).toContain('Nawa Legacy Office Test')
      expect(result.extension).toBe(extension)
      expect(result.suggestSaveAs).toBe(sibling)
      expect(await readFile(source)).toEqual(original)
      expect(await readFile(sibling, 'utf8')).toBe('existing sibling')
      expect((await readdir(root)).sort()).toEqual(
        [`source.${extension.toUpperCase()}`, `source.${target}`].sort(),
      )
    },
    120_000,
  )
  it('retains embedded chart parts while importing a legacy presentation', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'chart.ppt')
    await copyFile(
      resolve(import.meta.dirname, '../../../test-files/legacy-office/presentation-sample.ppt'),
      source,
    )
    const original = await readFile(source)
    const imported = await importLegacyOffice(source, {
      executablePath: converter!,
      tempRoot: root,
    })
    const archive = await JSZip.loadAsync(imported.bytes)
    expect(archive.file('ppt/charts/chart1.xml')).not.toBeNull()
    expect(await archive.file('ppt/slides/slide2.xml')!.async('string')).toContain('<c:chart')
    expect(await readFile(source)).toEqual(original)
  }, 120_000)
  it('terminates a timed-out conversion and removes its private files', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'timeout.doc')
    await copyFile(
      resolve(import.meta.dirname, '../../file-parse/tests/fixtures/legacy-sample.doc'),
      source,
    )
    const before = await readFile(source)
    await expect(
      importLegacyOffice(source, { executablePath: converter!, tempRoot: root, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'failed' })
    expect(await readdir(root)).toEqual(['timeout.doc'])
    expect(await readFile(source)).toEqual(before)
  }, 20_000)
  it.each(['doc', 'dot', 'ppt', 'pps', 'pot'])(
    'converts .%s without changing the source or an existing sibling',
    async (extension) => {
      const root = await temporaryDirectory()
      const target = extension === 'doc' || extension === 'dot' ? 'docx' : 'pptx'
      const source = join(root, `old report.${extension.toUpperCase()}`)
      const fixture =
        extension === 'doc' || extension === 'ppt'
          ? resolve(
              import.meta.dirname,
              '../../file-parse/tests/fixtures',
              `legacy-sample.${extension}`,
            )
          : resolve(import.meta.dirname, 'fixtures/legacy-office', `legacy-sample.${extension}`)
      await copyFile(fixture, source)
      const before = await readFile(source)
      const sibling = join(root, `old report.${target}`)
      await writeFile(sibling, 'existing file must survive')
      const imported = await importLegacyOffice(source, {
        executablePath: converter!,
        tempRoot: root,
      })
      const zip = await JSZip.loadAsync(imported.bytes)
      const part = target === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml'
      expect(await zip.file(part)!.async('string')).toContain(
        target === 'docx' ? 'Legacy DOC body text' : 'Legacy PPT title',
      )
      expect(imported.suggestSaveAs).toBe(sibling)
      expect(imported.extension).toBe(extension)
      expect(await readFile(source)).toEqual(before)
      expect(await readFile(sibling, 'utf8')).toBe('existing file must survive')
      expect((await readdir(root)).sort()).toEqual(
        [`old report.${extension.toUpperCase()}`, `old report.${target}`].sort(),
      )
    },
    120_000,
  )

  it('isolates concurrent conversions with the same basename', async () => {
    const root = await temporaryDirectory()
    await Promise.all(['left', 'right'].map((name) => mkdir(join(root, name))))
    const sources = ['left', 'right'].map((name) => join(root, name, 'same.doc'))
    await Promise.all(
      sources.map((source) =>
        copyFile(
          resolve(import.meta.dirname, '../../file-parse/tests/fixtures/legacy-sample.doc'),
          source,
        ),
      ),
    )
    const results = await Promise.all(
      sources.map((source) =>
        importLegacyOffice(source, { executablePath: converter!, tempRoot: root }),
      ),
    )
    expect(results.every((result) => result.bytes.length > 0)).toBe(true)
    expect((await readdir(root)).sort()).toEqual(['left', 'right'])
  }, 120_000)
})
