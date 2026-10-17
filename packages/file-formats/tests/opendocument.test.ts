import { expect, it } from 'vitest'
import {
  EDITOR_SAVE_EXTENSIONS,
  editorSavePath,
  legacyOfficeTarget,
  modernOfficePath,
  officeImportTarget,
  openDocumentManifestEncrypted,
  openDocumentMimeForPath,
} from '../src'

it.each([
  ['odt', 'docx', 'docs', 'text'],
  ['odp', 'pptx', 'slides', 'presentation'],
] as const)(
  'routes .%s imports and refuses saving OOXML under that suffix',
  (ext, target, app, mime) => {
    const path = `C:/files/report.${ext.toUpperCase()}`
    expect(officeImportTarget(path)).toBe(target)
    expect(legacyOfficeTarget(path)).toBeUndefined()
    expect(modernOfficePath(path)).toBe(`C:/files/report.${target}`)
    expect(openDocumentMimeForPath(path)).toBe(`application/vnd.oasis.opendocument.${mime}`)
    expect(() => editorSavePath(path, EDITOR_SAVE_EXTENSIONS[app], target)).toThrow('Save as')
  },
)

it('detects encrypted manifest entries across namespace prefixes without matching comments', () => {
  const ns = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
  expect(
    openDocumentManifestEncrypted(
      `<m:manifest xmlns:m="${ns}"><m:file-entry><m:encryption-data/></m:file-entry></m:manifest>`,
    ),
  ).toBe(true)
  expect(
    openDocumentManifestEncrypted(`<manifest xmlns="${ns}"><encryption-data/></manifest>`),
  ).toBe(true)
  expect(
    openDocumentManifestEncrypted(
      `<m:manifest xmlns:m="${ns}"><!-- <m:encryption-data/> --></m:manifest>`,
    ),
  ).toBe(false)
  expect(() => openDocumentManifestEncrypted('<manifest/>')).toThrow('manifest')
  expect(() =>
    openDocumentManifestEncrypted(
      `<!DOCTYPE manifest [<!ENTITY x "bad">]><manifest xmlns="${ns}"/>`,
    ),
  ).toThrow()
})
