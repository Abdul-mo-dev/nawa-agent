import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentLoop, composeSkills, type AgentMessage } from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import type { WorkspaceScopeDirectory, WorkspaceScopeFile } from '../../shared/workspace-api'
import { clearMessages, draftKey, formatBytes, isUnderDir, loadMessages, relativeDocumentName, saveMessages, type WorkspaceMessage } from './workspace-chat-state'
import { createDirectorySkill } from './ai/directory-skill'
import { createShellTransport } from './ai/transport'

interface WorkspaceChatProps {
  folder: string | null
  folderName: string
  scopePaths: string[]
  scopeDirs?: string[]
  onOpenFile: (path: string) => void
  onClose: () => void
}

export function WorkspaceChat(props: WorkspaceChatProps) {
  return props.folder ? <DirectoryChat key={props.folder} {...props} folder={props.folder} /> : null
}

function DirectoryChat({ folder, folderName, scopePaths, scopeDirs = [], onOpenFile, onClose }: WorkspaceChatProps & { folder: string }) {
  const [messages, setMessages] = useState<WorkspaceMessage[]>(() => { try { return loadMessages(localStorage, folder) } catch { return [] } })
  const [input, setInput] = useState(() => { try { return localStorage.getItem(draftKey(folder)) ?? '' } catch { return '' } })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [toolActivity, setToolActivity] = useState<string[]>([])
  const [discovered, setDiscovered] = useState<string[]>([])
  const [discoveredFiles, setDiscoveredFiles] = useState<WorkspaceScopeFile[]>([])
  const [discoveredDirs, setDiscoveredDirs] = useState<WorkspaceScopeDirectory[]>([])
  const [scopeTruncated, setScopeTruncated] = useState(false)
  const [scopeLoading, setScopeLoading] = useState(true)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [filter, setFilter] = useState('')
  const [checked, setChecked] = useState<Set<string> | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const loopRef = useRef<AgentLoop | null>(null)
  const settingsRef = useRef<AiSettings | null>(null)
  const allowedRef = useRef<readonly string[]>([])
  const frozenAllowedRef = useRef<readonly string[] | null>(null)
  const discoveredRef = useRef({ files: discoveredFiles, dirs: discoveredDirs })
  discoveredRef.current = { files: discoveredFiles, dirs: discoveredDirs }

  const fileMeta = useMemo(() => new Map(discoveredFiles.map((f) => [f.path, f])), [discoveredFiles])
  const basePaths = useMemo(() => {
    const order = (a: string, b: string) => relativeDocumentName(folder, a).localeCompare(relativeDocumentName(folder, b), undefined, { numeric: true })
    if (!scopePaths.length && !scopeDirs.length) return [...discovered].sort(order)
    const selected = new Set(scopePaths)
    for (const dir of scopeDirs) for (const path of discovered) if (isUnderDir(dir, path)) selected.add(path)
    return [...selected].sort(order)
  }, [discovered, scopePaths, scopeDirs, folder])
  const hasExplicitFilter = scopePaths.length > 0 || scopeDirs.length > 0 || checked !== null
  const paths = useMemo(() => checked !== null ? basePaths.filter((p) => checked.has(p)) : basePaths, [basePaths, checked])
  allowedRef.current = paths
  const allChecked = paths.length > 0 && checked !== null ? basePaths.every((p) => checked.has(p)) : !checked && basePaths.length > 0

  useEffect(() => {
    const transport = createShellTransport(() => {
      if (!settingsRef.current) throw new Error('AI settings are not loaded.')
      return settingsRef.current
    })
    const directory = createDirectorySkill({
      getFolder: () => folder,
      getAllowedPaths: () => frozenAllowedRef.current ?? allowedRef.current,
      getDiscovered: () => discoveredRef.current,
    })
    const loop = new AgentLoop({
      transport,
      skill: composeSkills('directory', '', [directory]),
      maxTurns: 24,
      maxHistory: 40,
      events: {
        onText: (text) => setMessages((prev) => prev.map((m, i) => i === prev.length - 1 && m.role === 'assistant' && m.streaming ? { ...m, text } : m)),
        onToolStart: (call) => setToolActivity((prev) => [...prev.slice(-5), `Running ${call.name}…`]),
        onToolExecuted: ({ call, execution }) => setToolActivity((prev) => [...prev.filter((x) => x !== `Running ${call.name}…`).slice(-4), execution.summary]),
        onTurnEnd: () => {
          // Seal the finished turn's bubble so the next turn streams into a fresh one (docs AiPanel pattern).
          setMessages((prev) => {
            const sealed = prev.map((m, i) => i === prev.length - 1 && m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m)
            return [...sealed, { role: 'assistant', text: '', streaming: true }]
          })
        },
        onDone: ({ text, cancelled, turnLimit }) => {
          frozenAllowedRef.current = null
          setMessages((prev) => prev.map((m, i) => i === prev.length - 1 && m.role === 'assistant' && m.streaming ? { ...m, text: text || m.text || (cancelled ? 'Stopped.' : 'Done.'), streaming: false } : m))
          setBusy(false)
          if (turnLimit) setNotice('The folder agent reached its tool-turn limit and answered from what it had gathered.')
          else if (cancelled) setNotice('Stopped. Any partial answer has been kept in this folder’s chat.')
        },
        onError: (error) => {
          frozenAllowedRef.current = null
          setMessages((prev) => prev.map((m, i) => i === prev.length - 1 && m.role === 'assistant' && m.streaming ? { ...m, text: error, streaming: false, error: true } : m))
          setBusy(false)
        },
      },
    })
    // Phase 1 limitation: UI history stores prose only (no tool results), so restored
    // loop context loses prior tool outputs and follow-ups re-read via tools.
    const restored: AgentMessage[] = messages.filter((m) => !m.streaming && !m.error && m.text).map((m) => ({ role: m.role, text: m.text }))
    loop.restore(restored)
    loopRef.current = loop
    return () => { loop.reset(); loopRef.current = null; frozenAllowedRef.current = null }
    // Folder is the component key; create exactly one loop for this directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { setChecked(null); setFilter(''); setNotice(null) }, [folder])
  useEffect(() => {
    let alive = true
    let sequence = 0
    const load = async () => {
      const current = ++sequence
      setScopeLoading(true); setScopeError(null)
      try {
        const result = await window.aiOffice.folderChatFiles(folder)
        if (!alive || current !== sequence) return
        setDiscovered(result.paths); setDiscoveredFiles(result.files ?? []); setDiscoveredDirs(result.directories ?? []); setScopeTruncated(result.truncated)
      } catch (error) {
        if (!alive || current !== sequence) return
        setDiscovered([]); setDiscoveredFiles([]); setDiscoveredDirs([]); setScopeError(error instanceof Error ? error.message : String(error))
      } finally { if (alive && current === sequence) setScopeLoading(false) }
    }
    void load()
    const onFocus = () => void load()
    const off = window.aiOffice.onFolderChanged((dirs) => {
      const prefix = folder.replace(/\\/g, '/').replace(/\/$/, '') + '/'
      if (dirs.some((dir) => dir === folder || dir.replace(/\\/g, '/').startsWith(prefix))) void load()
    })
    window.addEventListener('focus', onFocus)
    return () => { alive = false; sequence++; off(); window.removeEventListener('focus', onFocus) }
  }, [folder, refresh])
  useEffect(() => { try { saveMessages(localStorage, folder, messages) } catch {} ; logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [folder, messages])
  useEffect(() => { try { localStorage.setItem(draftKey(folder), input) } catch {} }, [folder, input])

  const materialize = () => checked !== null ? new Set(checked) : new Set(basePaths)
  const toggleFile = (path: string, on: boolean) => setChecked(() => { const next=materialize(); on ? next.add(path) : next.delete(path); return next })
  const toggleDir = (dir: string, on: boolean) => setChecked(() => {
    const next=materialize()
    for (const path of basePaths) if (isUnderDir(dir,path)) on ? next.add(path) : next.delete(path)
    if (on) for (const path of discovered) if (isUnderDir(dir,path)) next.add(path)
    return next
  })
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(basePaths))
  const stop = () => loopRef.current?.cancel()
  const newChat = () => {
    if (busy) return
    if (messages.length && !window.confirm('Start a new chat? The current conversation for this folder will be cleared.')) return
    loopRef.current?.reset()
    frozenAllowedRef.current = null
    setMessages([]); setToolActivity([])
    // A failed scope load disables Send; retry it so a fresh chat is never stuck behind an old error.
    if (scopeError) { setScopeError(null); setRefresh((v) => v + 1) }
    setNotice(!scopeError && paths.length ? 'Started a new chat for this folder.' : 'Started a new chat. Check at least one file or directory to chat about.')
    try { clearMessages(localStorage, folder) } catch {}
  }
  const send = async () => {
    const question=input.trim()
    if (!question || busy || scopeLoading || scopeError) return
    if (!paths.length) { setNotice(hasExplicitFilter ? 'All documents are unchecked. Check at least one file or directory to chat about.' : 'There are no supported documents in this folder.'); return }
    const loop=loopRef.current
    if (!loop || loop.busy) return
    try {
      settingsRef.current=await window.aiOffice.getAiSettings()
      frozenAllowedRef.current=[...new Set(paths)]
      setInput(''); setNotice('The agent will read checked documents on demand.'); setToolActivity([]); setBusy(true)
      setMessages((prev)=>[...prev,{role:'user',text:question},{role:'assistant',text:'',streaming:true}])
      loop.run(question)
    } catch (error) {
      frozenAllowedRef.current=null; setBusy(false)
      const text=error instanceof Error ? error.message : String(error)
      setMessages((prev)=>[...prev,{role:'assistant',text,error:true}])
    }
  }

  const needle=filter.trim().toLowerCase()
  const visiblePaths=needle ? basePaths.filter((p)=>relativeDocumentName(folder,p).toLowerCase().includes(needle)) : basePaths
  const visibleDirs=discoveredDirs.filter((d)=>d.path!==folder && (!needle || d.name.toLowerCase().includes(needle)))
  const isChecked=(path:string)=>checked!==null ? checked.has(path) : basePaths.includes(path)
  const dirChecked=(dir:string)=>{
    const members=basePaths.filter((p)=>isUnderDir(dir,p)); const pool=members.length ? members : discovered.filter((p)=>isUnderDir(dir,p))
    return pool.length>0 && pool.every((p)=>checked!==null ? checked.has(p) : true)
  }

  return <section className="ws-chat workspace-chat-main" aria-label={`Chat with ${folderName}`}>
    <header className="ws-chat-head">
      <div className="workspace-chat-heading"><span className="workspace-eyebrow">AI workspace</span><h1 className="ws-chat-title" title={folder}>{folderName}</h1><div className="workspace-chat-path" title={folder}>{folder}</div></div>
      <button type="button" className="ws-chat-close" onClick={newChat} disabled={busy || !messages.length}>New chat</button>
      <button type="button" className="ws-chat-close" onClick={onClose}>Hide chat</button>
    </header>
    <div className="ws-chat-scope">
      <div className="workspace-scope-toolbar"><span className="ws-chat-scope-count">{scopeLoading ? 'Finding documents…' : `${paths.length} of ${basePaths.length} checked · agent reads on demand`}</span><span className="workspace-scope-actions"><button type="button" className="workspace-text-button" onClick={toggleAll} disabled={scopeLoading || busy}>{allChecked?'Uncheck all':'Check all'}</button><button type="button" className="workspace-text-button" onClick={()=>setRefresh((v)=>v+1)} disabled={scopeLoading || busy}>Refresh</button></span></div>
      <p className="workspace-scope-help">{hasExplicitFilter?'Checked files and folders are the agent allowlist. Changes apply to the next message.':'Documents in this folder and subfolders are available to the agent on demand.'}</p>
      {scopeTruncated && <p className="ws-chat-notice">The folder scan reached its limit. Select a smaller subfolder for a more focused chat.</p>}
      {scopeError && <p className="ws-chat-notice" role="alert">{scopeError}</p>}
      {!scopeLoading && paths.length>0 && <div className="ws-chat-files ws-chat-chips" aria-label="Checked files">{paths.slice(0,8).map((p)=><span key={p} className="ws-chat-chip" title={p}><button type="button" className="ws-chat-chip-name" onClick={()=>onOpenFile(p)}>{relativeDocumentName(folder,p)}</button><button type="button" className="ws-chat-chip-remove" onClick={()=>toggleFile(p,false)} disabled={busy}>×</button></span>)}{paths.length>8&&<span className="ws-chat-meta">+{paths.length-8} more</span>}</div>}
      <details className="workspace-scope-picker"><summary>Choose files and folders ({basePaths.length} found)</summary><input className="workspace-scope-search" type="search" placeholder="Filter files and folders…" value={filter} onChange={(e)=>setFilter(e.target.value)} />
        {!scopeLoading&&visibleDirs.length>0&&<div className="ws-chat-dirs">{visibleDirs.slice(0,12).map((d)=><div key={d.path} className="ws-chat-dir" title={d.path}><input type="checkbox" checked={dirChecked(d.path)} disabled={busy} onChange={(e)=>toggleDir(d.path,e.target.checked)} /><span className="ws-chat-dir-name">{relativeDocumentName(folder,d.path)||d.name}</span><span className="ws-chat-meta">{d.fileCount} · {formatBytes(d.totalBytes)}</span></div>)}</div>}
        <div className="ws-chat-files ws-chat-files-checkable">{visiblePaths.slice(0,60).map((p)=>{const meta=fileMeta.get(p);return <div key={p} className={`ws-chat-file-check${isChecked(p)?'':' unchecked'}`} title={p}><input type="checkbox" checked={isChecked(p)} disabled={busy} onChange={(e)=>toggleFile(p,e.target.checked)} /><button type="button" className="ws-chat-file-name" onClick={()=>onOpenFile(p)}>{relativeDocumentName(folder,p)}</button>{meta&&<span className="ws-chat-meta">{formatBytes(meta.sizeBytes)}</span>}</div>})}{visiblePaths.length>60&&<p className="ws-chat-notice">Showing 60 of {visiblePaths.length}. Use the filter to narrow the list.</p>}</div>
      </details>
    </div>
    {toolActivity.length>0&&<div className="ws-chat-files ws-chat-chips" aria-label="Agent tools">{toolActivity.map((x,i)=><span key={`${x}-${i}`} className="ws-chat-chip">{x}</span>)}</div>}
    <div ref={logRef} className="ws-chat-log" role="log" aria-live="polite">{!messages.length&&<div className="ws-chat-empty"><h2>Chat with {folderName}</h2><p>Ask for a summary, compare documents, or find an answer. Nawa reads only relevant checked files with tools.</p><p>This folder workspace is read-only.</p></div>}{messages.map((m,i)=>m.role==='assistant'&&!m.text&&!m.streaming?null:<div key={i} className={`ws-chat-msg ws-chat-${m.role}${m.error?' ws-chat-error':''}`}><span className="workspace-message-role">{m.role==='user'?'You':'Nawa'}</span>{m.streaming&&!m.text?'Choosing documents…':m.text}</div>)}</div>
    {notice&&<div className="ws-chat-notice" role="status">{notice}</div>}
    <form className="ws-chat-input-row" onSubmit={(e)=>{e.preventDefault();void send()}}><textarea className="ws-chat-input" value={input} rows={3} placeholder={`Ask about ${folderName}…`} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}}/>{busy?<button type="button" className="ws-chat-send" onClick={stop}>Stop</button>:<button type="submit" className="ws-chat-send" disabled={!input.trim()||scopeLoading||!!scopeError||!paths.length}>Send</button>}</form>
    <div className="workspace-privacy-note">Only document text the agent chooses to read is sent to your configured AI provider. Files are not edited.</div>
  </section>
}
