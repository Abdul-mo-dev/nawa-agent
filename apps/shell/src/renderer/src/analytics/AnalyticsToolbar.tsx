import { useSidebarText } from '../explorer/sidebar-i18n'
import { usePanelActivity } from '../explorer/panel-state'
import { PanelDialog } from '../explorer/PanelDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dataset, TablePolicy, AnalyticsProgress } from '../../../shared/analytics-api'
import './analytics.css'
const failure=(e:unknown)=>e instanceof Error?e.message:String(e)
export function ReviewTable({dataset,onSaved,onClose}:{dataset:Dataset;onSaved():void;onClose():void}){
  const { s } = useSidebarText()
  const [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false)
  const dismiss = () => { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  usePanelActivity('ragAnalytics', 'review', dirty ? { kind: 'unsaved', text: s('Review table') + ': ' + s('Unsaved changes') } : null)
  const [policy,setPolicy]=useState<TablePolicy>({...dataset.policy,columns:dataset.policy.columns.map(c=>({...c}))}),[raw,setRaw]=useState(''),[advanced,setAdvanced]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const change=(patch:Partial<TablePolicy>)=>{setDirty(true);setPolicy(p=>({...p,...patch}));setConfirmed(false)}
  const save=async()=>{setBusy(true);setError('');try{const next=advanced?JSON.parse(raw) as TablePolicy:policy;await window.nawaAnalytics.review(dataset.id,dataset.generation,{...next,confirmed});onSaved()}catch(e){setError(failure(e))}finally{setBusy(false)}}
  return <PanelDialog open title={s('Review table') + ' · ' + dataset.name} closeDisabled={busy} onClose={dismiss} footer={<div className="nawa-review-footer">
    {discard ? <><p role="alert">{s('Discard unsaved changes?')}</p><button type="button" className="set-btn" onClick={() => setDiscard(false)}>{s('Keep editing')}</button><button type="button" className="set-btn danger" onClick={onClose}>{s('Discard changes')}</button></> : <>
    <label className="nawa-data-check"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> {s("I confirm the intended row grain, range, column types, units, exclusions and formula policy. This validates local analytical tables; it does not change the source workbook.")}</label>
    <button type="button" className="set-btn primary" disabled={busy||!confirmed} onClick={()=>void save()}>{s(busy?'Validating…':'Validate and approve table')}</button>
    {error&&<p role="alert" className="nawa-data-error">{error}</p>}
    </>}
  </div>}><div className="nawa-data-review">
    <p><strong>{dataset.name}</strong> · {dataset.sheet||dataset.kind} · {dataset.rawRows.toLocaleString()} {s("imported source records")}</p>
    <details><summary>{s('Source details')}</summary><p className="nawa-data-path"><bdi>{dataset.path}</bdi><br/>{s("SHA-256:")} <code>{dataset.sourceHash}</code></p></details>
    <div className="nawa-data-warnings">{dataset.warnings.map((w,i)=><p key={i}>{w}</p>)}</div>
    <div className="nawa-data-table-scroll" role="region" aria-label={s('Table preview')} tabIndex={0}><table><caption>{s("Bounded source preview—not a statistical sample")}</caption><thead><tr><th>{s("Source row")}</th>{dataset.policy.columns.slice(0,16).map(c=><th key={c.id}>{c.name}</th>)}</tr></thead><tbody>{dataset.preview.map(row=><tr key={row.row}><th>{row.row}</th>{row.values.slice(0,16).map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody></table></div>
    {!advanced&&<>
      <label className="nawa-data-field"><span>{s("What does one row represent? (required)")}</span><input className="set-input" value={policy.grain} disabled={busy} placeholder={s("One invoice line, one customer, one sensor observation…")} onChange={e=>change({grain:e.target.value})}/></label>
      <label className="nawa-data-field"><span>{s("Table description")}</span><input className="set-input" value={policy.description} disabled={busy} onChange={e=>change({description:e.target.value})}/></label>
      <div className="nawa-data-settings-grid"><label className="nawa-data-field"><span>{s("First data row")}</span><input className="set-input" type="number" min={1} disabled={busy} value={policy.firstRow} onChange={e=>change({firstRow:Number(e.target.value)})}/></label><label className="nawa-data-field"><span>{s("Last data row (blank = imported end)")}</span><input className="set-input" type="number" min={policy.firstRow} disabled={busy} value={policy.lastRow??''} onChange={e=>change({lastRow:e.target.value===''?null:Number(e.target.value)})}/></label></div>
      <label className="nawa-data-field"><span>{s("Unique row key: column IDs separated by commas")}</span><input className="set-input" disabled={busy} value={policy.key.join(',')} placeholder={s("c0 or c0,c1; required for combining overlapping-risk exports")} onChange={e=>change({key:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})}/></label>
      <label className="nawa-data-field"><span>{s("Currency column")}</span><select className="set-input" disabled={busy} value={policy.currencyColumn??''} onChange={e=>change({currencyColumn:e.target.value||null})}><option value="">{s("None / no mixed-currency measure")}</option>{policy.columns.map(c=><option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}</select></label>
      <label className="nawa-data-field"><span>{s("Formula handling")}</span><select className="set-input" disabled={busy} value={policy.formulaPolicy} onChange={e=>change({formulaPolicy:e.target.value as TablePolicy['formulaPolicy']})}><option value="reject">{s("Reject formula cells until resolved")}</option><option value="saved-cache">{s("Use saved cached values (unverified; no recalculation)")}</option></select></label>
      <label className="nawa-data-check"><input type="checkbox" checked={policy.includeHiddenRows} disabled={busy} onChange={e=>change({includeHiddenRows:e.target.checked})}/> {s("Include hidden source rows")}</label>
      <div className="nawa-data-table-scroll" role="region" aria-label={s('Columns and units')} tabIndex={0}><table><caption>{s("Column types and units apply to every included row; invalid data blocks publication.")}</caption><thead><tr><th>{s("ID / name")}</th><th>{s("Type")}</th><th>{s("Role")}</th><th>{s("Scale")}</th><th>{s("Unit")}</th></tr></thead><tbody>{policy.columns.map((c,i)=><tr key={c.id}><td><code>{c.id}</code> {c.name}</td><td><select aria-label={s('Type') + ': ' + c.name} disabled={busy} value={c.type} onChange={e=>change({columns:policy.columns.map((x,j)=>j===i?{...x,type:e.target.value as typeof c.type}:x)})}>{['text','integer','decimal','real','date','boolean'].map(t=><option key={t}>{t}</option>)}</select></td><td><select aria-label={s('Role') + ': ' + c.name} disabled={busy} value={c.role} onChange={e=>change({columns:policy.columns.map((x,j)=>j===i?{...x,role:e.target.value as typeof c.role}:x)})}>{['identifier','dimension','measure'].map(t=><option key={t}>{t}</option>)}</select></td><td><input aria-label={s('Scale') + ': ' + c.name} type="number" min={0} max={12} disabled={busy||c.type!=='decimal'} value={c.scale} onChange={e=>change({columns:policy.columns.map((x,j)=>j===i?{...x,scale:Number(e.target.value)}:x)})}/></td><td><input aria-label={s('Unit') + ': ' + c.name} value={c.unit} disabled={busy} placeholder={s("JPY, units, percent…")} onChange={e=>change({columns:policy.columns.map((x,j)=>j===i?{...x,unit:e.target.value}:x)})}/></td></tr>)}</tbody></table></div>
    </>}
    <button type="button" className="set-btn" disabled={busy} onClick={()=>{if(!advanced)setRaw(JSON.stringify(policy,null,2));else{try{const draft=JSON.parse(raw);if(!draft||typeof draft!=='object'||!Array.isArray(draft.columns)||!draft.columns.length||!Array.isArray(draft.key)||typeof draft.grain!=='string'||!draft.columns.every((c:unknown)=>c&&typeof c==='object'&&'id' in c&&'name' in c&&'type' in c))throw new Error('Policy JSON must retain the table fields, columns and key arrays.');setPolicy(draft as TablePolicy);setDirty(true)}catch(e){setError(failure(e));return}}setAdvanced(v=>!v);setConfirmed(false)}}>{s(advanced?'Use form':'Advanced policy JSON')}</button>
    {advanced&&<label className="nawa-data-field"><span>{s("Reviewed table policy JSON")}</span><textarea spellCheck={false} className="nawa-data-json" value={raw} disabled={busy} rows={20} onChange={e=>{setRaw(e.target.value);setConfirmed(false);setDirty(true)}}/></label>}

  </div></PanelDialog>
}
export function AnalyticsToolbar({folder,inSidebar=false,onStatus}:{folder:string|null;inSidebar?:boolean;onStatus?(value:string):void}) {
  const { s } = useSidebarText()
  const [recursive,setRecursive]=useState(false), [consent,setConsent]=useState(false)
  const [progress,setProgress]=useState<AnalyticsProgress|null>(null), [busy,setBusy]=useState(false)
  const [error,setError]=useState(''), [datasets,setDatasets]=useState<Dataset[]>([])
  const [reviewDataset,setReviewDataset]=useState<Dataset|null>(null), [clear,setClear]=useState(false)
  const [nextOffset,setNextOffset]=useState<number|null>(null), [total,setTotal]=useState(0)
  const [loading,setLoading]=useState(true), [retry,setRetry]=useState(0)
  const epoch=useRef(0), alive=useRef(true), folderRef=useRef(folder)
  folderRef.current=folder
  const load=useCallback(async(offset=0)=>{
    if(!folder||folderRef.current!==folder)return
    const token=epoch.current
    const catalog=await window.nawaAnalytics.catalog(folder,offset)
    if(alive.current&&token===epoch.current&&folderRef.current===folder){
      setDatasets(old=>offset?[...new Map([...old,...catalog.datasets].map(d=>[d.id,d])).values()]:catalog.datasets)
      setNextOffset(catalog.nextOffset);setTotal(catalog.total)
    }
  },[folder])
  useEffect(()=>{
    alive.current=true;epoch.current++;const token=epoch.current
    setDatasets([]);setNextOffset(null);setTotal(0);setReviewDataset(null);setConsent(false);setClear(false);setError('');setBusy(false);setLoading(true)
    let pending=false, wasRunning=false
    if(!window.nawaAnalytics){setError('Structured data is unavailable. Restart Nawa.');setLoading(false);return}
    const fail=(e:unknown)=>{if(alive.current&&epoch.current===token)setError(failure(e))}
    const poll=()=>{if(pending)return;pending=true;void window.nawaAnalytics.progress().then(p=>{
      if(!alive.current||epoch.current!==token)return
      setProgress(p)
      if(wasRunning&&!p.running)void load().catch(fail)
      wasRunning=p.running
    }).catch(fail).finally(()=>{pending=false})}
    void load().catch(fail).finally(()=>{if(alive.current&&epoch.current===token)setLoading(false)})
    poll();const off=window.nawaAnalytics.onChanged(poll),timer=setInterval(poll,1500)
    return()=>{alive.current=false;off();clearInterval(timer)}
  },[folder,load,retry])
  const running=progress?.running===true
  const status=error?s('Check needs attention'):running?s('Importing…'):loading?s('Loading…'):total?s('{count} tables · {ready} ready',{count:datasets.length,ready:datasets.filter(d=>d.status==='ready').length}):s('No tables imported yet.')
  useEffect(()=>{onStatus?.(status)},[onStatus,status])
  usePanelActivity('ragAnalytics','tables',error?{kind:'error',text:s('Table analysis')+': '+error}:running?{kind:'busy',text:s('Importing…')+' '+(progress?.folder??'')}:null)
  const perform=async(work:()=>Promise<unknown>)=>{if(busy)return;const token=epoch.current;setBusy(true);setError('');try{await work()}catch(e){if(alive.current&&token===epoch.current)setError(failure(e))}finally{if(alive.current&&token===epoch.current)setBusy(false)}}
  if(!folder)return null
  return <section className="nawa-data-toolbar" aria-label={s('Table analysis')} onContextMenu={e=>e.stopPropagation()}>
    <details open={inSidebar||undefined}><summary hidden={inSidebar}>{s('Table analysis')}</summary>
      <p>{s('Import CSV, TSV, JSON, JSONL or Excel files, then review tables before the assistant can analyze them.')}</p>
      <label className="nawa-data-check"><input type="checkbox" disabled={busy||running} checked={recursive} onChange={e=>setRecursive(e.target.checked)}/>{s('Include subdirectories')}</label>
      <label className="nawa-data-check"><input type="checkbox" disabled={busy||running} checked={consent} onChange={e=>setConsent(e.target.checked)}/>{s('I allow file snapshots, table records and analysis results to be stored locally without encryption.')}</label>
      <div className="nawa-data-actions"><button type="button" className="set-btn primary" disabled={busy||running||!consent} onClick={()=>void perform(async()=>{await window.nawaAnalytics.importFolder(folder,recursive,consent);await load()})}>{s('Import / refresh table data')}</button></div>
      <p role="status">{status}</p>
      <button type="button" className="set-btn" disabled={busy||running||loading} onClick={()=>void perform(load)}>{s('Refresh table list')}</button>
      <div className="nawa-data-catalog">{datasets.map(d=><article key={`${d.id}:${d.generation}`}>
        <div className="nawa-data-catalog-heading"><span><strong>{d.name}</strong><br/>{d.sheet||d.kind} · {s(d.status==='ready'?'Ready':'Needs review')}</span><button type="button" className="set-btn" disabled={busy||running} onClick={()=>setReviewDataset(d)}>{s('Review table')}</button></div>
      </article>)}</div>
      {nextOffset!==null&&<button type="button" className="set-btn" disabled={busy||running} onClick={()=>void perform(()=>load(nextOffset!))}>{s('Load more tables')} ({datasets.length}/{total})</button>}
      <details><summary>{s('Manage stored data')}</summary><button type="button" className="set-btn" disabled={busy||running} onClick={()=>setClear(true)}>{s('Clear analytical data')}</button>
        {clear&&<div role="group" aria-label={s('Clear analytical data')}><p>{s('Clear these records? Source files and conversations are kept.')}</p><button type="button" className="set-btn danger" disabled={busy||running} onClick={()=>void perform(async()=>{await window.nawaAnalytics.clear(folder);if(folderRef.current!==folder)return;setClear(false);setDatasets([]);setTotal(0);setNextOffset(null);setReviewDataset(null)})}>{s('Clear')}</button> <button type="button" className="set-btn" onClick={()=>setClear(false)}>{s('Cancel')}</button></div>}
      </details>
    </details>
    {reviewDataset&&<ReviewTable dataset={reviewDataset} onClose={()=>setReviewDataset(null)} onSaved={()=>{if(folderRef.current!==folder)return;setReviewDataset(null);void perform(load)}}/>}
    {running&&<div className="nawa-data-running"><span role="status">{s('Importing…')}<br/>{s('Job directory')}: <bdi>{progress.folder}</bdi><br/>{progress.message}<br/>{s('{scanned} files checked · {rows} records read',{scanned:progress.scanned,rows:progress.rows})}</span><button type="button" className="set-btn" onClick={()=>{void window.nawaAnalytics.cancel().catch(e=>setError(failure(e)))}}>{s('Stop import')}</button></div>}
    {!running&&progress?.folder===folder&&progress.message&&<p role="status">{progress.message}</p>}
    {error&&<div role="alert" className="nawa-data-error"><p>{error}</p><button type="button" className="set-btn" onClick={()=>setRetry(value=>value+1)}>{s('Retry')}</button></div>}
  </section>
}
