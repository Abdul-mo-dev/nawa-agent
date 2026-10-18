import { expect, it } from 'vitest'
import { previewContentSecurityPolicy } from '../src/main/preview-policy'

it('blocks remote resources by default while retaining local document scripts', () => {
  const policy = previewContentSecurityPolicy()
  expect(policy).toContain("script-src 'unsafe-inline' html-asset: blob:")
  expect(policy).toContain("connect-src 'none'")
  expect(policy).toContain("form-action 'none'")
  expect(policy).toContain("frame-src 'none'")
  expect(policy).not.toMatch(/(?:script|img|style)-src[^;]*https:/)
})

it('allows remote resources only for the explicit opt-in', () => {
  expect(previewContentSecurityPolicy(true)).toContain('connect-src https: http: wss: ws:')
  expect(previewContentSecurityPolicy(false)).toContain("connect-src 'none'")
})
