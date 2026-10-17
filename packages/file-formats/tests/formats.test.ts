import { describe, expect, it } from 'vitest'
import {
  EDITOR_SAVE_EXTENSIONS,
  editorSavePath,
  officeContentTypesForPath,
  modernOfficePath,
} from '../src'

describe('Office Save As format metadata', () => {
  it.each([
    ['docx', 'dotx', 'word/document.xml', 'wordprocessingml.document', 'wordprocessingml.template'],
    ['xlsx', 'xltx', 'xl/workbook.xml', 'spreadsheetml.sheet', 'spreadsheetml.template'],
    [
      'pptx',
      'ppsx',
      'ppt/presentation.xml',
      'presentationml.presentation',
      'presentationml.slideshow',
    ],
    [
      'pptx',
      'potx',
      'ppt/presentation.xml',
      'presentationml.presentation',
      'presentationml.template',
    ],
  ])(
    'converts %s to %s and back without changing unrelated declarations',
    (from, to, part, regular, variant) => {
      const prefix = 'application/vnd.openxmlformats-officedocument.'
      const other = '<Override PartName="/custom/item.xml" ContentType="application/xml"/>'
      const xml = `<Types><Override PartName="/${part}" ContentType="${prefix}${regular}.main+xml"/>${other}</Types>`
      const converted = officeContentTypesForPath(xml, `/files/template.${to.toUpperCase()}`)
      expect(converted).toContain(`${prefix}${variant}.main+xml`)
      expect(converted).toContain(other)
      expect(officeContentTypesForPath(converted, `/files/document.${from}`)).toBe(xml)
      expect(officeContentTypesForPath(xml, `/files/document.${from}`)).toBe(xml)
    },
  )

  it('handles prefixed elements, single quotes, and reordered attributes', () => {
    const xml =
      "<ct:Types><ct:Override ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' PartName = '/word/document.xml'/></ct:Types>"
    expect(officeContentTypesForPath(xml, 'template.dotx')).toContain(
      'wordprocessingml.template.main+xml',
    )
  })

  it.each([
    ['word/trial.xml', 'dotx', 'wordprocessingml.template.main+xml'],
    ['word/trial.xml', 'docm', 'ms-word.document.macroEnabled.main+xml'],
    ['word/trial.xml', 'dotm', 'ms-word.template.macroEnabled.main+xml'],
    ['xl/trial.xml', 'xltm', 'ms-excel.template.macroEnabled.main+xml'],
    ['xl/trial.xml', 'xlsx', 'spreadsheetml.sheet.main+xml'],
    ['ppt/trial.xml', 'ppsx', 'presentationml.slideshow.main+xml'],
    ['ppt/trial.xml', 'potm', 'ms-powerpoint.template.macroEnabled.main+xml'],
  ])('rewrites a relocated main part %s when saving as %s', (relocated, ext, fragment) => {
    const xml =
      `<Types><Override PartName="/${relocated}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      '<Override PartName="/custom/item.xml" ContentType="application/xml"/></Types>'
    const converted = officeContentTypesForPath(xml, `copy.${ext}`)
    expect(converted).toContain(`PartName="/${relocated}"`)
    expect(converted).toContain(fragment)
    expect(converted).toContain('<Override PartName="/custom/item.xml"')
  })

  it('converts a relocated macro-enabled main part down to its macro-free type', () => {
    const xml =
      '<Types><Override PartName="/word/trial.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>'
    expect(officeContentTypesForPath(xml, 'copy.docx')).toContain(
      'wordprocessingml.document.main+xml',
    )
    expect(officeContentTypesForPath(xml, 'copy.docx')).toContain('PartName="/word/trial.xml"')
  })

  it('still refuses a relocated package whose main type is unknown', () => {
    const xml =
      '<Types><Override PartName="/word/trial.xml" ContentType="application/xml"/></Types>'
    expect(() => officeContentTypesForPath(xml, 'template.dotx')).toThrow('word/document.xml')
  })

  it('refuses packages without a declaration for the requested main part', () => {
    expect(() => officeContentTypesForPath('<Types/>', 'template.dotx')).toThrow(
      'word/document.xml',
    )
  })

  it('leaves the existing macro-enabled save format alone', () => {
    const xml =
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'
    expect(officeContentTypesForPath(xml, 'macros.xlsm')).toBe(xml)
  })

  it('preserves a Word macro-enabled document main part and its VBA declaration', () => {
    const vba =
      '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>'
    const regular = `<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${vba}</Types>`
    const converted = officeContentTypesForPath(regular, 'source.docm')
    expect(converted).toContain('application/vnd.ms-word.document.macroEnabled.main+xml')
    expect(converted).toContain(vba)
    expect(officeContentTypesForPath(converted, 'edited.docm')).toBe(converted)
  })

  it('switches a macro-enabled template and workbook without dropping VBA declarations', () => {
    const vba =
      '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>'
    const workbook = `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>${vba}</Types>`
    const template = officeContentTypesForPath(workbook, 'template.xltm')
    expect(template).toContain('application/vnd.ms-excel.template.macroEnabled.main+xml')
    expect(template).toContain(vba)
    expect(officeContentTypesForPath(template, 'edited.xlsm')).toBe(workbook)
    expect(officeContentTypesForPath(template, 'template.xltm')).toBe(template)
  })

  it('leaves unrelated output extensions alone', () => {
    expect(officeContentTypesForPath('<Types/>', 'file.constructor')).toBe('<Types/>')
    expect(officeContentTypesForPath('<Types/>', 'file.txt')).toBe('<Types/>')
  })
})

describe('editorSavePath', () => {
  it('preserves the selected template format and appends a missing extension', () => {
    expect(editorSavePath('C:/files/TEMPLATE.DOTX', EDITOR_SAVE_EXTENSIONS.docs, 'docx')).toBe(
      'C:/files/TEMPLATE.DOTX',
    )
    expect(editorSavePath('C:/files/template', EDITOR_SAVE_EXTENSIONS.docs, 'dotx')).toBe(
      'C:/files/template.dotx',
    )
    expect(() =>
      editorSavePath('C:/files/output.pdf', EDITOR_SAVE_EXTENSIONS.docs, 'docx'),
    ).toThrow('Save as')
  })

  it.each(['doc', 'dot', 'ppt', 'pps', 'pot'])('never writes modern bytes to .%s', (extension) => {
    const family = extension === 'doc' || extension === 'dot' ? 'docs' : 'slides'
    const target = family === 'docs' ? 'docx' : 'pptx'
    expect(modernOfficePath(`C:/files/with space.${extension.toUpperCase()}`)).toBe(
      `C:/files/with space.${target}`,
    )
    expect(() =>
      editorSavePath(`C:/files/output.${extension}`, EDITOR_SAVE_EXTENSIONS[family], target),
    ).toThrow('Save as')
  })
})
