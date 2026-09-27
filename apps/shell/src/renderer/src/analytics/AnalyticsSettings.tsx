import { useEffect, useState } from 'react'
import { DEFAULT_ANALYTICS_SETTINGS, type AnalyticsSettings as Settings } from '../../../shared/analytics-api'
import './analytics.css'
const fields:Array<{key:keyof Settings;label:string;min:number;max:number;help:string}>=[
  {key:'maxFileMiB',label:'Maximum source file size (MiB)',min:1,max:8192,help:'Streaming import; saved source snapshots also need disk space. XLSX ZIP64 remains unsupported.'},
  {key:'maxRows',label:'Maximum records per source file',min:1,max:10000000,help:'A limit failure is not published as a partially complete dataset.'},
  {key:'maxColumns',label:'Maximum columns per table',min:1,max:1024,help:'Narrow or export exceptionally wide sheets before analysis.'},
  {key:'queryTimeoutSeconds',label:'Read/query time budget (seconds)',min:5,max:600,help:'Includes freshness verification. Expensive requests can be cancelled by the worker supervisor.'},
  {key:'maxGroups',label:'Maximum computed result groups',min:100,max:100000,help:'A high-cardinality query fails explicitly rather than sampling its input.'},
  {key:'resultRows',label:'Maximum displayed result rows',min:1,max:500,help:'Only output is limited; aggregates still process the full approved filtered population.'},
  {key:'retainedResults',label:'Retained analysis receipts',min:10,max:10000,help:'Receipts contain SQL, parameters, results and source versions. Older receipts expire beyond this count.'},
]
export function AnalyticsSettings(){
  const [value,setValue]=useState<Settings>({...DEFAULT_ANALYTICS_SETTINGS}),[database,setDatabase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[loading,setLoading]=useState(true)
  useEffect(()=>{let live=true;if(!window.nawaAnalytics){setError('Analytics bridge unavailable. Rebuild and restart.');setLoading(false);return}void window.nawaAnalytics.settings().then(r=>{if(live){setValue(r.settings);setDatabase(r.databasePath)}}).catch(e=>{if(live)setError(String(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[])
  const save=async()=>{setBusy(true);setError('');setSaved(false);try{await window.nawaAnalytics.saveSettings(value);setSaved(true)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  return <div className="nawa-data-settings"><h3 className="set-pane-title">Structured Data Analysis</h3>
    <p>Local SQLite tables for exact aggregation and reproducible statistics, alongside—not inside—conversation history or the RAG index. No database server, embedding request, Docker or Python service is required for importing/querying tables.</p>
    <p>Supported analytical imports: CSV, TSV, JSON arrays of objects, JSONL/NDJSON, XLSX and XLSM. Review each table’s range, row grain, types, keys, units and formula policy before the agent can query it. PDF and narrative RAG are not validated table imports.</p>
    <div className="nawa-data-settings-grid">{fields.map(f=><label className="nawa-data-field" key={f.key}><span>{f.label}</span><input className="set-input" type="number" min={f.min} max={f.max} step={1} disabled={busy||loading} value={Number.isNaN(value[f.key])?'':value[f.key]} onChange={e=>{setSaved(false);setValue(v=>({...v,[f.key]:Number(e.target.value)}))}}/><small>{f.help}</small></label>)}</div>
    <p>SQL access is generated from validated structured requests. The agent cannot submit arbitrary SQL, change a schema, approve data, load extensions, attach databases, or read your chat-history database through these tools.</p>
    <p>Source snapshots, raw records, approved tables and analysis receipts are stored unencrypted locally. Clearing a directory’s analytical data removes those records and related receipts, but not source files, chats or RAG embeddings. Logical deletion is not secure physical erasure.</p>
    <p className="nawa-data-path">Database: <code>{database||'Loading…'}</code></p>
    <button type="button" className="set-btn primary" disabled={busy||loading} onClick={()=>void save()}>Save analytics settings</button>
    {saved&&<p role="status">Analytics settings saved. Embedding settings were not changed.</p>}{error&&<p role="alert" className="nawa-data-error">{error}</p>}
  </div>
}
