import { useEffect, useState } from 'react'
import type { AnalyticsFileStatus } from '../../../shared/analytics-api'
import './analytics.css'
export function useAnalyticsStatuses(files:Array<{path:string;mtimeMs:number;sizeBytes:number}>){
  const key=JSON.stringify(files.map(f=>[f.path,f.mtimeMs,f.sizeBytes]))
  const [statuses,setStatuses]=useState<Record<string,AnalyticsFileStatus>>({}),[error,setError]=useState('')
  useEffect(()=>{
    let live=true,pending=false,force=true,again=false,timer:ReturnType<typeof setTimeout>|undefined
    const paths=(JSON.parse(key) as [string,number,number][]).map(r=>r[0]).slice(0,256)
    setStatuses({});setError('')
    if(!window.nawaAnalytics){setError('Rebuild and restart the shell/preload to enable structured analytics.');return}
    const refresh=async()=>{if(!live||!paths.length)return;if(pending){again=true;return}pending=true;const verify=force;force=false
      try{const values=await window.nawaAnalytics.statuses(paths,verify);if(live){setStatuses(Object.fromEntries(values.map(v=>[v.path,v])));setError('')}}catch(e){if(live)setError(e instanceof Error?e.message:String(e))}
      finally{pending=false;if(again&&live){again=false;schedule()}}
    }
    const schedule=()=>{if(timer)return;timer=setTimeout(()=>{timer=undefined;void refresh()},500)}
    const verify=()=>{force=true;schedule()}
    const off=window.nawaAnalytics.onChanged(schedule),offFiles=window.aiOffice.onFolderChanged(verify)
    window.addEventListener('focus',verify);const interval=setInterval(schedule,10000);void refresh()
    return()=>{live=false;clearTimeout(timer);clearInterval(interval);off();offFiles();window.removeEventListener('focus',verify)}
  },[key])
  return {statuses,error}
}
export function AnalyticsBadge({value,error}:{value?:AnalyticsFileStatus;error?:string}){
  const labels:Record<AnalyticsFileStatus['state'],string>={'not-imported':'Data: not imported',importing:'Data: importing…','needs-review':'Data: review needed',ready:'Data: ready',changed:'Data: changed',failed:'Data: failed',unsupported:'Data: no adapter'}
  const label=error?'Data: unavailable':value?labels[value.state]:'Data: checking…'
  const title=[label,error||value?.message,value?`${value.tables} tables · ${value.rows.toLocaleString()} approved rows`:'',value?.sourceHash?`Source SHA-256: ${value.sourceHash}`:''].filter(Boolean).join('\n')
  return <span className={`nawa-data-badge is-${error?'failed':value?.state??'checking'}`} title={title} aria-label={title}>{value?.state==='ready'?'✓ ':''}{label}</span>
}
