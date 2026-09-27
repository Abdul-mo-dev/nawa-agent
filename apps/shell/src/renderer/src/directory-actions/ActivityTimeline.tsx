import { memo, useEffect, useState } from 'react'
import { AiTypingIndicator } from '@genoffice/ui'
import type { DirectoryActivity, DirectoryActivityStep } from '../../../shared/directory-activity'
import { useSidebarText } from '../explorer/sidebar-i18n'
import './activity.css'

const elapsed = (start: number, end: number) => {
  if (end - start < 1000) return `${Math.max(0, Math.round(end - start))}ms`
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
const filename = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path

const Step = memo(function Step({ step, now }: { step: DirectoryActivityStep; now: number }) {
  const { s } = useSidebarText()
  const labels = { running: 'Running', waiting: 'Waiting for you', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', incomplete: 'Incomplete', skipped: 'Not needed' }
  return <li className={`directory-step is-${step.status}${step.parentId ? ' is-child' : ''}`}>
    <span className="directory-step-mark" aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'cancelled' ? '−' : '•'}</span>
    <div className="directory-step-body">
      <details>
        <summary><span className="directory-step-title">{s(step.summary || step.tool)}</span><span className="directory-step-time">{elapsed(step.startedAt, step.finishedAt ?? now)}</span></summary>
        <div className="directory-step-meta"><span>{s(labels[step.status])}</span><code>{step.tool}</code>{step.kind === 'native' && <span>{s('Native editor')}</span>}</div>
        {!!step.targets.length && <ul className="directory-step-targets">{step.targets.map(path => <li key={path}><bdi>{path}</bdi></li>)}</ul>}
        {step.facts && <details className="directory-step-data"><summary>{s('Operation summary')}</summary><pre dir="auto">{JSON.stringify(step.facts, null, 2)}</pre></details>}
        {step.input && <details className="directory-step-data"><summary>{s('Tool arguments')}</summary><pre dir="auto">{step.input}</pre></details>}
        {step.output && <details className="directory-step-data"><summary>{s('Result details')}</summary><pre dir="auto">{step.output}</pre></details>}
      </details>
      {!!step.targets.length && <div className="directory-step-files" title={step.targets.join('\n')}>{step.targets.map(filename).join(' · ')}</div>}
    </div>
  </li>
})

export const ActivityTimeline = memo(function ActivityTimeline({ activity, onReview }: { activity: DirectoryActivity; onReview?: () => void }) {
  const { s } = useSidebarText()
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [copy, setCopy] = useState('')
  const running = activity.status === 'running' || activity.status === 'waiting'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const failures = activity.steps.filter(step => step.status === 'failed').length
  const open = expanded
  const label = activity.status === 'incomplete' ? 'Incomplete' : activity.status === 'failed' ? 'Request failed' : activity.status === 'cancelled' ? 'Stopped' : activity.status === 'waiting' ? 'Waiting for you' : running ? 'Working' : 'Worked'
  // File checks and model setup belong to diagnostics, not a premature answer.
  // Show the native file-chat thinking indicator until a tool starts.
  const showActivity = !running || activity.status === 'waiting' || failures > 0 ||
    activity.steps.some(step => step.kind === 'tool' || step.kind === 'native' || step.kind === 'approval')
  const copyDetails = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(activity, null, 2)); setCopy('Copied') }
    catch { setCopy('Could not copy. Select details below.') }
  }
  if (!showActivity) return <div className="directory-thinking"><AiTypingIndicator label={s('Thinking…')} /></div>
  return <section className="directory-activity" aria-label={s('Request activity')}>
    <div className="directory-activity-heading">
    <button type="button" className="directory-activity-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
      {running && <span className={`directory-activity-indicator is-${activity.status}`} aria-hidden="true" />}
      <span>{s(label)} · {s('{count} steps', { count: activity.steps.length + activity.omitted })}</span>
      <time>{elapsed(activity.startedAt, activity.finishedAt ?? now)}</time><span className={`directory-activity-caret${open ? ' is-open' : ''}`} aria-hidden="true">›</span>
    </button>
    {!!failures && <div className="directory-activity-errors">{s('{count} failed steps', { count: failures })}</div>}
    {onReview && <button type="button" className="ws-chat-close directory-activity-review" onClick={onReview}>{s('Review action')}</button>}
    </div>
    {open && <div className="directory-activity-content">
      <div className="directory-activity-context"><span>{activity.model || s('Default')}</span><span>{s('{count} selected files', { count: activity.selectedFiles })}</span></div>
      <ol className="directory-activity-steps">{activity.steps.map(step => <Step key={step.id} step={step} now={step.finishedAt ?? now} />)}</ol>
      {!!activity.omitted && <p>{s('{count} earlier steps omitted', { count: activity.omitted })}</p>}
      <details className="directory-activity-debug"><summary>{s('Debug details')}</summary>
        <p>{s('Local, bounded tool details. May include file content. Review before sharing.')}</p>
        <button type="button" className="ws-chat-close" onClick={() => void copyDetails()}>{s('Copy diagnostics')}</button>
        {copy && <span role="status">{s(copy)}</span>}
        <pre dir="ltr">{JSON.stringify({ requestId: activity.id, model: activity.model, selectedFiles: activity.selectedFiles,
          startedAt: new Date(activity.startedAt).toISOString(), status: activity.status }, null, 2)}</pre>
      </details>
    </div>}
  </section>
})
