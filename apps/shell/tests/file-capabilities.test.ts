import { expect, it } from 'vitest'
import {
  fileCapabilities,
  NATIVE_FILE_EXTENSIONS,
  ANALYTICAL_FILE_EXTENSIONS,
} from '../src/shared/file-capabilities'
import {
  actionCheckpoints,
  actionClaimCorrection,
  isResumeRequest,
} from '../src/renderer/src/directory-actions/evidence'
import type { HistoryMessage } from '../src/shared/conversation-api'

it('reports different extraction, native and analytical coverage precisely', () => {
  expect(fileCapabilities('C:\\test\\file.XLSM')).toMatchObject({
    search: true,
    analysis: true,
    inspection: false,
    editing: false,
  })
  expect(fileCapabilities('/files/legacy.xls')).toMatchObject({
    search: false,
    analysis: false,
    inspection: false,
    editing: false,
    legacy: true,
  })
  expect(fileCapabilities('/files/scan.png')).toMatchObject({
    search: true,
    analysis: false,
    inspection: false,
    ocr: true,
  })
  expect(fileCapabilities('/files/notes.txt')).toMatchObject({ search: true, inspection: false })
  expect(fileCapabilities('/files/report.docx')).toMatchObject({
    search: true,
    editing: true,
    inspection: true,
    analysis: false,
  })
  for (const extension of NATIVE_FILE_EXTENSIONS)
    expect(fileCapabilities('file' + extension).inspection).toBe(true)
  for (const extension of ANALYTICAL_FILE_EXTENSIONS)
    expect(fileCapabilities('file' + extension).analysis).toBe(true)
})

it('restores only structured action outcomes for the same selection, even after interruption', () => {
  const make = (
    scope: string,
    outcome: 'failed' | 'cancelled' | 'completed',
    action = true,
  ): HistoryMessage => ({
    id: scope + outcome,
    contextKey: scope,
    createdAt: 1,
    role: 'assistant',
    text: 'I saved it.',
    request: {
      id: 'request',
      phase: 'receipt',
      outcome,
      ...(action ? { action: { operation: 'update', path: '/selected/report.docx' } } : {}),
    },
  })
  const messages = [
    make('selected', 'cancelled'),
    make('selected', 'failed'),
    make('other', 'completed'),
    make('selected', 'completed', false),
  ]
  expect(actionCheckpoints(messages, 'selected')).toEqual([
    { at: 1, operation: 'update', path: '/selected/report.docx' },
    { at: 1, operation: 'update', path: '/selected/report.docx' },
  ])
})

it.each(['تم تحديث report.docx.', 'report.docx を更新しました。', '已经更新 report.docx。'])(
  'requires a commit receipt for a translated save claim: %s',
  (text) => {
    expect(actionClaimCorrection(text, [], ['/selected/report.docx'])).toContain('No file commit')
    expect(
      actionClaimCorrection(
        text,
        [{ path: '/selected/report.docx', operation: 'update' }],
        ['/selected/report.docx'],
      ),
    ).toBeNull()
    expect(
      actionClaimCorrection(
        text,
        [{ path: '/selected/other.docx', operation: 'update' }],
        ['/selected/report.docx'],
      ),
    ).toContain('No file commit')
  },
)

it.each(['resume', 'continue.', 'تابع', 'استأنف العمل', '続けて', '继续'])(
  'recognizes explicit continuation %s',
  (text) => expect(isResumeRequest(text)).toBe(true),
)
it.each(['update report.docx again', 'continue with a new chart', 'تابع مع تعديل جديد'])(
  'allows a new instruction %s',
  (text) => expect(isResumeRequest(text)).toBe(false),
)
