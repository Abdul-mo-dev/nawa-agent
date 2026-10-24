import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertOfflineLicense, parseOfflineLicensePolicy } from '../src/offline-license'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
describe('offline PC approval boundary', () => {
  let resources: string
  const policy = {
    schema: 1 as const,
    authorityId: 'a'.repeat(24),
    helperSha256: createHash('sha256').update('helper').digest('hex'),
  }
  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'nawa-license-'))
    mkdirSync(join(resources, 'licensing'))
    writeFileSync(join(resources, 'licensing/nawa-license.exe'), 'helper')
    vi.mocked(execFileSync).mockReset()
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ ok: true, authorityId: policy.authorityId }),
    )
  })
  afterEach(() => rmSync(resources, { recursive: true, force: true }))
  it('requires a complete pinned policy', () => {
    for (const input of [null, {}, { ...policy, schema: 2 }, { ...policy, helperSha256: '' }]) {
      expect(() => parseOfflineLicensePolicy(input)).toThrow(/policy/)
    }
  })
  it('accepts only an approval from the pinned helper and expected authority', () => {
    expect(() => assertOfflineLicense(resources, policy)).not.toThrow()
    expect(execFileSync).toHaveBeenCalledWith(
      join(resources, 'licensing/nawa-license.exe'),
      ['status'],
      expect.objectContaining({ windowsHide: true, timeout: 20000 }),
    )
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ ok: true, authorityId: 'b'.repeat(24) }),
    )
    expect(() => assertOfflineLicense(resources, policy)).toThrow()
  })
  it('rejects a replaced helper before executing any code', () => {
    writeFileSync(join(resources, 'licensing/nawa-license.exe'), 'replaced')
    expect(() => assertOfflineLicense(resources, policy)).toThrow(/changed or damaged/)
    expect(execFileSync).not.toHaveBeenCalled()
  })
  it('rejects missing, failing, or malformed activation responses', () => {
    for (const response of [
      '{}',
      'not json',
      JSON.stringify({ ok: false, authorityId: policy.authorityId }),
    ]) {
      vi.mocked(execFileSync).mockReturnValue(response)
      expect(() => assertOfflineLicense(resources, policy)).toThrow()
    }
    vi.mocked(execFileSync).mockImplementation(() => {
      throw { stdout: JSON.stringify({ message: 'License expired.' }) }
    })
    expect(() => assertOfflineLicense(resources, policy)).toThrow('License expired.')
  })
})
