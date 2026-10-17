import { describe, expect, it } from 'vitest'
import { officePackageChanges } from '../src'

const typesNs = 'http://schemas.openxmlformats.org/package/2006/content-types'
const relsNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const mainType = 'application/vnd.ms-word.document.macroEnabled.main+xml'
const relationship = (type: string, target: string) =>
  `<r:Relationship Id="id-${target}" Target = '${target}' Type="http://schemas.microsoft.com/office/2006/relationships/${type}"></r:Relationship>`

describe('Office package relationships', () => {
  it('honors overrides over VBA defaults and removes relocated package signatures', () => {
    const metadata = new Map([
      [
        '[Content_Types].xml',
        `<Types xmlns="${typesNs}"><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/word/document.xml" ContentType="${mainType}"/><Override PartName="/word/embedded.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Override PartName="/custom/signature.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/></Types>`,
      ],
      [
        '_rels/.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('officeDocument', 'word/document.xml')}${relationship('digital-signature/origin', 'custom/origin.sigs')}<r:Relationship Id="external" Type="external" TargetMode="External" Target="https://example.test/100%done"/></r:Relationships>`,
      ],
      [
        'custom/_rels/origin.sigs.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('digital-signature/signature', 'signature.xml')}</r:Relationships>`,
      ],
    ])
    const names = [
      ...metadata.keys(),
      'word/document.xml',
      'word/project.bin',
      'word/embedded.bin',
      'custom/origin.sigs',
      'custom/signature.xml',
    ]
    const result = officePackageChanges(names, metadata, 'copy.docx')
    expect(result.removed.has('word/project.bin')).toBe(true)
    expect(result.removed.has('word/embedded.bin')).toBe(false)
    for (const name of [
      'custom/origin.sigs',
      'custom/_rels/origin.sigs.rels',
      'custom/signature.xml',
    ])
      expect(result.removed.has(name), name).toBe(true)
    expect(result.replaced.get('[Content_Types].xml')).toContain('oleObject')
    expect(result.replaced.get('[Content_Types].xml')).not.toContain('vbaProject')
    expect(result.replaced.get('_rels/.rels')).toContain('https://example.test/100%done')
  })

  it('normalizes only the actual main part, retaining unrelated Office declarations', () => {
    const unrelated =
      '<ct:Override PartName="/embedded/other.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>'
    const metadata = new Map([
      [
        '[Content_Types].xml',
        `<ct:Types xmlns:ct="${typesNs}"><ct:Override PartName="/word/trial.xml" ContentType="${mainType}"/>${unrelated}</ct:Types>`,
      ],
      [
        '_rels/.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('officeDocument', 'word/trial.xml')}</r:Relationships>`,
      ],
    ])
    const result = officePackageChanges([...metadata.keys()], metadata, 'copy.dotm')
    expect(result.replaced.get('[Content_Types].xml')).toContain(
      'ms-word.template.macroEnabled.main+xml',
    )
    expect(result.replaced.get('[Content_Types].xml')).toContain(unrelated)
    expect(result.removed.size).toBe(0)
  })

  it('removes renamed VBA payloads and signatures with URI-escaped and entity-escaped targets', () => {
    const metadata = new Map([
      [
        '[Content_Types].xml',
        `<ct:Types xmlns:ct="${typesNs}"><ct:Override PartName="/word/trial.xml" ContentType="${mainType}"/><ct:Override ContentType="application/vnd.ms-office.vbaProject" PartName = '/payload/project%20one.bin'/><ct:Override PartName="/signatures/signed&amp;project.bin" ContentType="application/vnd.ms-office.vbaProjectSignatureAgile"/></ct:Types>`,
      ],
      [
        '_rels/.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('officeDocument', 'word/trial.xml')}${relationship('digital-signature/origin', '_xmlsignatures/origin.sigs')}</r:Relationships>`,
      ],
      [
        'word/_rels/trial.xml.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('vbaProject', '../payload/project%20one.bin')}${relationship('image', 'media/keep.png')}<r:Relationship Id="external" Target="https://example.test/vbaProject.bin" TargetMode="External" Type="external"/></r:Relationships>`,
      ],
      [
        'payload/_rels/project one.bin.rels',
        `<r:Relationships xmlns:r="${relsNs}">${relationship('vbaProjectSignatureAgile', '../signatures/signed&amp;project.bin')}</r:Relationships>`,
      ],
    ])
    const names = [
      ...metadata.keys(),
      'payload/project one.bin',
      'signatures/signed&project.bin',
      'word/trial.xml',
      'word/media/keep.png',
      '_xmlsignatures/origin.sigs',
    ]
    const result = officePackageChanges(names, metadata, 'copy.docx')
    for (const part of [
      'payload/project one.bin',
      'signatures/signed&project.bin',
      'payload/_rels/project one.bin.rels',
      '_xmlsignatures/origin.sigs',
    ])
      expect(result.removed.has(part), part).toBe(true)
    expect(result.replaced.get('[Content_Types].xml')).not.toContain('vbaProject')
    expect(result.replaced.get('word/_rels/trial.xml.rels')).not.toContain('project%20one.bin')
    expect(result.replaced.get('word/_rels/trial.xml.rels')).toContain('media/keep.png')
    expect(result.replaced.get('word/_rels/trial.xml.rels')).toContain(
      'https://example.test/vbaProject.bin',
    )
    expect(result.replaced.get('_rels/.rels')).not.toContain('origin.sigs')
  })

  it('fails closed on missing/ambiguous main relationships and DTDs', () => {
    const metadata = new Map([
      [
        '[Content_Types].xml',
        `<Types><Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`,
      ],
      ['_rels/.rels', '<Relationships/>'],
    ])
    expect(() => officePackageChanges([...metadata.keys()], metadata, 'copy.docx')).toThrow(
      'officeDocument',
    )
    metadata.set('_rels/.rels', '<!DOCTYPE Relationships><Relationships/>')
    expect(() => officePackageChanges([...metadata.keys()], metadata, 'copy.docx')).toThrow('DTD')
  })
})
