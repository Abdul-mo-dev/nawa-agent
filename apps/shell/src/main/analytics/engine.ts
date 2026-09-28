import { mkdir, opendir, lstat, rm } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import type { AnalyticsEnvelope, AnalyticsSettings, AnalyticsProgress, AnalyticsFileStatus, SourceRef, AnalyticsResult, Dataset } from '../../shared/analytics-api'
import { authorizePath, regularFile, hashFile, samePath, within } from '../directory-actions/file-safety'
import { AnalyticsStore, type StoreOptions } from './store'
import { approveDataset, importFile } from './importer'
import { TABLE_EXTENSIONS } from './readers'
import { QuerySession } from './query'
import { analyze } from './statistics'
import { object, text, list, int, message } from './validation'
export interface AnalyticsJob { action:string; folder?:string; paths?:string[]; recursive?:boolean; verify?:boolean; payload?:unknown }
export const emptyProgress=():AnalyticsProgress=>({running:false,folder:'',current:'',scanned:0,imported:0,unchanged:0,failed:0,rows:0,message:'',incomplete:false})
export class AnalyticsEngine {
  readonly store:AnalyticsStore
  constructor(readonly databasePath:string,readonly roots:string[],readonly settings:AnalyticsSettings,readonly check:()=>void,readonly progress:(p:AnalyticsProgress)=>void=()=>{},storeOptions:StoreOptions={}){this.store=new AnalyticsStore(databasePath,storeOptions)}
  close():void{this.store.close()}
  private selected(paths:string[],path:string):boolean{return paths.some(p=>samePath(p,path))}
  async verify(sources:SourceRef[],paths:string[]):Promise<void>{
    const hashes=new Map<string,string>()
    for(const source of sources){
      this.check();if(!this.selected(paths,source.path))throw new Error('Analytical evidence is no longer in the selected-file scope.')
      const d=this.store.dataset(source.datasetId)
      if(!d||d.data.generation!==source.generation||d.data.sourceHash!==source.hash)throw new Error('Analytical source generation changed. Run the analysis again.')
      const f=this.store.file(source.path);if(!f||!['needs-review','ready'].includes(f.state))throw new Error('Analytical source is being refreshed or failed import. Retry after it is ready.')
      await regularFile(this.roots,source.path,this.settings.maxFileMiB*1048576)
      let actual=hashes.get(source.path);if(!actual){actual=await hashFile(source.path);hashes.set(source.path,actual)}
      if(actual!==source.hash)throw new Error('A source file changed after import. Re-import and review it before using these statistics.')
    }
  }
  async statuses(paths:string[],verify:boolean):Promise<AnalyticsFileStatus[]>{
    const out:AnalyticsFileStatus[]=[]
    for(const path of paths){
      this.check()
      try{
        await authorizePath(this.roots,dirname(path))
        if(!TABLE_EXTENSIONS.has(extname(path).toLowerCase())){out.push({path,state:'unsupported',tables:0,rows:0,message:'No validated table adapter; narrative RAG/native inspection remains separate.'});continue}
        const f=this.store.file(path),datasets=this.store.datasets([path])
        if(!f){out.push({path,state:'not-imported',tables:0,rows:0,message:'Import for structured analysis. Embedding is not required.'});continue}
        const stat=await lstat(path)
        let state=f.state as AnalyticsFileStatus['state'],reason=f.error
        if(!stat.isFile())throw new Error('Source is no longer a regular file.')
        if(!['importing','failed'].includes(state)){
          if(stat.size!==f.size||stat.mtimeMs!==f.mtime||stat.ctimeMs!==f.ctime)state='changed'
          if(verify){await regularFile(this.roots,path,this.settings.maxFileMiB*1048576);state=await hashFile(path)===f.hash?f.state as AnalyticsFileStatus['state']:'changed'}
        }
        if(state==='changed')reason='Source fingerprint/metadata changed. Re-import and review before analysis.'
        out.push({path,state,tables:datasets.length,rows:datasets.reduce((n,d)=>n+d.data.rows,0),message:reason||'Approved table policy; read-only analytics available.',sourceHash:f.hash})
      }catch(e){out.push({path,state:'failed',tables:0,rows:0,message:message(e)})}
    }
    return out
  }
  private async folderPaths(folder:string):Promise<string[]>{await authorizePath(this.roots,folder);return this.store.files().filter(f=>within(folder,f.path)).map(f=>f.path)}
  async importFolder(folder:string,recursive:boolean):Promise<AnalyticsProgress>{
    this.store.recover();await rm(join(dirname(this.databasePath),'staging'),{recursive:true,force:true})
    await authorizePath(this.roots,folder)
    const state={...emptyProgress(),running:true,folder},seen=new Set<string>();let entries=0
    const send=()=>this.progress({...state})
    const walk=async(dir:string,depth:number):Promise<void>=>{
      this.check();if(depth>32){state.incomplete=true;return}await authorizePath(this.roots,dir)
      try{
        for await(const entry of await opendir(dir)){
          this.check();if(++entries>200000){state.incomplete=true;return}
          if(entry.name.startsWith('.')||entry.name.startsWith('~$')||['node_modules','__macosx'].includes(entry.name.toLowerCase()))continue
          const path=join(dir,entry.name)
          if(entry.isSymbolicLink())continue
          if(entry.isDirectory()){if(recursive)await walk(path,depth+1);continue}
          if(!entry.isFile()||!TABLE_EXTENSIONS.has(extname(path).toLowerCase()))continue
          seen.add(path);state.scanned++;state.current=path;state.message='Reading a private saved-file snapshot';send()
          let priorRows=0
          try{const result=await importFile(this.store,path,this.roots,this.settings,this.check,rows=>{state.rows+=rows-priorRows;priorRows=rows;state.message=`Imported ${rows.toLocaleString()} records; validating table structure`;send()});result==='unchanged'?state.unchanged++:state.imported++}
          catch(e){state.failed++;state.message=message(e);send();this.check()}
        }
      }catch(e){this.check();state.incomplete=true;state.message=`Some directory entries could not be read: ${message(e)}`;send()}
    }
    try{
      await walk(folder,0);this.check()
      if(!state.incomplete){const gone=this.store.files().filter(f=>within(folder,f.path)&&(recursive||samePath(dirname(f.path),folder))&&!seen.has(f.path)).map(f=>f.path);this.store.clear(gone)}
      state.message=`${state.imported} imported, ${state.unchanged} unchanged, ${state.failed} failed. Review imported tables before querying.${state.incomplete?' Enumeration incomplete; unseen records were not pruned.':''}`
    }finally{state.running=false;send()}
    return state
  }
  async execute(job:AnalyticsJob):Promise<unknown>{
    this.check()
    if(job.action==='import'){if(!job.folder)throw new Error('Choose an opened directory.');return this.importFolder(job.folder,job.recursive===true)}
    if(job.action==='statuses')return this.statuses(job.paths??[],job.verify===true)
    if(job.action==='catalog'){
      if(!job.folder)throw new Error('Choose a directory.')
      const paths=await this.folderPaths(job.folder),all=this.store.datasets(paths).sort((a,b)=>a.data.path.localeCompare(b.data.path)||a.data.name.localeCompare(b.data.name)),offset=int(object(job.payload??{}).offset??0,'catalog offset',0,1000000)
      const datasets=all.slice(offset,offset+20).map(d=>d.data)
      while(Buffer.byteLength(JSON.stringify(datasets))>2*1024*1024&&datasets.length>1)datasets.pop()
      return {datasets,files:await this.statuses(paths.slice(0,256),false),truncated:offset+datasets.length<all.length||paths.length>256,total:all.length,nextOffset:offset+datasets.length<all.length?offset+datasets.length:null}
    }
    if(job.action==='review'){
      this.store.recover();const r=object(job.payload),id=text(r.datasetId,'dataset ID'),generation=text(r.expectedGeneration,'expected generation')
      return approveDataset(this.store,id,generation,r.policy,this.roots,this.settings,this.check,rows=>this.progress({...emptyProgress(),running:true,current:id,rows,message:`Validating ${rows.toLocaleString()} rows against the approved schema`}))
    }
    if(job.action==='clear'){
      if(!job.folder)throw new Error('Choose a directory.');this.store.recover();this.store.clear(await this.folderPaths(job.folder));return {cleared:true,sourceFilesDeleted:false,chatsDeleted:false}
    }
    const paths=job.paths??[]
    if(paths.length>256)throw new Error('At most 256 selected files can participate in one analysis.')
    if(job.action==='verify'){
      const sources=list(object(job.payload).sources,'source evidence',2048) as unknown as SourceRef[]
      await this.verify(sources,paths);return {value:{verified:true},sources:[]} satisfies AnalyticsEnvelope
    }
    if(job.action==='discover'){
      const r=object(job.payload??{}),query=text(r.query??'','catalog query',256,true).normalize('NFKC').toLowerCase()
      const offset=r.offset===undefined?0:int(r.offset,'catalog offset',0,1000000)
      const all=this.store.datasets().filter(d=>this.selected(paths,d.data.path)),statuses=await this.statuses(paths,false)
      const filtered=all.filter(d=>!query||[d.data.name,d.data.sheet,d.data.path,d.data.policy.description,...d.data.policy.columns.map(c=>`${c.name} ${c.description}`)].join(' ').normalize('NFKC').toLowerCase().includes(query))
      const page=filtered.slice(offset,offset+25),sources:SourceRef[]=[]
      const datasets=[]
      for(const entry of page){const d=entry.data;try{const ref={path:d.path,hash:d.sourceHash,datasetId:d.id,generation:d.generation};await this.verify([ref],paths);sources.push(ref);datasets.push({id:d.id,path:d.path,sourceHash:d.sourceHash,generation:d.generation,name:d.name,sheet:d.sheet,range:d.range,status:d.status,rows:d.rows,grain:d.policy.grain,columns:d.policy.columns.slice(0,12).map(c=>({id:c.id,name:c.name,type:c.type,unit:c.unit})),totalColumns:d.policy.columns.length,moreColumns:d.policy.columns.length>12,warnings:d.warnings})}catch(e){datasets.push({id:d.id,path:d.path,status:'unavailable',reason:message(e)})}}
      while(Buffer.byteLength(JSON.stringify(datasets))>40000&&datasets.length>1)datasets.pop()
      const returnedIds=new Set(datasets.map(d=>d.id)),returnedSources=sources.filter(s=>returnedIds.has(s.datasetId))
      const fileOffset=r.fileOffset===undefined?0:int(r.fileOffset,'selected file offset',0,256),selectedFiles=statuses.slice(fileOffset,fileOffset+16)
      const value={datasets,total:filtered.length,nextOffset:offset+datasets.length<filtered.length?offset+datasets.length:null,selectedFiles,selectedFileCount:statuses.length,nextFileOffset:null as number|null,scope:'Only individually selected files. Query without a filter and follow nextOffset and nextFileOffset before claiming coverage of all selected sources.'}
      while(Buffer.byteLength(JSON.stringify(value))>55000&&selectedFiles.length>1)selectedFiles.pop()
      value.nextFileOffset=fileOffset+selectedFiles.length<statuses.length?fileOffset+selectedFiles.length:null
      if(Buffer.byteLength(JSON.stringify(value))>64000)throw new Error('Dataset catalog metadata exceeds the tool budget. Select fewer sources.')
      return {value,sources:returnedSources} satisfies AnalyticsEnvelope
    }
    if(job.action==='describe'){
      const r=object(job.payload),d=this.store.dataset(text(r.datasetId,'dataset ID'))
      if(!d||!this.selected(paths,d.data.path))throw new Error('Dataset is not in the selected scope.')
      const sources=[{path:d.data.path,hash:d.data.sourceHash,datasetId:d.data.id,generation:d.data.generation}];await this.verify(sources,paths)
      const offset=r.columnOffset===undefined?0:int(r.columnOffset,'column offset',0,1024),limit=r.columnLimit===undefined?32:int(r.columnLimit,'column limit',1,64)
      const columns=d.data.policy.columns.slice(offset,offset+limit)
      while(Buffer.byteLength(JSON.stringify(columns))>24000&&columns.length>1)columns.pop()
      const value={...d.data,policy:{...d.data.policy,columns,skipRows:d.data.policy.skipRows.slice(0,100)},excludedRowListTruncated:d.data.policy.skipRows.length>100,explicitExcludedRowCount:d.data.policy.skipRows.length,profile:{...d.data.profile,columns:undefined},totalColumns:d.data.policy.columns.length,nextColumnOffset:offset+columns.length<d.data.policy.columns.length?offset+columns.length:null,
        preview:d.data.preview.slice(0,3).map(row=>({...row,values:row.values.slice(offset,offset+Math.min(16,columns.length))})),previewIsSample:true,previewColumnOffset:offset,previewTruncated:d.data.preview.length>3||d.data.policy.columns.length>16}
      return {value,sources} satisfies AnalyticsEnvelope
    }
    if(job.action==='result'||job.action==='drill'){
      const r=object(job.payload),result=this.store.result(text(r.resultId,'result ID',100))
      if(!result)throw new Error('Result receipt is unavailable or was removed by retention/clear.')
      await this.verify(result.sources,paths)
      if(job.action==='result')return {value:result,sources:result.sources} satisfies AnalyticsEnvelope
      const original=object(result.request,'original analysis request')
      if(result.operation!=='query')throw new Error('For statistical drill-down, query the described source dataset with the original filters.')
      const filters=[...list(original.filters??[],'original filters'),...list(r.filters??[],'drill filters')]
      job={action:'query',paths,payload:{datasetIds:original.datasetIds,join:original.join,filters,columns:r.columns,limit:r.limit}}
    }
    if(job.action==='query'||job.action==='analyze'){
      if(job.action==='analyze'&&object(job.payload).join!==undefined)throw new Error('Statistical methods do not accept joins. Use query_data for validated joins.')
      const session=new QuerySession(this.store,paths,this.settings,this.check)
      let result:AnalyticsResult
      try{
        const relation=session.relation(job.payload);await this.verify(relation.sources,paths)
        result=job.action==='query'?session.execute(job.payload):analyze(session,job.payload)
      }finally{session.close()}
      await this.verify(result.sources,paths);this.check()
      // Only output is bounded. Every aggregate/statistic above ran over its complete filtered population.
      let truncatedCells=0
      result.rows=result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{if(typeof value==='string'&&value.length>2000){truncatedCells++;return[key,{preview:value.slice(0,2000),characters:value.length,truncated:true}]}return[key,value]})))
      if(truncatedCells)result.warnings.push(`${truncatedCells} displayed text cells were shortened. Numeric/statistical inputs were not truncated.`)
      while(Buffer.byteLength(JSON.stringify(result))>48000&&result.rows.length){result.rows.pop();result.outputTruncated=true}
      result.displayedRows=result.rows.length
      if(Buffer.byteLength(JSON.stringify(result))>64000)throw new Error('Analysis metadata exceeds the tool-output budget. Use fewer datasets/columns.')
      this.store.saveResult(result,this.settings.retainedResults)
      return {value:result,sources:result.sources} satisfies AnalyticsEnvelope
    }
    throw new Error('Unknown analytics action. No SQL, shell or arbitrary code execution is available.')
  }
}
