import { useEffect, useRef, useState } from 'react'
import type { MyAgentDocumentTools as Catalog } from '../../../shared/myagent-settings-api'
import { useSidebarText } from '../explorer/sidebar-i18n'

export function MyAgentDocumentTools({ active, disabled, selectedFiles = [] }: { active: boolean; disabled: boolean; selectedFiles?: string[] }) {
  const { s } = useSidebarText()
  const extensions = [...new Set(selectedFiles.flatMap(path => {
    const extension = path.match(/\.[a-zA-Z0-9]{1,31}$/)?.[0].toLowerCase()
    return extension ? [extension] : []
  }))].sort()
  const extensionKey = JSON.stringify(extensions)
  const [scope, setScope] = useState<'server' | 'selected'>(extensions.length ? 'selected' : 'server')
  const [query, setQuery] = useState(''), [appliedQuery, setAppliedQuery] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const epoch = useRef(0), alive = useRef(true), working = useRef(false), started = useRef(false)
  const noTypes = scope === 'selected' && !extensions.length
  const currentScope = scope + (scope === 'selected' ? extensionKey : '')
  const invalidate = () => { epoch.current++; setCatalog(null); setError('') }
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++ } }, [])
  useEffect(() => { invalidate() }, [currentScope, disabled])
  useEffect(() => {
    const changed = () => { invalidate() }
    window.addEventListener('nawa:rag-settings-changed', changed)
    return () => window.removeEventListener('nawa:rag-settings-changed', changed)
  }, [])
  const load = async (more = false) => {
    if (working.current || disabled || noTypes) return
    const offset = more ? catalog?.nextOffset : 0
    if (offset == null) return
    const requestQuery = more ? appliedQuery : query.trim(), token = epoch.current
    working.current = true; setBusy(true); setError('')
    try {
      const result = await window.nawaMyAgent.documentTools({ query: requestQuery, offset, ...(scope === 'selected' ? { extensions } : {}) })
      if (!alive.current || token !== epoch.current) return
      if (more && catalog && (result.serverUrl !== catalog.serverUrl || result.total !== catalog.total)) throw new Error(s('The tool catalog changed. Refresh the list before loading more.'))
      setCatalog(more && catalog ? { ...result, tools: [...new Map([...catalog.tools, ...result.tools].map(tool => [tool.name, tool])).values()] } : result)
      setAppliedQuery(requestQuery)
    } catch (cause) { if (alive.current && token === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    if (active && !disabled && !started.current && !noTypes) { started.current = true; void load() }
  }, [active, disabled, currentScope])
  return <section className="nawa-document-tools" aria-label={s('Available MyAgent document tools')} aria-busy={busy}>
    <label className="nawa-rag-field"><span>{s('Tool scope')}</span><select className="set-input" aria-label={s('Tool scope')} disabled={busy || disabled} value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="selected">{s('Selected file types')}</option><option value="server">{s('All server document tools')}</option></select></label>
    {scope === 'selected' && <p>{extensions.length ? extensions.join(', ') : s('Select individual files in Explorer, or choose all server document tools.')}</p>}
    <form onSubmit={event => { event.preventDefault(); void load() }}>
      <label className="nawa-rag-field"><span>{s('Find a tool')}</span><input className="set-input" aria-label={s('Find a tool')} value={query} maxLength={256} disabled={busy || disabled} onChange={event => setQuery(event.target.value)} placeholder={s('Search tool names or descriptions')} spellCheck={false}/></label>
      <div className="nawa-rag-actions"><button type="submit" className="set-btn" disabled={busy || disabled || noTypes}>{s(query.trim() ? 'Search tools' : 'Refresh tools')}</button></div>
    </form>
    {disabled && <p>{s('Save or discard the connection changes before loading tools.')}</p>}
    {busy && <p role="status">{s('Loading tool definitions…')}</p>}
    {catalog && <>
      <p role="status">{s('{shown} of {total} tools', { shown: catalog.tools.length, total: catalog.total })}{appliedQuery && ` · ${appliedQuery}`}</p>
      {!catalog.tools.length && <p>{s('No tools match this search or file-type filter.')}</p>}
      <ul className="nawa-document-tool-list">{catalog.tools.map(tool => <li key={tool.name}>
        <details><summary><code>{tool.name}</code></summary><p>{tool.description}</p>
        <details><summary>{s('Parameters')}</summary><pre tabIndex={0}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></details>
      </li>)}</ul>
      {catalog.nextOffset != null && <button type="button" className="set-btn" disabled={busy || disabled} onClick={() => void load(true)}>{s('Load more tools')}</button>}
      <details><summary>{s('Connection details')}</summary><small><bdi>{catalog.serverUrl}</bdi><br/>{s('Checked at')} <bdi>{catalog.checkedAt}</bdi></small></details>
    </>}
    {error && <p className="nawa-rag-error" role="alert">{error}</p>}
    <details><summary>{s('Using these tools')}</summary><p>{s('Browse the tools this MyAgent server exposes to Nawa. This lists definitions and does not read file contents or require indexing.')}</p><p>{s('Ask the assistant in Chat; it chooses tools for the selected files. Reading content requires a current index. This catalog does not verify file readiness; use Files → Check selected files.')}</p></details>
  </section>
}
