import { useSyncExternalStore } from 'react'
import type { ApprovalController } from './controller'
import './approvals.css'

export function ApprovalCard({ controller }: { controller: ApprovalController }) {
  const request = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  if (!request) return null
  const { proposal, phase, key } = request
  const deleting = proposal.operation === 'delete'
  return <section className="nawa-file-approval" role="region" aria-label="File action approval">
    <h3>{phase === 'save' ? 'Review before saving' : deleting ? 'Approve file deletion?' : 'Approve native editor task?'}</h3>
    <strong className="nawa-approval-path">{proposal.path}</strong>
    <p>{proposal.instruction}</p>
    <p>{deleting ? 'This file will be moved to the Recycle Bin, not permanently deleted.' : phase === 'save' ? 'Only Approve save changes the destination. Existing files receive a local backup.' : 'Nawa will use the document’s native editing tools on a private copy. You will review the result before it is saved to this path.'}</p>
    {phase === 'save' && <>
      <div>{proposal.bytes?.toLocaleString()} bytes · SHA-256 verified</div>
      <details><summary>Review text before / after (up to 12,000 characters each)</summary>
        <h4>Before</h4><pre>{proposal.beforeText || '(new file)'}</pre>
        <h4>After</h4><pre>{proposal.afterText || '(no extractable text)'}</pre>
        <small>Text previews are not a complete visual/layout diff. Non-text changes may not appear here.</small>
      </details>
    </>}
    <div className="nawa-approval-buttons">
      <button type="button" className="ws-chat-close" onClick={() => controller.decide(key, false)}>{phase === 'save' ? 'Discard' : 'Deny'}</button>
      <button type="button" className="ws-chat-send" onClick={() => controller.decide(key, true)}>{phase === 'save' ? 'Approve save' : deleting ? 'Move to Recycle Bin' : 'Approve preparation'}</button>
    </div>
  </section>
}
