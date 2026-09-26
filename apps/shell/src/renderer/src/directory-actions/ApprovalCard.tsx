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
    {!!proposal.linkedImages?.length && <div className="nawa-workflow-permissions"><strong>Linked local images — additional explicit read permission</strong><p>Approving preparation also permits reading these exact images referenced by the selected document. It does not permit reading other files in their folders.</p><details><summary>Review {proposal.linkedImages.length} linked image paths</summary><pre>{proposal.linkedImages.join('\n')}</pre></details></div>}
    {proposal.workflow && <div className="nawa-workflow-permissions">
      <strong>Workflow permissions</strong>
      {proposal.workflow.conversion && <p>Native conversion: {proposal.workflow.conversion.source} → {proposal.workflow.conversion.to}. No generative model is needed for this conversion.</p>}
      <p>Render first-page preview: {proposal.workflow.renderPreview ? 'requested' : 'not requested'}.</p>
      <p>{proposal.workflow.conversion ? 'This conversion does not call the chat model.' : 'Native generation uses the selected chat provider.'} Additional web research / image downloads: {proposal.workflow.network ? 'REQUESTED' : 'not enabled'}. External media processing: {proposal.workflow.media ? 'REQUESTED' : 'not enabled'}.</p>
      {!!proposal.workflow.sources?.length && <details><summary>Selected reference files ({proposal.workflow.sources.length})</summary><pre>{proposal.workflow.sources.join('\n')}</pre></details>}
      {proposal.workflow.network && <p role="note">Approving preparation permits external requests through your configured services. Queries, prompts, and relevant reference material may be sent to those services.</p>}
    </div>}
    <p>{deleting ? 'This file will be moved to the Recycle Bin, not permanently deleted.' : phase === 'save' ? 'Only Approve save changes the destination. Existing files receive a local backup.' : 'Nawa will use the document’s native editing tools on a private copy. You will review the result before it is saved to this path.'}</p>
    {phase === 'save' && <>
      <div>{proposal.bytes?.toLocaleString()} bytes · SHA-256 verified</div>
      {proposal.review && <div className="nawa-structured-review">
        <h4>{proposal.review.format.toUpperCase()} change review</h4>
        <p>{proposal.review.changed} change records (cells, paragraphs, elements, parts or lines) · {proposal.review.complete ? 'Bounded structural comparison completed' : 'Partial review'}</p>
        {proposal.review.warnings.map((warning, i) => <p key={i} role="note">{warning}</p>)}
        {proposal.review.entries.map((entry, i) => <details key={i}>
          <summary>{entry.location} — {entry.kind}</summary>
          <h5>Before</h5><pre>{entry.before ?? '(not present)'}</pre>
          <h5>After</h5><pre>{entry.after ?? '(removed)'}</pre>
        </details>)}
        {proposal.review.quality && <div className="nawa-native-quality">
          <h4>Native checks and preview</h4>
          <p>{proposal.review.quality.checked ? proposal.review.quality.summary : 'Native check did not complete or is unsupported.'}</p>
          {proposal.review.quality.warnings.map((text, index) => <p key={index} role="note">{text}</p>)}
          {proposal.review.quality.detail && <details><summary>Check findings</summary><pre>{proposal.review.quality.detail}</pre></details>}
          {proposal.review.quality.images.filter(image => image.dataUrl.startsWith('data:image/png;base64,')).map((image, index) => <figure key={index}><img src={image.dataUrl} alt={`Staged output — page ${image.page}`} style={{ maxWidth: '100%', maxHeight: 420, objectFit: 'contain' }} /><figcaption>Staged output — page {image.page}. Other pages are not shown.</figcaption></figure>)}
        </div>}
        {!!proposal.review.operations?.length && <details><summary>Native operation log ({proposal.review.operations.length})</summary>
          {proposal.review.operations.map((operation, i) => <div key={i}><strong>{operation.ok ? 'Completed' : 'Failed'}: {operation.tool}</strong><p>{operation.summary}</p><pre>{operation.input}</pre></div>)}
        </details>}
      </div>}
      <details><summary>Review text before / after (up to 12,000 characters each)</summary>
        <h4>Before</h4><pre>{proposal.beforeText || (proposal.operation === 'create' ? '(new file)' : '(empty or no extractable text)')}</pre>
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
