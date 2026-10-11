import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  assertDirectoryStagePicker,
  assertDirectoryStageWrite,
  configureDirectoryStage,
  registerDirectoryStage,
  revokeDirectoryStage,
} from '../src/directory-stage'

const output = join(tmpdir(), 'nawa-directory-stage', 'output.docx')

describe('directory editor native output confinement', () => {
  it('keeps ordinary desktop save and picker behavior', () => {
    const contents = {}
    expect(() => assertDirectoryStagePicker(contents)).not.toThrow()
    expect(() => assertDirectoryStageWrite(contents, '/any/user-picked/path')).not.toThrow()
  })

  it('allows an active edit stage to save only its exact output', () => {
    const contents = {}
    registerDirectoryStage(contents, output)
    configureDirectoryStage(contents, 'edit')
    expect(() => assertDirectoryStageWrite(contents, output)).not.toThrow()
    expect(() => assertDirectoryStageWrite(contents, join(output, '..', 'other.docx'))).toThrow(
      'staged output',
    )
    expect(() => assertDirectoryStageWrite(contents, '../output.docx')).toThrow('staged output')
    expect(() => assertDirectoryStagePicker(contents)).toThrow('directory workflow')
  })

  it('refuses writes before configuration, from read stages and after revocation', () => {
    const pending = {}
    registerDirectoryStage(pending, output)
    expect(() => assertDirectoryStageWrite(pending, output)).toThrow('not approved')
    configureDirectoryStage(pending, 'read')
    expect(() => assertDirectoryStageWrite(pending, output)).toThrow('not approved')
    const active = {}
    registerDirectoryStage(active, output)
    configureDirectoryStage(active, 'edit')
    revokeDirectoryStage(active)
    expect(() => assertDirectoryStageWrite(active, output)).toThrow('revoked')
    expect(() => assertDirectoryStagePicker(active)).toThrow('directory workflow')
  })
})
