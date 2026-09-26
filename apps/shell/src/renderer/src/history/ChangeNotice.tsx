import type { HistoryComparison } from '../../../shared/conversation-api'
export function ChangeNotice({ report, checking, error, recheck }: {
  report: HistoryComparison | null
  checking: boolean
  error: string | null
  recheck: () => void
}) {
  const changed = report?.status === 'changed'
  return <div className={`nawa-history-change${changed ? ' is-changed' : ''}`} role="status" aria-live="polite">
    <div className="nawa-history-change-head"><strong>{checking ? 'Checking for file and folder changes…'
      : error ? 'Could not verify this directory'
      : changed ? 'This directory has changed since this chat'
      : report?.status === 'unchanged' ? 'No content changes detected'
      : report?.status === 'incomplete' ? 'Change check is incomplete'
      : 'No historical fingerprint yet'}</strong>
      <button type="button" className="ws-chat-close" disabled={checking} onClick={recheck}>Check again</button></div>
    {error && <p>{error} Earlier answers may be out of date.</p>}
    {!checking && report && <>
      {report.since && <p>Compared with {new Date(report.since).toLocaleString()}.</p>}
      {changed && <p>{report.added} added · {report.modified} modified · {report.removed} removed. Earlier answers describe the previous files.</p>}
      {(!report.complete || report.unverified > 0) && <p>{report.status === 'no-baseline'
        ? 'Older chats did not record file hashes. A fingerprint will be saved with the next message.'
        : 'Some paths could not be verified. This is not a guarantee that the remaining files are unchanged.'}</p>}
      {(report.changes.length > 0 || report.issues.length > 0) && <details><summary>Change details</summary>
        <ul>{report.changes.map((change, index) => <li key={`${change.path}:${index}`}><b>{change.kind}</b> — <span>{change.path}</span></li>)}</ul>
        {report.truncated && <p>Showing the first 100 changes. Counts include all detected changes.</p>}
        {report.issues.length > 0 && <ul>{report.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      </details>}
    </>}
  </div>
}
