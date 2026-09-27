import type { HistoryComparison } from '../../../shared/conversation-api'
import { useSidebarText } from '../explorer/sidebar-i18n'
export function ChangeNotice({ report, checking, error, recheck }: {
  report: HistoryComparison | null
  checking: boolean
  error: string | null
  recheck: () => void
}) {
  const { s } = useSidebarText()
  const changed = report?.status === 'changed'
  return <div className={`nawa-history-change${changed ? ' is-changed' : ''}`} role="status" aria-live="polite">
    <div className="nawa-history-change-head"><strong>{s(checking ? 'Checking files…'
      : error ? 'Could not verify this directory'
      : changed ? 'This directory has changed since this chat'
      : report?.status === 'unchanged' ? 'No content changes detected'
      : report?.status === 'incomplete' ? 'Change check is incomplete'
      : 'File check runs with your next message')}</strong>
      <button type="button" className="ws-chat-close" disabled={checking} onClick={recheck}>{s('Check again')}</button></div>
    {error && <p>{error} {s("Earlier answers may be out of date.")}</p>}
    {!checking && report && (changed || report.status === 'incomplete') && <>
      {report.since && <p>{s("Compared with")} {new Date(report.since).toLocaleString()}.</p>}
      {changed && <p>{report.added} {s("added ·")} {report.modified} {s("modified ·")} {report.removed} {s("removed. Earlier answers describe the previous files.")}</p>}
      {(!report.complete || report.unverified > 0) && <p>{s('Some paths could not be verified. Earlier answers may be out of date.')}</p>}
      {(report.changes.length > 0 || report.issues.length > 0) && <details><summary>{s("Change details")}</summary>
        <ul>{report.changes.map((change, index) => <li key={`${change.path}:${index}`}><b>{change.kind}</b> — <span>{change.path}</span></li>)}</ul>
        {report.truncated && <p>{s("Showing the first 100 changes. Counts include all detected changes.")}</p>}
        {report.issues.length > 0 && <ul>{report.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      </details>}
    </>}
  </div>
}
