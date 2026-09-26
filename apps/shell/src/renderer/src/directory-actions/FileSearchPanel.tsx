import { useEffect, useRef, useState } from 'react'
import type { FileSearchProgress, FileSearchResult } from '../../../shared/file-search-api'

/** Human-operated workspace search. Results are not injected into the conversation. */
export function FileSearchPanel({ folder, openFile }: { folder: string | null; openFile(path: string): void }) {
  const [query,setQuery]=useState(''),[result,setResult]=useState<FileSearchResult|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<FileSearchProgress|null>(null)
  const [consent,setConsent]=useState(false),[rerank,setRerank]=useState(false),[endpoint,setEndpoint]=useState<'direct'|'openrouter'>('direct'),[key,setKey]=useState(''),[hasKey,setHasKey]=useState(false)
  const epoch=useRef(0),alive=useRef(true)
  useEffect(()=>{
    alive.current=true;epoch.current++;setResult(null);setError('');setConsent(false);setRerank(false)
    const token=epoch.current
    void window.nawaFileSearch.settings().then(s=>{if(alive.current&&epoch.current===token){setEndpoint(s.endpoint);setHasKey(s.hasKey)}},()=>{})
    return()=>{alive.current=false;epoch.current++;void window.nawaFileSearch.cancel().catch(()=>{})}
  },[folder])
  useEffect(()=>{
    if(!busy)return
    let live=true,pending=false
    const timer=setInterval(()=>{if(pending)return;pending=true;void window.nawaFileSearch.progress().then(p=>{if(live)setProgress(p)},()=>{}).finally(()=>{pending=false})},500)
    return()=>{live=false;clearInterval(timer)}
  },[busy])
  const perform=async(work:()=>Promise<void>)=>{
    if(busy)return
    const token=++epoch.current;setBusy(true);setError('')
    try{await work()}catch(cause){if(alive.current&&epoch.current===token)setError(cause instanceof Error?cause.message:String(cause))}
    finally{if(alive.current&&epoch.current===token)setBusy(false)}
  }
  const search=()=>perform(async()=>{if(!folder)return;const token=epoch.current;const value=await window.nawaFileSearch.search(folder,query,rerank);if(alive.current&&epoch.current===token)setResult(value)})
  return <details className="nawa-file-search">
    <summary>Search file contents locally</summary>
    <p>This searches your local file index, not conversation history. Results stay in this panel and are not sent to the chat model. Select individual files in Explorer before asking the assistant to read them.</p>
    <label><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/> Index this opened folder and visible subfolders locally. Extracted text is stored unencrypted in Nawa’s separate content index.</label>
    <div className="nawa-approval-buttons">
      <button type="button" className="ws-chat-close" disabled={!folder||!consent||busy} onClick={()=>void perform(async()=>{const token=epoch.current;const p=await window.nawaFileSearch.indexFolder(folder!);if(alive.current&&epoch.current===token)setProgress(p)})}>Index / refresh folder</button>
      <button type="button" className="ws-chat-close" disabled={busy} onClick={()=>void perform(async()=>{const token=epoch.current;await window.nawaFileSearch.clear();if(alive.current&&epoch.current===token){setResult(null);setProgress(null)}})}>Clear content index (not chats)</button>
    </div>
    <input aria-label="Search indexed document contents" value={query} maxLength={256} disabled={busy} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void search()}}}/>
    <details><summary>Optional external result reranking</summary>
      <p>Off by default. Enabling sends your query and excerpts from up to 20 displayed candidates to the chosen external service. It may incur provider charges. This does not authorize the directory chat to read unselected files.</p>
      <select aria-label="Reranking provider" value={endpoint} disabled={busy} onChange={e=>setEndpoint(e.target.value as 'direct'|'openrouter')}><option value="direct">TypeSafe directly</option><option value="openrouter">OpenRouter → TypeSafe</option></select>
      <input type="password" aria-label="Reranking API key" autoComplete="off" value={key} disabled={busy} placeholder={hasKey?'Key stored securely; leave blank to remove':'API key'} onChange={e=>setKey(e.target.value)}/>
      <button type="button" disabled={busy} onClick={()=>void perform(async()=>{const token=epoch.current;await window.nawaFileSearch.saveSettings(endpoint,key);if(alive.current&&epoch.current===token){setHasKey(!!key.trim());setKey('');setRerank(false)}})}>{key.trim()?'Save key with OS protection':'Remove stored key'}</button>
      <label><input type="checkbox" checked={rerank} disabled={busy||!hasKey} onChange={e=>setRerank(e.target.checked)}/> I allow external reranking for searches from this panel.</label>
    </details>
    <div className="nawa-approval-buttons"><button type="button" className="ws-chat-send" disabled={!folder||!query.trim()||busy} onClick={()=>void search()}>Search</button>
      {busy&&<button type="button" className="ws-chat-close" onClick={()=>{epoch.current++;setBusy(false);void window.nawaFileSearch.cancel().catch(()=>{});setError('Cancelled.')}}>Stop search</button>}</div>
    {progress&&<p role="status">{progress.message} {progress.running?`(${progress.indexed} indexed; ${progress.pending} pending)`:''}</p>}
    {error&&<p role="alert">{error}</p>}
    {result&&<div className="nawa-search-results"><p>{result.total} matches · {result.reranked?'External reranking used':'Local ranking'}</p>
      {result.warnings.map((warning,i)=><p role="note" key={i}>{warning}</p>)}
      {result.hits.map(hit=><article key={hit.path}><button type="button" className="ws-chat-close" onClick={()=>openFile(hit.path)}>{hit.name}</button><small>{hit.path}</small><p>{hit.snippet?.map((part,i)=>part.hit?<mark key={i}>{part.text}</mark>:<span key={i}>{part.text}</span>)??'Filename/path match; no content excerpt.'}</p></article>)}
    </div>}
  </details>
}
