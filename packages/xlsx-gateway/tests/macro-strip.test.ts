import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  isMacroPartName,
  macroPartRelsName,
  removeMacroOverrides,
  removeMacroRelationships,
  saveWorkbookViaSidecar,
  type ArchiveClient,
} from '../src/gateway/xlsx-package-io'

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKSHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
</worksheet>`

function contentTypes(extraOverrides = '', _extraRels = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>` +
    `<Override PartName="/xl/vbaProjectSignature.bin" ContentType="application/vnd.ms-office.vbaProjectSignature"/>` +
    extraOverrides +
    `</Types>`
  )
}

function workbookRels(extra = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>` +
    extra +
    `</Relationships>`
  )
}

async function fixture(mutate?: (zip: JSZip) => Promise<void>): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes())
  zip.file('_rels/.rels', PACKAGE_RELS)
  zip.file('xl/workbook.xml', WORKBOOK)
  zip.file('xl/_rels/workbook.xml.rels', workbookRels())
  zip.file('xl/worksheets/sheet1.xml', WORKSHEET)
  zip.file('xl/vbaProject.bin', Buffer.from('vba sentinel'))
  zip.file('xl/vbaProjectSignature.bin', Buffer.from('vba signature sentinel'))
  zip.file(
    'xl/_rels/vbaProject.bin.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rSig" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProjectSignature" Target="vbaProjectSignature.bin"/>` +
      `</Relationships>`,
  )
  // The orphan rels part carries its own declaration, as a signer would write.
  zip.file(
    '[Content_Types].xml',
    (await zip.file('[Content_Types].xml')!.async('string')).replace(
      '</Types>',
      `<Override PartName="/xl/_rels/vbaProject.bin.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
    ),
  )
  if (mutate) await mutate(zip)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** In-memory sidecar: applies the plan with JSZip and reports CRC manifests. */
function stubClient(): ArchiveClient {
  const load = async (path: string) => JSZip.loadAsync(await readFile(path))
  const manifestOf = async (path: string) => {
    const zip = await load(path)
    const entries = []
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) continue
      const data = await file.async('nodebuffer')
      entries.push({
        name,
        crc32: crc32(data),
        compressedSize: data.length,
        uncompressedSize: data.length,
      })
    }
    return entries
  }
  return {
    archiveManifest: async (path: string) => ({ entries: await manifestOf(path) }),
    readEntries: async ({ path, entries, outputDir }) => {
      const zip = await load(path)
      const extracted = []
      for (const [index, name] of entries.entries()) {
        const file = zip.file(name)
        if (!file) continue
        const outPath = join(outputDir, `entry-${index}.bin`)
        await writeFile(outPath, await file.async('nodebuffer'))
        extracted.push({ name, path: outPath })
      }
      return { entries: extracted }
    },
    scanEntries: async ({ path, entries, needle }) => {
      const zip = await load(path)
      const matches = []
      for (const name of entries) {
        const file = zip.file(name)
        if (file && (await file.async('string')).includes(needle)) matches.push(name)
      }
      return { matches }
    },
    saveArchive: async ({ sourcePath, targetPath, replacements, removals, additions }) => {
      const zip = await load(sourcePath)
      for (const name of removals) zip.remove(name)
      for (const { name, contentPath } of [...replacements, ...additions]) {
        zip.file(name, await readFile(contentPath))
      }
      await writeFile(targetPath, await zip.generateAsync({ type: 'nodebuffer' }))
      return {
        beforeEntries: await manifestOf(sourcePath),
        afterEntries: await manifestOf(targetPath),
      }
    },
  }
}

async function saveAsXlsx(source: Buffer, targetName = 'copy.xlsx'): Promise<JSZip> {
  const workDir = await mkdtemp(join(tmpdir(), 'xlsx-macro-strip-'))
  try {
    const sourcePath = join(workDir, 'source.xlsm')
    const targetPath = join(workDir, targetName)
    await writeFile(sourcePath, source)
    await saveWorkbookViaSidecar({ client: stubClient(), sourcePath, targetPath, edits: [] })
    return JSZip.loadAsync(await readFile(targetPath))
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

describe('macro-free Save As strips the VBA graph', () => {
  it('drops the project binaries, their Overrides, and their workbook relationships', async () => {
    const saved = await saveAsXlsx(await fixture())
    expect(saved.file('xl/vbaProject.bin')).toBeNull()
    expect(saved.file('xl/vbaProjectSignature.bin')).toBeNull()
    expect(saved.file('xl/_rels/vbaProject.bin.rels')).toBeNull()
    const types = await saved.file('[Content_Types].xml')!.async('string')
    expect(types).not.toContain('vbaProject')
    expect(types).toContain('spreadsheetml.sheet.main+xml')
    const rels = await saved.file('xl/_rels/workbook.xml.rels')!.async('string')
    expect(rels).not.toContain('vbaProject')
    expect(rels).toContain('worksheets/sheet1.xml')
  })

  it('removes prefixed, spaced, reordered, and paired declarations', async () => {
    const saved = await saveAsXlsx(
      await fixture(async (zip) => {
        const xml = await zip.file('[Content_Types].xml')!.async('string')
        zip.file(
          '[Content_Types].xml',
          xml
            .replace('xmlns=', 'xmlns:ct=')
            .replace(/<(\/?)(Types|Override|Default)\b/g, '<$1ct:$2')
            .replace(
              /<ct:Override\b[^>]*vbaProjectSignature[^>]*\/>/,
              `<ct:Override ContentType = 'application/vnd.ms-office.vbaProjectSignature' ` +
                `PartName = "/xl/vbaProjectSignature.bin">stale</ct:Override>`,
            ),
        )
        const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
        zip.file(
          'xl/_rels/workbook.xml.rels',
          rels
            .replace('xmlns=', 'xmlns:r=')
            .replace(/<(\/?)(Relationships|Relationship)\b/g, '<$1r:$2')
            .replace(
              /<r:Relationship\b[^>]*vbaProject\.bin[^>]*\/>/,
              `<r:Relationship Target = 'vbaProject.bin' ` +
                `Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" ` +
                `Id="rIdVba"></r:Relationship>`,
            ),
        )
      }),
    )
    expect(saved.file('xl/vbaProject.bin')).toBeNull()
    expect(saved.file('xl/vbaProjectSignature.bin')).toBeNull()
    const types = await saved.file('[Content_Types].xml')!.async('string')
    expect(types).not.toContain('vbaProject')
    expect(types).not.toContain('stale')
    expect(await saved.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toContain(
      'vbaProject',
    )
  })
})

describe('VBA declaration helpers', () => {
  it('recognizes the owned VBA graph and its rels companions', () => {
    expect(isMacroPartName('xl/vbaProject.bin')).toBe(true)
    expect(isMacroPartName('/xl/vbaProjectSignature.bin')).toBe(true)
    expect(isMacroPartName('word/vbaData.xml')).toBe(true)
    expect(isMacroPartName('xl/worksheets/sheet1.xml')).toBe(false)
    expect(macroPartRelsName('xl/vbaProject.bin')).toBe('xl/_rels/vbaProject.bin.rels')
    expect(macroPartRelsName('vbaProject.bin')).toBe('_rels/vbaProject.bin.rels')
  })

  it('strips prefixed and paired Overrides but keeps unrelated ones', () => {
    const other = '<Override PartName="/xl/workbook.xml" ContentType="application/xml"/>'
    const xml =
      `<Types><ct:Override PartName = "/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>` +
      `<Override PartName="/xl/vbaProjectSignature.bin" ContentType="application/vnd.ms-office.vbaProjectSignature">x</Override>` +
      `${other}</Types>`
    const stripped = removeMacroOverrides(xml)
    expect(stripped).not.toContain('vbaProject')
    expect(stripped).toContain(other)
  })

  it('strips Relationships pointing at VBA parts in any spelling', () => {
    const other =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    const xml =
      `<Relationships><r:Relationship Target='vbaProject.bin' Id="r" Type="t"/>` +
      `<Relationship Id="s" Type="t" Target = "xl/vbaProjectSignature.bin"></Relationship>` +
      `${other}</Relationships>`
    const stripped = removeMacroRelationships(xml)
    expect(stripped).not.toContain('vbaProject')
    expect(stripped).toContain(other)
  })
})
