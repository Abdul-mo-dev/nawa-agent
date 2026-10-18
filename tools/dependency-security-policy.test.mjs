import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAudit } from './dependency-security-policy.mjs'
const now = new Date('2026-10-18T00:00:00Z')
const advisory = {
  name: 'example',
  severity: 'high',
  url: 'https://github.com/advisories/GHSA-example',
}
const audit = { auditReportVersion: 2, vulnerabilities: { example: { via: [advisory] } } }
const rule = {
  advisory: 'GHSA-example',
  package: 'example',
  version: '1.0.0',
  reviewBy: '2026-11-17',
  reason: 'Reviewed mitigation',
  evidence: ['test'],
}
test('accepts only the reviewed version until its review deadline', () => {
  assert.equal(evaluateAudit(audit, { mitigations: [rule] }, () => '1.0.0', now).length, 1)
  for (const [policy, version, date] of [
    [{ mitigations: [] }, '1.0.0', now],
    [{ mitigations: [rule] }, '1.0.1', now],
    [{ mitigations: [rule] }, '1.0.0', new Date('2026-11-18')],
  ])
    assert.throws(() => evaluateAudit(audit, policy, () => version, date), /Unmitigated/)
})
test('rejects registry failures and critical advisories', () => {
  assert.throws(
    () => evaluateAudit({ error: { code: 'ENETDOWN' } }, { mitigations: [] }, () => ''),
    /complete/,
  )
  const critical = structuredClone(audit)
  critical.vulnerabilities.example.via[0].severity = 'critical'
  assert.throws(
    () => evaluateAudit(critical, { mitigations: [rule] }, () => '1.0.0', now),
    /Unmitigated/,
  )
})
