import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  configureDirectoryStage,
  registerDirectoryStage,
  revokeDirectoryStage,
} from '../../../../packages/electron-utils/src/directory-stage'

const state = vi.hoisted(() => ({
  contents: new Map<number, object>(),
  sessions: new Map<number, object>(),
  save: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => state.contents.get(id) } }))
vi.mock('../../../slides/src/main/slides-main', () => ({
  applySessionTxn: vi.fn(),
  saveSessionDeckTo: state.save,
}))
vi.mock('../../../slides/src/main/session-state', () => ({
  sessions: state.sessions,
  attachedIds: () => [],
}))
import { createSlidesControl } from '../../src/main/mcp/slides-bridge'

beforeEach(() => {
  state.contents.clear()
  state.sessions.clear()
  state.save.mockClear()
})
const control = () => createSlidesControl({ openBlankTab: () => 1 })
function stage(extension: string, mode: 'read' | 'edit' = 'edit') {
  const contents = { id: 1, isDestroyed: () => false }
  const session = {}
  const path = resolve(`.task/stage/output.${extension}`)
  state.contents.set(1, contents)
  state.sessions.set(1, session)
  registerDirectoryStage(contents, path)
  configureDirectoryStage(contents, mode)
  return { contents, session, path }
}

it.each(['pptm', 'ppsm', 'potm'])(
  'saves the approved .%s stage through the private bridge',
  async (extension) => {
    const { session, path } = stage(extension)
    await expect(control().saveStagedMacro(1, path)).resolves.toEqual({ path })
    expect(state.save).toHaveBeenCalledWith(session, path)
    // The public agent save contract remains restricted to PPTX outputs.
    await expect(control().saveDeck(1, path, true)).rejects.toThrow('.pptx')
  },
)

it('refuses a path outside the approved stage', async () => {
  stage('pptm')
  await expect(control().saveStagedMacro(1, resolve('.task/elsewhere.pptm'))).rejects.toThrow(
    'staged output',
  )
  expect(state.save).not.toHaveBeenCalled()
})

it('refuses read-only, revoked and unregistered stages', async () => {
  const read = stage('pptm', 'read')
  await expect(control().saveStagedMacro(1, read.path)).rejects.toThrow('not approved')
  revokeDirectoryStage(read.contents)
  await expect(control().saveStagedMacro(1, read.path)).rejects.toThrow('revoked')
  state.contents.set(1, { isDestroyed: () => false })
  await expect(control().saveStagedMacro(1, read.path)).rejects.toThrow('approved directory stage')
  expect(state.save).not.toHaveBeenCalled()
})
