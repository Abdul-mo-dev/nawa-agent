import { useState, useSyncExternalStore } from 'react'
import type { DirectoryInteraction } from '@genoffice/agent-core'
import type { WorkflowController } from './workflow-controller'
import './approvals.css'

export function WorkflowCard({ controller }: { controller: WorkflowController }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  if (!status) return null
  return <section className="nawa-file-approval" aria-label="Native Office workflow">
    {status.progress && <div role="status" className="nawa-workflow-progress">{status.progress}</div>}
    {status.warnings.map((warning, i) => <p key={i} role="note">{warning}</p>)}
    {status.interaction && <Question key={status.interaction.id} item={status.interaction} controller={controller} busy={status.busy} />}
    {status.error && <p role="alert">{status.error}</p>}
  </section>
}
function Question({ item, controller, busy }: { item: DirectoryInteraction; controller: WorkflowController; busy: boolean }) {
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const questions = Array.isArray(item.payload) ? item.payload as { id: string; label: string; description?: string; options?: string[]; multi?: boolean }[] : []
  const decide = (action: 'answer' | 'confirm' | 'cancel' | 'redo' | 'keep' | 'discard') => {
    const answers = questions.map(q => `${q.label}: ${chosen[q.id] || '(not specified)'}`).join('\n')
    void controller.decide({ id: item.id, action, text: [answers, text].filter(Boolean).join('\n').slice(0, 16000) })
  }
  return <div className="nawa-workflow-question">
    <h3>{item.title}</h3>
    {item.kind === 'questions' ? questions.map(q => <fieldset key={q.id} disabled={busy}>
      <legend>{q.label}</legend>{q.description && <p>{q.description}</p>}
      {q.options?.map(option => <label key={option} style={{ display: 'block' }}>
        <input type={q.multi ? 'checkbox' : 'radio'} name={`${item.id}-${q.id}`} checked={q.multi ? (chosen[q.id] || '').split('\n').includes(option) : chosen[q.id] === option}
          onChange={e => setChosen(old => {
            if (!q.multi) return { ...old, [q.id]: option }
            const options = new Set((old[q.id] || '').split('\n').filter(Boolean)); e.target.checked ? options.add(option) : options.delete(option)
            return { ...old, [q.id]: [...options].join('\n') }
          })} />{option}
      </label>)}
    </fieldset>) : <pre className="nawa-workflow-detail">{typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload, null, 2)}</pre>}
    {(item.kind === 'questions' || item.kind === 'brief') && <textarea rows={3} value={text} disabled={busy} maxLength={12000}
      aria-label="Additional directions" placeholder={item.kind === 'brief' ? 'Changes to request in another brief…' : 'Other choices or additional directions…'} onChange={e => setText(e.target.value)} />}
    <div className="nawa-approval-buttons">
      <button type="button" disabled={busy} className="ws-chat-close" onClick={() => decide(item.kind === 'partial' ? 'discard' : 'cancel')}>Cancel / discard</button>
      {item.kind === 'brief' && <button type="button" disabled={busy || !text.trim()} className="ws-chat-close" onClick={() => decide('redo')}>Revise brief</button>}
      <button type="button" disabled={busy} className="ws-chat-send" onClick={() => decide(item.kind === 'questions' ? 'answer' : item.kind === 'partial' ? 'keep' : 'confirm')}>
        {busy ? 'Submitting…' : item.kind === 'questions' ? 'Use these directions' : item.kind === 'partial' ? 'Keep partial draft' : 'Confirm'}
      </button>
    </div>
    <small>This workflow decision is not permission to publish the staged document. Saving still requires separate approval.</small>
  </div>
}
