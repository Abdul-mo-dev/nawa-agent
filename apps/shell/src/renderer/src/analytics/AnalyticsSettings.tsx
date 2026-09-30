import { useEffect, useState } from 'react'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { usePanelActivity } from '../explorer/panel-state'
import { DEFAULT_ANALYTICS_SETTINGS, type AnalyticsSettings as Settings } from '../../../shared/analytics-api'
import './analytics.css'
const fields:Array<{key:Exclude<keyof Settings,'allowAgentPreparation'|'allowAgentApproval'>;label:string;min:number;max:number;help:string}>=[
  {key:'maxFileMiB',label:'Maximum source file size (MiB)',min:1,max:8192,help:'Streaming import; saved source snapshots also need disk space. XLSX ZIP64 remains unsupported.'},
  {key:'maxRows',label:'Maximum records per source file',min:1,max:10000000,help:'A limit failure is not published as a partially complete dataset.'},
  {key:'maxColumns',label:'Maximum columns per table',min:1,max:1024,help:'Narrow or export exceptionally wide sheets before analysis.'},
  {key:'queryTimeoutSeconds',label:'Read/query time budget (seconds)',min:5,max:600,help:'Includes freshness verification. Expensive requests can be cancelled by the worker supervisor.'},
  {key:'maxGroups',label:'Maximum computed result groups',min:100,max:100000,help:'A high-cardinality query fails explicitly rather than sampling its input.'},
  {key:'resultRows',label:'Maximum displayed result rows',min:1,max:500,help:'Only output is limited; aggregates still process the full approved filtered population.'},
  {key:'retainedResults',label:'Retained analysis receipts',min:10,max:10000,help:'Receipts contain SQL, parameters, results and source versions. Older receipts expire beyond this count.'},
]
export function AnalyticsSettings({compact=false}:{compact?:boolean}={}){
  const { s } = useSidebarText()
  const [baseline,setBaseline]=useState<Settings|null>(null),[retry,setRetry]=useState(0)
  const [value,setValue]=useState<Settings>({...DEFAULT_ANALYTICS_SETTINGS}),[database,setDatabase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[loading,setLoading]=useState(true)
  const dirty=!!baseline&&JSON.stringify(value)!==JSON.stringify(baseline)
  usePanelActivity('ragAnalytics','analysis-settings',error?{kind:'error',text:error}:dirty?{kind:'unsaved',text:s('Unsaved analysis settings')}:null)
  useEffect(()=>{let live=true;setError('');setLoading(true);if(!window.nawaAnalytics){setError('Analytics bridge unavailable. Rebuild and restart.');setLoading(false);return}void window.nawaAnalytics.settings().then(r=>{if(live){setValue(r.settings);setBaseline(r.settings);setDatabase(r.databasePath)}}).catch(e=>{if(live)setError(String(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[retry])
  const save=async()=>{setBusy(true);setError('');setSaved(false);try{await window.nawaAnalytics.saveSettings(value);setBaseline(value);setSaved(true)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  if(!baseline)return <div><p role={error?'alert':'status'}>{error||s('Loading…')}</p>{error&&<button type="button" className="set-btn" onClick={()=>setRetry(value=>value+1)}>{s('Retry')}</button>}</div>
  return <div className={`nawa-data-settings${compact?' is-compact':''}`}><h3 className="set-pane-title">{s("Structured Data Analysis")}</h3>
    <p hidden={compact}>{s('Set limits for local table imports and analysis. Choose manual review or automatic approval of clear tables.')}</p>
    <label className="nawa-data-check"><input type="checkbox" disabled={busy||loading} checked={value.allowAgentPreparation} onChange={e=>{const enabled=e.target.checked;setSaved(false);setValue(v=>({...v,allowAgentPreparation:enabled,allowAgentApproval:enabled?v.allowAgentApproval:false}))}}/>{s('Allow agent preparation')}</label>
    <p>{s('The assistant may import individually selected files and prepare table policies. File snapshots, table records and analysis results are stored locally without encryption.')}</p>
    <label className="nawa-data-check"><input type="checkbox" disabled={busy||loading||!value.allowAgentPreparation} checked={value.allowAgentApproval} onChange={e=>{setSaved(false);setValue(v=>({...v,allowAgentApproval:e.target.checked}))}}/>{s('Automatically approve clear tables')}</label>
    <p>{s('Clear tables become Ready after every included row is validated. Formulas, hidden rows, possible subtotals and changed row ranges remain for review. Unknown units stay unspecified. With this setting off, you approve each draft manually.')}</p>
    <div className="nawa-data-settings-grid">{fields.map(f=><label className="nawa-data-field" key={f.key}><span>{s(f.label)}</span><input className="set-input" type="number" min={f.min} max={f.max} step={1} disabled={busy||loading} value={Number.isNaN(value[f.key])?'':value[f.key]} onChange={e=>{setSaved(false);setValue(v=>({...v,[f.key]:Number(e.target.value)}))}}/><small>{s(f.help)}</small></label>)}</div>
    <details><summary>{s('Storage details')}</summary><p>{s('Source snapshots, tables and analysis results are stored locally without encryption. Clearing analysis data keeps source files, conversations and search indexes.')}</p><p className="nawa-data-path">{s('Database')}: <code>{database}</code></p></details>
    <div className="nawa-settings-footer">{dirty&&<p role="status">{s('Unsaved changes')}</p>}
    <button type="button" className="set-btn" disabled={busy||!dirty} onClick={()=>{setValue(baseline);setError('');setSaved(false)}}>{s('Discard changes')}</button>
    <button type="button" className="set-btn primary" disabled={busy||loading||!dirty} onClick={()=>void save()}>{s(busy?'Saving…':'Save analytics settings')}</button>
    {saved&&<p role="status">{s("Analytics settings saved. Embedding settings were not changed.")}</p>}{error&&<p role="alert" className="nawa-data-error">{error}</p>}
    </div></div>
}
