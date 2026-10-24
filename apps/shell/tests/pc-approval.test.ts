import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: () => '/app', getLocale: () => 'ar-SA', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  assertLicense: vi.fn(),
  helper: vi.fn(() => '/resources/licensing/nawa-license.exe'),
  parse: vi.fn((value: unknown) => {
    if (!value) throw new Error('Missing approval policy')
    return value
  }),
  read: vi.fn(),
  exec: vi.fn(),
}))
vi.mock('electron', () => ({ app: mocks.app, dialog: mocks.dialog }))
vi.mock('node:fs', () => ({ readFileSync: mocks.read }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec }))
vi.mock('@genoffice/electron-utils/offline-license', () => ({
  assertOfflineLicense: mocks.assertLicense,
  offlineLicenseHelper: mocks.helper,
  parseOfflineLicensePolicy: mocks.parse,
}))
import { requirePcApproval } from '../src/main/offline-license'

describe.skipIf(process.platform !== 'win32')('packaged Windows startup approval', () => {
  const policy = { schema: 1, authorityId: 'a'.repeat(24), helperSha256: 'b'.repeat(64) }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.app.isPackaged = true
    mocks.read.mockReturnValue(JSON.stringify({ nawaOfflineLicense: policy }))
    mocks.assertLicense.mockReset()
    mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
    vi.stubEnv('GENOFFICE_LANG', '')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  it('allows development builds without invoking an activation helper', async () => {
    mocks.app.isPackaged = false
    expect(await requirePcApproval(false)).toBe(true)
    expect(mocks.assertLicense).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('starts an approved packaged app without an approval dialog', async () => {
    expect(await requirePcApproval(false)).toBe(true)
    expect(mocks.assertLicense).toHaveBeenCalledTimes(1)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('shows an interactive, visible activation window and checks the imported license again', async () => {
    mocks.assertLicense.mockImplementationOnce(() => {
      throw new Error('No approval')
    })
    expect(await requirePcApproval(false)).toBe(true)
    expect(mocks.exec).toHaveBeenCalledWith(
      '/resources/licensing/nawa-license.exe',
      ['activate', '--lang', 'ar'],
      expect.objectContaining({ windowsHide: false }),
      expect.any(Function),
    )
    expect(mocks.assertLicense).toHaveBeenCalledTimes(2)
  })
  it('cancelling activation stops startup', async () => {
    mocks.assertLicense.mockImplementationOnce(() => {
      throw new Error('No approval')
    })
    mocks.exec.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('Cancelled')),
    )
    expect(await requirePcApproval(false)).toBe(false)
    expect(mocks.app.exit).toHaveBeenCalledWith(3)
  })
  it('headless calls fail with structured output and never show a dialog', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mocks.assertLicense.mockImplementation(() => {
      throw new Error('License expired')
    })
    expect(await requirePcApproval(true)).toBe(false)
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"error":"license_required"'))
    expect(mocks.app.exit).toHaveBeenCalledWith(4)
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.dialog.showErrorBox).not.toHaveBeenCalled()
  })
  it('a missing packaged policy fails closed', async () => {
    mocks.read.mockReturnValue('{}')
    expect(await requirePcApproval(false)).toBe(false)
    expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith(
      'Nawa — PC approval',
      'Missing approval policy',
    )
    expect(mocks.app.exit).toHaveBeenCalledWith(4)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
