import { expect, it } from 'vitest'
import {
  EDITOR_EXTENSIONS,
  EDITOR_FILE_EXTENSIONS,
  PREVIEW_FILE_EXTENSIONS,
} from '@genoffice/file-formats'
import { partitionDropPayload } from '@genoffice/electron-utils/drop-open'
import { appForPath } from '../src/main/app-routing'
import { collectLaunchPaths } from '../src/main/launch-paths'
import { isSupportedTreeFile } from '../src/main/folder-tree'
import { matchesExtFamily } from '../src/main/recent-files'

it('opens the same formats from dialogs, OS launches, drops, and folder trees', () => {
  for (const [app, extensions] of Object.entries(EDITOR_EXTENSIONS)) {
    for (const ext of extensions) {
      const path = `C:/files/example.${ext.toUpperCase()}`
      expect(appForPath(path)).toBe(app)
      expect(collectLaunchPaths(['Nawa.exe', path], undefined, () => true)).toEqual([path])
      expect(partitionDropPayload([path]).supported).toEqual([path])
      expect(isSupportedTreeFile(path)).toBe(true)
    }
  }
  expect(new Set(EDITOR_FILE_EXTENSIONS).size).toBe(EDITOR_FILE_EXTENSIONS.length)
  for (const ext of PREVIEW_FILE_EXTENSIONS) {
    const path = `C:/files/preview.${ext.toUpperCase()}`
    expect(collectLaunchPaths(['Nawa.exe', path], undefined, () => true)).toEqual([path])
    expect(partitionDropPayload([path]).supported).toEqual([path])
    expect(isSupportedTreeFile(path)).toBe(true)
  }
})

it('includes templates, shows, and source files in their sidebar family', () => {
  for (const [ext, family] of [
    ['dotx', 'docx'],
    ['odt', 'docx'],
    ['odp', 'pptx'],
    ['docm', 'docx'],
    ['xltx', 'xlsx'],
    ['xltm', 'xlsx'],
    ['ods', 'xlsx'],
    ['xlsb', 'xlsx'],
    ['ppsx', 'pptx'],
    ['potx', 'pptx'],
    ['yaml', 'md'],
    ['py', 'md'],
  ]) {
    expect(matchesExtFamily(ext, family)).toBe(true)
  }
  expect(appForPath('C:/files/example.docm')).toBe('docs')
  expect(appForPath('C:/files/example.odt')).toBe('docs')
  expect(appForPath('C:/files/example.odp')).toBe('slides')
})
