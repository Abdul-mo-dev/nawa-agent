/** Fail closed on unreviewed advisories, version drift and expired mitigations. */
export function evaluateAudit(audit, policy, installedVersion, now = new Date()) {
  if (audit.error || !audit.vulnerabilities || audit.auditReportVersion !== 2)
    throw new Error('The registry did not return a complete npm audit report.')
  const reviewed = new Set()
  const failures = []
  for (const vulnerability of Object.values(audit.vulnerabilities)) {
    for (const advisory of vulnerability.via ?? []) {
      if (typeof advisory === 'string') {
        if (!audit.vulnerabilities[advisory])
          throw new Error(`Incomplete dependency advisory chain: ${advisory}`)
        continue
      }
      const id = advisory.url?.split('/').pop()
      const rule = policy.mitigations.find((item) => item.advisory === id)
      const version = installedVersion(advisory.name)
      if (
        !rule ||
        rule.package !== advisory.name ||
        rule.version !== version ||
        advisory.severity === 'critical' ||
        !Number.isFinite(Date.parse(rule.reviewBy)) ||
        Date.parse(rule.reviewBy) <= now.getTime() ||
        !rule.reason?.trim() ||
        !rule.evidence?.length
      ) {
        failures.push(`${id ?? 'unknown advisory'} (${advisory.name}@${version ?? 'missing'})`)
      } else reviewed.add(`${id}: ${rule.reason}`)
    }
  }
  if (failures.length) throw new Error(`Unmitigated dependency advisories:\n${failures.join('\n')}`)
  return [...reviewed]
}
