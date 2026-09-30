import { app, ipcMain, type WebContents } from 'electron'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import workerPath from './worker?modulePath'
import { ANALYTICS_CHANNEL, ANALYTICS_CHANGED, DEFAULT_ANALYTICS_SETTINGS, type AnalyticsSettings, type AnalyticsProgress, type AnalyticsEnvelope, type AnalyticsReadAction } from '../../shared/analytics-api'
import { authorizePath } from '../directory-actions/file-safety'
import { settings as validateSettings, object, text, list } from './validation'
import type { AnalyticsJob } from './engine'
interface Options { roots():Promise<string[]>;isHomeSender(sender:WebContents):boolean }
interface Active { owner:number;worker:Worker;flag:Int32Array;abort:AbortController;writer:boolean }
interface WorkerSlot { reader:boolean; write:boolean; initialize:boolean }
const initial=():AnalyticsProgress=>({running:false,folder:'',current:'',scanned:0,imported:0,unchanged:0,failed:0,rows:0,message:'',incomplete:false})
/** Scoped preparation and automatic clear-table approval each require saved user consent. */
export class AnalyticsService {
  private directory=join(app.getPath('userData'),'analytics')
  private databasePath=join(this.directory,'data-v1.sqlite3')
  private saved:AnalyticsSettings|null=null
  private clients=new Map<number,WebContents>()
  private active=new Map<string,Active>()
  private requests=new Map<string,{owner:number;abort:AbortController;writer:boolean}>()
  private writer=false
  private readers=0
  private databaseWriter=false
  private databaseReady=false
  private waitingWorkers=new Set<{available():boolean;start():void}>()
  private state=initial()
  private stopped=false
  private saving:Promise<unknown>=Promise.resolve()
  private workerSource:string|null=null
  constructor(private options:Options){
    // Keep this build's worker in memory before a dev rebuild removes its output.
    // A missing startup bundle is retried on request so the workspace can still open.
    try{this.workerSource=readFileSync(workerPath,'utf8')}catch{}
  }
  private changed():void{for(const [id,c]of this.clients){if(c.isDestroyed())this.clients.delete(id);else if(this.options.isHomeSender(c))c.send(ANALYTICS_CHANGED)}}
  track(sender:WebContents):void{
    if(this.clients.has(sender.id))return;this.clients.set(sender.id,sender)
    const revoke=()=>{for(const item of this.requests.values())if(item.owner===sender.id)item.abort.abort();this.clients.delete(sender.id)}
    sender.once('destroyed',revoke);sender.on('render-process-gone',revoke);sender.on('did-start-navigation',(_event,_url,_inPlace,mainFrame)=>{if(mainFrame)revoke()})
  }
  private async config():Promise<AnalyticsSettings>{
    if(this.saved)return this.saved
    try{return this.saved=validateSettings(JSON.parse(await readFile(join(this.directory,'settings-v1.json'),'utf8')))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;return this.saved={...DEFAULT_ANALYTICS_SETTINGS}}
  }
  async settings(){return {settings:await this.config(),databasePath:this.databasePath,backend:'SQLite (local, separate from chat/RAG; no arbitrary SQL endpoint)'}}
  async saveSettings(raw:unknown):Promise<void>{
    const next=validateSettings(raw),save=async()=>{if(this.writer)throw new Error('Finish or cancel the active data import/review before changing its limits.');await mkdir(this.directory,{recursive:true});const tmp=join(this.directory,`settings-${randomUUID()}.tmp`);try{await writeFile(tmp,JSON.stringify(next,null,2),{flag:'wx',mode:0o600});await rename(tmp,join(this.directory,'settings-v1.json'));this.saved=next;this.changed()}finally{await rm(tmp,{force:true}).catch(()=>{})}}
    const done=this.saving.then(save,save);this.saving=done.catch(()=>undefined);await done
  }
  progress():AnalyticsProgress{return {...this.state}}
  cancel(owner:number):void{for(const item of this.requests.values())if(item.owner===owner&&item.writer)item.abort.abort()}
  private async acquireWorker(writer:boolean,writes:boolean,signal:AbortSignal,timeoutMs:number):Promise<WorkerSlot>{
    if(signal.aborted)throw new Error('Analytics request cancelled.')
    // Bootstrap alone. Afterwards WAL metadata readers can overlap one database writer.
    // Queries/analyzes/drill-downs also write, because they persist result receipts.
    const available=()=>!this.databaseReady
      ? !this.databaseWriter&&this.readers===0
      : (writer||this.readers<2)&&(!writes||!this.databaseWriter)
    const reserve=():WorkerSlot=>{
      const slot={reader:!writer,write:writes||!this.databaseReady,initialize:!this.databaseReady}
      if(slot.reader)this.readers++
      if(slot.write)this.databaseWriter=true
      return slot
    }
    if(!this.waitingWorkers.size&&available())return reserve()
    if(this.waitingWorkers.size>=64)throw new Error('Too many queued analytics requests. Please retry shortly.')
    return new Promise<WorkerSlot>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);this.waitingWorkers.delete(waiter)}
      const start=()=>{cleanup();resolve(reserve())}
      const cancel=()=>{cleanup();reject(new Error('Analytics request cancelled.'))}
      const waiter={available,start}
      const timer=setTimeout(()=>{cleanup();reject(new Error('Analytics request timed out waiting for an available worker. Finish the active import/review or retry shortly.'))},timeoutMs)
      this.waitingWorkers.add(waiter)
      signal.addEventListener('abort',cancel,{once:true})
      this.wakeWorkers()
    })
  }
  private wakeWorkers():void{
    for(const waiter of this.waitingWorkers)if(waiter.available())waiter.start()
  }
  private releaseWorker(slot:WorkerSlot):void{
    if(slot.reader)this.readers--
    if(slot.write)this.databaseWriter=false
    this.wakeWorkers()
  }
  async request(owner:number,job:AnalyticsJob,signal?:AbortSignal):Promise<unknown>{
    const writer=['import','review','clear','prepare','propose-policy','export-sqlite'].includes(job.action)
    const writes=writer||['query','sql','analyze','drill'].includes(job.action)
    if(this.stopped||signal?.aborted)throw new Error('Analytics request cancelled.')
    if(writer&&this.writer)throw new Error('Another data import/review is running.')
    if(Buffer.byteLength(JSON.stringify(job))>256000)throw new Error('Analytics request is too large.')
    if(writer)this.writer=true
    const id=randomUUID(),abort=new AbortController(),forward=()=>abort.abort()
    signal?.addEventListener('abort',forward,{once:true})
    this.requests.set(id,{owner,abort,writer})
    let worker:Worker|undefined
    let slot:WorkerSlot|undefined
    try{
      const config=await this.config()
      slot=await this.acquireWorker(writer,writes,abort.signal,config.queryTimeoutSeconds*1000)
      if(this.stopped||abort.signal.aborted)throw new Error('Analytics request cancelled.')
      const roots=await this.options.roots()
      if(job.folder)await authorizePath(roots,job.folder)
      for(const path of job.paths??[])await authorizePath(roots,job.action==='statuses'||job.action==='discover'?dirname(path):path)
      if(this.stopped||abort.signal.aborted)throw new Error('Analytics request cancelled.')
      const buffer=new SharedArrayBuffer(4),flag=new Int32Array(buffer)
      const source=this.workerSource??=readFileSync(workerPath,'utf8')
      const effectiveSettings=job.preparationAuthorized?{...config,allowAgentPreparation:true,allowAgentApproval:job.action!=='prepare'}:config
      worker=new Worker(source,{eval:true,workerData:{databasePath:this.databasePath,roots,settings:effectiveSettings,job,cancel:buffer,deadline:Date.now()+(writer?24*3600*1000:config.queryTimeoutSeconds*1000),storeOptions:{readOnly:!slot.write,initialize:slot.initialize}},resourceLimits:{maxOldGenerationSizeMb:512}})
      this.active.set(id,{owner,worker,flag,abort,writer})
      if(writer){this.state={...initial(),running:true,folder:job.folder??'',message:job.action==='review'?'Validating the approved table policy…':'Preparing local structured-data import…'};this.changed()}
      const current=worker
      const result=await new Promise<unknown>((resolve,reject)=>{
        let ended=false,lastActivity=Date.now(),checking=false,killer:ReturnType<typeof setTimeout>|undefined
        const finish=(error?:Error,value?:unknown)=>{if(ended)return;ended=true;clearInterval(watch);clearTimeout(deadline);clearTimeout(killer);current.off('message',onMessage);current.off('error',onError);current.off('exit',onExit);abort.signal.removeEventListener('abort',onAbort);if(error)reject(error);else resolve(value)}
        const terminate=(error:Error)=>{Atomics.store(flag,0,1);void current.terminate();finish(error)}
        const onError=(error:Error)=>finish(error)
        const onExit=(code:number)=>finish(new Error(`Analytics worker exited (${code}). Completed generations remain stored; retry the operation.`))
        const onAbort=()=>{Atomics.store(flag,0,1);killer??=setTimeout(()=>terminate(new Error('Analytics request cancelled. Interrupted imports require retry.')),2500)}
        const onMessage=(raw:{ready?:boolean;heartbeat?:boolean;progress?:AnalyticsProgress;error?:string;result?:unknown})=>{
          lastActivity=Date.now()
          if(raw.ready){if(slot?.initialize){this.databaseReady=true;this.wakeWorkers()}return}
          if(raw.heartbeat)return
          if(raw.progress){if(writer){this.state={...raw.progress,running:true,folder:job.folder??this.state.folder};this.changed()}return}
          if(abort.signal.aborted){finish(new Error('Analytics request cancelled.'));return}
          finish(raw.error?new Error(raw.error):undefined,raw.result)
        }
        const watch=setInterval(()=>{
          if(writer&&Date.now()-lastActivity>120000){terminate(new Error('Data import stopped reporting progress. Narrow the source and retry.'));return}
          if(checking)return;checking=true
          void this.options.roots().then(now=>{if(roots.some(root=>!now.includes(root)))abort.abort()},()=>abort.abort()).finally(()=>{checking=false})
        },750)
        const deadline=setTimeout(()=>terminate(new Error('Analytics request exceeded its time budget. Narrow the query or raise its explicit setting.')),writer?24*3600*1000:config.queryTimeoutSeconds*1000+1500)
        current.on('message',onMessage);current.once('error',onError);current.once('exit',onExit);abort.signal.addEventListener('abort',onAbort,{once:true})
        if(abort.signal.aborted)onAbort()
      })
      if(abort.signal.aborted||signal?.aborted)throw new Error('Analytics request cancelled.')
      const now=await this.options.roots()
      if(roots.some(root=>!now.includes(root)))throw new Error('Workspace permissions changed during the operation.')
      if(job.folder)await authorizePath(now,job.folder)
      for(const source of (result as AnalyticsEnvelope|undefined)?.sources??[])await authorizePath(now,source.path)
      return result
    }finally{
      signal?.removeEventListener('abort',forward);this.requests.delete(id);this.active.delete(id);if(worker)await worker.terminate().catch(()=>undefined)
      if(writer){this.writer=false;this.state={...this.state,running:false};this.changed()}
      if(slot)this.releaseWorker(slot)
    }
  }
  async selected(owner:number,paths:string[],action:AnalyticsReadAction,payload:unknown,signal:AbortSignal,preparation?:{folder:string;reviewedDatasets:{datasetId:string;generation:string}[]}):Promise<AnalyticsEnvelope>{
    if(!['discover','describe','query','sql','analyze','result','drill','verify','prepare','propose-policy','export-sqlite'].includes(action))throw new Error('Direct review/clearing is user-controlled. Use Prepare & export for agent preparation and SQLite export.')
    if(action==='export-sqlite'&&!preparation)throw new Error('Use Prepare & export to authorize a SQLite export.')
    if((action==='prepare'||action==='propose-policy')&&!preparation&&!(await this.config()).allowAgentPreparation)throw new Error('Click Prepare & export to prepare and review selected files with the agent. Source snapshots and table data will be stored locally without encryption.')
    return await this.request(owner,{action,paths,payload,...(preparation?{folder:preparation.folder,preparationAuthorized:true,reviewedDatasets:preparation.reviewedDatasets}:{})},signal) as AnalyticsEnvelope
  }
  stop():void{this.stopped=true;for(const item of this.requests.values())item.abort.abort();for(const item of this.active.values()){Atomics.store(item.flag,0,1);void item.worker.terminate()}this.active.clear()}
}
export function registerAnalyticsIpc(options:Options):AnalyticsService{
  const service=new AnalyticsService(options)
  ipcMain.handle(ANALYTICS_CHANNEL,async(event,action:unknown,...args:unknown[])=>{
    if(event.senderFrame!==event.sender.mainFrame||!options.isHomeSender(event.sender))throw new Error('Structured data access is available only from the Nawa workspace.')
    service.track(event.sender);const owner=event.sender.id
    switch(action){
      case'settings':return service.settings()
      case'saveSettings':return service.saveSettings(args[0])
      case'progress':return service.progress()
      case'cancel':return service.cancel(owner)
      case'import':if(args[2]!==true)throw new Error('Confirm local snapshot/text storage before importing.');return service.request(owner,{action:'import',folder:text(args[0],'folder',4096),recursive:args[1]===true})
      case'catalog':return service.request(owner,{action:'catalog',folder:text(args[0],'folder',4096),payload:{offset:args[1]??0}})
      case'clear':return service.request(owner,{action:'clear',folder:text(args[0],'folder',4096)})
      case'statuses':return service.request(owner,{action:'statuses',paths:list(args[0],'visible paths',256).map(v=>text(v,'path',4096)),verify:args[1]===true})
      case'review':return service.request(owner,{action:'review',payload:{datasetId:text(args[0],'dataset ID'),expectedGeneration:text(args[1],'generation'),policy:object(args[2],'policy')}})
      default:throw new Error('Unknown user analytics action. Agent reads must go through its selected-file run.')
    }
  })
  app.once('before-quit',()=>service.stop());return service
}
