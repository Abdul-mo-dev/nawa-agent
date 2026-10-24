import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OfflineLicensePolicy {
  schema: 1
  authorityId: string
  helperSha256: string
}

export function parseOfflineLicensePolicy(value: unknown): OfflineLicensePolicy {
  const policy = value as Partial<OfflineLicensePolicy> | null
  if (
    !policy ||
    policy.schema !== 1 ||
    typeof policy.authorityId !== 'string' ||
    !/^[a-f0-9]{24}$/.test(policy.authorityId) ||
    typeof policy.helperSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(policy.helperSha256)
  ) {
    throw new Error('This Nawa build is missing a valid PC approval policy. Reinstall Nawa.')
  }
  return policy as OfflineLicensePolicy
}

/** Check the pinned native helper before executing it, including activation UI. */
export function offlineLicenseHelper(resources: string, policy: OfflineLicensePolicy): string {
  const helper = join(resources, 'licensing', 'nawa-license.exe')
  const hash = createHash('sha256').update(readFileSync(helper)).digest('hex')
  if (hash !== policy.helperSha256) {
    throw new Error('The Nawa activation helper was changed or damaged. Reinstall Nawa.')
  }
  return helper
}

export function assertOfflineLicense(resources: string, rawPolicy: unknown): void {
  const policy = parseOfflineLicensePolicy(rawPolicy)
  const helper = offlineLicenseHelper(resources, policy)
  try {
    const output = execFileSync(helper, ['status'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    })
    const status = JSON.parse(output.trim()) as { ok?: boolean; authorityId?: string }
    if (status.ok !== true || status.authorityId !== policy.authorityId) {
      throw new Error('Invalid PC approval response.')
    }
  } catch (error) {
    let message =
      'This PC needs approval. Open Nawa to export a device request and import your signed license.'
    const stdout = (error as { stdout?: string | Buffer })?.stdout
    if (stdout) {
      try {
        const status = JSON.parse(String(stdout)) as { message?: unknown }
        if (typeof status.message === 'string') message = status.message
      } catch {
        // Corrupt, timed-out, or missing helper output always fails closed.
      }
    }
    throw new Error(message, { cause: error })
  }
}
