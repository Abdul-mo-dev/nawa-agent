import { opendir, lstat, rm } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import type { AnalyticsEnvelope, AnalyticsSettings, AnalyticsProgress, AnalyticsFileStatus, SourceRef, AnalyticsResult, AnalyticsPreparationSummary } from '../../shared/analytics-api'
import { authorizePath, regularFile, hashFile, samePath, within } from '../directory-actions/file-safety'
import { AnalyticsStore, type StoreOptions } from './store'
import { approveDataset, approveDatasetByAgent, importFile, validateDatasetPolicy } from './importer'
import { automaticApprovalIssues, baselinePolicy, mergePolicy, preparationNotes, preparationTargets, suggestedPolicy } from './preparation'
import { TABLE_EXTENSIONS } from './readers'
import { QuerySession } from './query'
import { analyze } from './statistics'
import { object, text, list, int, message } from './validation'
import { exportReadyTables } from './export'
import { executeSql } from './sql'
export interface AnalyticsJob { action:string; folder?:string; paths?:string[]; recursive?:boolean; verify?:boolean; payload?:unknown; preparationAuthorized?:boolean; reviewedDatasets?:{datasetId:string;generation:string}[] }
export const emptyProgress=():AnalyticsProgress=>({running:false,folder:'',current:'',scanned:0,imported:0,unchanged:0,failed:0,rows:0,message:'',incomplete:false})
export class AnalyticsEngine {
  readonly store:AnalyticsStore
  constructor(readonly databasePath:string,readonly roots:string[],readonly settings:AnalyticsSettings,readonly check:()=>void,readonly progress:(p:AnalyticsProgress)=>void=()=>{},storeOptions:StoreOptions={}){this.store=new AnalyticsStore(databasePath,storeOptions)}
  close():void{this.store.close()}
  private selected(paths:string[],path:string):boolean{return paths.some(p=>samePath(p,path))}
  private exportsRoots():string[]{
    // SQLite snapshots live beside embedding storage (userData/rag/exports),
    // never inside the source folder. Keep the previous analytics/exports
    // location readable for existing snapshots.
    return [join(dirname(dirname(this.databasePath)),'rag','exports'),join(dirname(this.databasePath),'exports')]
  }
  private newExportsRoot():string{return this.exportsRoots()[0]}
  private async verifySqlite(snapshot:{path:string;hash:string}):Promise<void>{
    const roots=this.exportsRoots()
    const allowed=roots.find(root=>within(root,snapshot.path))
    if(!allowed)throw new Error('Exported SQLite snapshot must live beside embedding storage. Prepare & export again before querying it.')
    await regularFile([allowed],snapshot.path,Number.MAX_SAFE_INTEGER);this.check()
    if(await hashFile(snapshot.path)!==snapshot.hash)throw new Error('Exported SQLite snapshot changed. Prepare & export again before querying it.')
    this.check()
  }
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
          try{const result=await importFile(this.store,path,this.roots,this.settings,this.check,rows=>{state.rows+=rows-priorRows;priorRows=rows;state.message=`Imported ${rows.toLocaleString()} records; validating table structure`;send()});if(result==='unchanged')state.unchanged++;else state.imported++}
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
    if(job.action==='export-sqlite'){
      if(!job.preparationAuthorized)throw new Error('Use Prepare & export to authorize a SQLite export.')
      const paths=job.paths??[]
      if(!paths.length||!job.folder)throw new Error('Select source files and an export folder.')
      const records=this.store.datasets(paths),issues:AnalyticsPreparationSummary['issues']=[]
      const reviewed=new Map((job.reviewedDatasets??[]).map(record=>[record.datasetId,record.generation]))
      for(const {data:d} of records)if(['needs-review','ready'].includes(this.store.file(d.path)?.state??'')&&reviewed.get(d.id)!==d.generation)throw new Error(`Describe all columns of ${d.name} and review its policy before exporting. Follow dataset and column pagination.`)
      for(const {data:d} of records)if(d.status!=='ready')issues.push({kind:d.preparationError?'blocked-table':'needs-review',path:d.path,name:d.name,sheet:d.sheet,datasetId:d.id,reason:d.preparationError??d.preparedPolicy?.notes?.join(' ')??'The table has no applied policy.'})
      for(const path of paths){const file=this.store.file(path);if(!TABLE_EXTENSIONS.has(extname(path).toLowerCase()))issues.push({kind:'unsupported-file',path,reason:'Unsupported analytical file type.'});else if(!file||file.state==='failed')issues.push({kind:'failed-file',path,reason:file?.error??'Source was not imported.'})}
      const preparation:AnalyticsPreparationSummary={selectedFileCount:paths.length,imported:0,unchanged:0,failedFiles:issues.filter(i=>i.kind==='failed-file').length,unsupportedFiles:issues.filter(i=>i.kind==='unsupported-file').length,approvedTables:records.filter(r=>r.data.status==='ready'&&r.data.approval?.by==='agent').length,alreadyReady:records.filter(r=>r.data.status==='ready'&&r.data.approval?.by!=='agent').length,readyTables:records.filter(r=>r.data.status==='ready').length,draftTables:records.filter(r=>r.data.status!=='ready'&&r.data.preparedPolicy).length,reviewTables:issues.filter(i=>i.kind==='needs-review').length,blockedTables:issues.filter(i=>i.kind==='blocked-table').length,issues:issues.slice(0,100),issuesTruncated:issues.length>100}
      const result=await exportReadyTables({store:this.store,roots:this.roots,folder:job.folder,outputDirectory:this.newExportsRoot(),paths,preparation,check:this.check,verify:sources=>this.verify(sources,paths),progress:(record,rows)=>this.progress({...emptyProgress(),running:true,folder:job.folder!,current:record.data.path,rows,message:`Exporting SQLite: ${record.data.name}, ${rows.toLocaleString()} rows`})})
      return {value:result,sources:result.sources} satisfies AnalyticsEnvelope
    }
    if(job.action==='prepare'||job.action==='propose-policy'){
      if(!this.settings.allowAgentPreparation)throw new Error('Enable Allow agent preparation in Knowledge > Setup > Table settings and save analytics settings first. This permits local unencrypted storage; approval remains yours.')
      const paths=job.paths??[]
      if(!paths.length||paths.length>256)throw new Error('Select 1 to 256 individual source files before preparing tables.')
      const r=object(job.payload??{})
      if(job.action==='prepare'){
        const requested=r.paths===undefined?paths:list(r.paths,'preparation paths',256).map(v=>text(v,'path',4096))
        if(!requested.length)throw new Error('Select at least one file for preparation.')
        const targets=preparationTargets(paths,requested)
        // Check the complete requested scope before any import. Never enumerate its parent folder.
        for(const path of targets){await regularFile(this.roots,path,this.settings.maxFileMiB*1048576);this.check()}
        this.store.recover()
        const state={...emptyProgress(),running:true,folder:dirname(targets[0]!)}
        let draftsPrepared=0,existingDrafts=0,alreadyReady=0,approvedTables=0,reviewTables=0,blockedTables=0,failedFiles=0,unsupportedFiles=0
        const policyChanges:NonNullable<AnalyticsEnvelope['policyChanges']>=[]
        const issues:{kind:'blocked-table'|'needs-review'|'unsupported-file'|'failed-file';path:string;reason:string;datasetId?:string;name?:string;sheet?:string}[]=[]
        let issuesTruncated=false
        const addIssue=(issue:typeof issues[number])=>{
          if(Buffer.byteLength(JSON.stringify([...issues,issue]))<=16000)issues.push(issue)
          else issuesTruncated=true
        }
        try{
          for(const path of targets){
            this.check();state.current=path;state.scanned++
            if(!TABLE_EXTENSIONS.has(extname(path).toLowerCase())){state.failed++;unsupportedFiles++;state.message='Unsupported analytical file type; source was not imported.';addIssue({kind:'unsupported-file',path,reason:state.message});this.progress({...state});continue}
            let priorRows=0
            try{const result=await importFile(this.store,path,this.roots,this.settings,this.check,rows=>{state.rows+=rows-priorRows;priorRows=rows;state.message='Preparing selected table data';this.progress({...state})});if(result==='unchanged')state.unchanged++;else state.imported++}
            catch(e){this.check();state.failed++;failedFiles++;state.message=message(e);addIssue({kind:'failed-file',path,reason:state.message.slice(0,1000)})}
            this.progress({...state})
          }
          // Process every imported selected table, even when the displayed catalog is paginated.
          for(const record of this.store.datasets(targets)){
            this.check();const d=record.data
            if(!['needs-review','ready'].includes(this.store.file(d.path)?.state??''))continue
            if(d.status==='ready'){alreadyReady++;continue}
            if(d.preparedPolicy&&!this.settings.allowAgentApproval){existingDrafts++;continue}
            const baseline=d.preparedPolicy?null:baselinePolicy(this.store,record)
            let priorRows=0
            try{
              let preparedPolicy=d.preparedPolicy
              const report=(rows:number)=>{state.rows+=rows-priorRows;priorRows=rows;state.current=d.path;state.message=`Validating a draft for ${d.name}`;this.progress({...state})}
              if(!preparedPolicy){const validated=await validateDatasetPolicy(this.store,d.id,d.generation,baseline!.policy,this.roots,this.settings,this.check,report);preparedPolicy={policy:validated.policy,validatedRows:validated.rows,excludedRows:validated.excludedRows,createdAt:Date.now(),notes:baseline!.notes}}
              const reviewReasons=this.settings.allowAgentApproval?automaticApprovalIssues(d,preparedPolicy.policy):[]
              if(this.settings.allowAgentApproval&&!reviewReasons.length){
                const approved=await approveDatasetByAgent(this.store,d.id,d.generation,preparedPolicy.policy,this.roots,this.settings,this.check,report)
                policyChanges.push({datasetId:d.id,previousGeneration:d.generation,generation:approved.generation,sourceHash:approved.sourceHash});approvedTables++
              }else{
                if(reviewReasons.length){reviewTables++;addIssue({kind:'needs-review',path:d.path,datasetId:d.id,name:d.name,sheet:d.sheet,reason:reviewReasons.join(' ').slice(0,1000)})}
                preparedPolicy={...preparedPolicy,notes:[...new Set([...(preparedPolicy.notes??[]),...reviewReasons])]}
                this.check();this.store.putDataset({...record,data:{...d,preparedPolicy,preparationError:undefined}})
                if(d.preparedPolicy)existingDrafts++;else draftsPrepared++
              }
            }catch(e){
              this.check();const reason=message(e).slice(0,1000)
              this.store.putDataset({...record,data:{...d,preparationError:reason}});blockedTables++;state.message=reason
              addIssue({kind:'blocked-table',path:d.path,datasetId:d.id,name:d.name,sheet:d.sheet,reason})
            }
            this.progress({...state})
          }
        }finally{state.running=false;this.progress({...state})}
        const result=await this.execute({action:'discover',paths:targets,payload:{}}) as AnalyticsEnvelope
        const sources=this.store.datasets(targets).filter(record=>['needs-review','ready'].includes(this.store.file(record.data.path)?.state??'')).map(({data:d})=>({path:d.path,hash:d.sourceHash,datasetId:d.id,generation:d.generation}))
        await this.verify(sources,targets)
        const catalog=object(result.value)
        // Put complete outcomes first; the preparation summary does not depend on catalog pagination.
        // Leave schemas to describe_dataset instead of repeating them in a write-tool response.
        const datasets=list(catalog.datasets,'prepared datasets').map(raw=>({...Object.fromEntries(Object.entries(object(raw)).filter(([key])=>key!=='columns'&&key!=='warnings')),schemaOmitted:true}))
        const selectedFiles=list(catalog.selectedFiles,'selected files')
        const preparation={imported:state.imported,unchanged:state.unchanged,failed:state.failed,failedFiles,unsupportedFiles,draftsPrepared,existingDrafts,draftTables:draftsPrepared+existingDrafts,alreadyReady,approvedTables,readyTables:alreadyReady+approvedTables,reviewTables,blockedTables,automaticApprovalEnabled:this.settings.allowAgentApproval,selectedFileCount:targets.length,allImportedTablesAttempted:true,issues,issuesTruncated,approvalRequired:draftsPrepared+existingDrafts+blockedTables>0,next:'Preparation is complete for this requested selection. Do not repeat prepare_data to read another page. These counters cover every imported selected table; when issuesTruncated is false, all blockers and file issues are listed here. Use discover_datasets pagination only for additional catalog details or omitted issues, and describe_dataset/propose_table_policy to refine a draft. Automatically approved tables are Ready for native analysis; remaining drafts and decisions are in Knowledge > Tables > Review table. With automatic approval disabled, enable it once in Table settings to let the agent finish clear tables.'}
        if(job.preparationAuthorized)preparation.next='The clicked Prepare & export request has imported and validated drafts for all selected tables. Do not repeat preparation to paginate. Discover and describe every imported table (including all column pages), review actual source evidence, apply clear policies with propose_table_policy, then call export_sqlite. This request already has preparation and agent-approval authority; do not direct clear tables to settings or manual approval.'
        const value={preparation,...catalog,datasets,selectedFiles,nextOffset:catalog.nextOffset as number|null,nextFileOffset:catalog.nextFileOffset as number|null}
        while(Buffer.byteLength(JSON.stringify(value))>60000&&datasets.length>1)datasets.pop()
        while(Buffer.byteLength(JSON.stringify(value))>60000&&selectedFiles.length>1)selectedFiles.pop()
        value.nextOffset=datasets.length<(catalog.total as number)?datasets.length:null
        value.nextFileOffset=selectedFiles.length<targets.length?selectedFiles.length:null
        if(Buffer.byteLength(JSON.stringify(value))>64000)throw new Error('Preparation metadata exceeds the tool budget. Inspect the saved drafts using dataset discovery.')
        return {value,sources,policyChanges} satisfies AnalyticsEnvelope
      }
      const id=text(r.datasetId,'dataset ID'),generation=text(r.expectedGeneration,'expected generation'),record=this.store.dataset(id)
      if(!record||!this.selected(paths,record.data.path))throw new Error('Dataset is not in the selected scope.')
      if(record.data.generation!==generation)throw new Error('Dataset changed. Describe it again before proposing a policy.')
      this.store.recover()
      const policy=mergePolicy(record.data.preparedPolicy?.policy??record.data.policy,r.policy)
      const validated=await validateDatasetPolicy(this.store,id,generation,policy,this.roots,this.settings,this.check,rows=>this.progress({...emptyProgress(),running:true,folder:dirname(record.data.path),current:record.data.path,rows,message:'Checking the proposed policy against every included row'}))
      const reviewReasons=this.settings.allowAgentApproval?automaticApprovalIssues(record.data,validated.policy):[]
      if(this.settings.allowAgentApproval&&!reviewReasons.length){
        const approved=await approveDatasetByAgent(this.store,id,generation,validated.policy,this.roots,this.settings,this.check,rows=>this.progress({...emptyProgress(),running:true,folder:dirname(record.data.path),current:record.data.path,rows,message:'Publishing the fully validated agent policy'}))
        const sources=[{path:approved.path,hash:approved.sourceHash,datasetId:id,generation:approved.generation}];await this.verify(sources,paths)
        return {value:{datasetId:id,generation:approved.generation,path:approved.path,status:'ready',approvalRequired:false,approved:true,approvalBy:'agent',validatedRows:approved.rows,excludedRows:approved.excludedRows,warnings:approved.warnings,next:'This table is Ready for native analysis. Its policy was approved by the agent under saved automatic-approval settings.'},sources,policyChanges:[{datasetId:id,previousGeneration:generation,generation:approved.generation,sourceHash:approved.sourceHash}]} satisfies AnalyticsEnvelope
      }
      const preparedPolicy={policy:validated.policy,validatedRows:validated.rows,excludedRows:validated.excludedRows,createdAt:Date.now(),notes:[...preparationNotes(validated.policy),...reviewReasons]}
      this.check();this.store.putDataset({...record,data:{...record.data,preparedPolicy,preparationError:undefined}})
      const sources=[{path:record.data.path,hash:record.data.sourceHash,datasetId:id,generation}];await this.verify(sources,paths)
      return {value:{datasetId:id,generation,path:record.data.path,status:record.data.status,approvalRequired:true,approved:false,reviewReasons,validatedRows:validated.rows,excludedRows:validated.excludedRows,formulaCells:validated.formulaCells,warnings:validated.warnings,next:'The prepared policy is available in Knowledge > Tables > Review table. Confirm any reported population/formula decisions there, or enable automatic approval in Table settings to finish clear tables.'},sources} satisfies AnalyticsEnvelope
    }
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
      for(const entry of page){const d=entry.data;try{const ref={path:d.path,hash:d.sourceHash,datasetId:d.id,generation:d.generation};await this.verify([ref],paths);sources.push(ref);datasets.push({id:d.id,sqlTable:entry.typedTable,path:d.path,sourceHash:d.sourceHash,generation:d.generation,name:d.name,sheet:d.sheet,range:d.range,status:d.status,rows:d.rows,grain:d.policy.grain,preparationState:d.status==='ready'?'ready':d.preparedPolicy?'draft-ready':d.preparationError?'blocked':'not-prepared',preparedPolicy:d.preparedPolicy?{grain:d.preparedPolicy.policy.grain,validatedRows:d.preparedPolicy.validatedRows,notes:d.preparedPolicy.notes}:undefined,preparationError:d.preparationError,approval:d.approval,columns:d.policy.columns.slice(0,12).map(c=>({id:c.id,name:c.name,type:c.type,unit:c.unit})),totalColumns:d.policy.columns.length,moreColumns:d.policy.columns.length>12,warnings:d.warnings})}catch(e){datasets.push({id:d.id,path:d.path,status:'unavailable',reason:message(e)})}}
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
      while(Buffer.byteLength(JSON.stringify(columns))>12000&&columns.length>1)columns.pop()
      const suggestions=suggestedPolicy(this.store,d)
      const prepared=d.data.preparedPolicy
      const value={...d.data,sqlSchema:{table:d.typedTable,rowColumn:'__row',numericEncoding:'Decimals are exact scaled INTEGER coefficients: value / 10^scale. REAL is approximate.',columns:columns.map(c=>({id:c.id,name:c.name,type:c.type,scale:c.scale,unit:c.unit}))},preparedPolicy:prepared?{...prepared,policy:{...prepared.policy,columns:prepared.policy.columns.slice(offset,offset+columns.length),skipRows:prepared.policy.skipRows.slice(0,100)}}:undefined,
        policy:{...d.data.policy,columns,skipRows:d.data.policy.skipRows.slice(0,100)},suggestedPolicy:{columns:suggestions.columns.slice(offset,offset+columns.length).map(({id,name,unit,role})=>({id,name,unit,role}))},suggestionsAreUnapproved:true,
        excludedRowListTruncated:d.data.policy.skipRows.length>100,explicitExcludedRowCount:d.data.policy.skipRows.length,profile:{...d.data.profile,columns:undefined},totalColumns:d.data.policy.columns.length,nextColumnOffset:offset+columns.length<d.data.policy.columns.length?offset+columns.length:null,
        preview:d.data.preview.slice(0,3).map(row=>({...row,values:row.values.slice(offset,offset+Math.min(16,columns.length))})),previewIsSample:true,previewColumnOffset:offset,previewTruncated:d.data.preview.length>3||d.data.policy.columns.length>16}
      return {value,sources} satisfies AnalyticsEnvelope
    }
    if(job.action==='result'||job.action==='drill'){
      const r=object(job.payload),result=this.store.result(text(r.resultId,'result ID',100))
      if(!result)throw new Error('Result receipt is unavailable or was removed by retention/clear.')
      await this.verify(result.sources,paths)
      const snapshot=result.summary?.sqliteSnapshot as {path:string;hash:string}|undefined
      if(snapshot)await this.verifySqlite(snapshot)
      if(job.action==='result')return {value:result,sources:result.sources} satisfies AnalyticsEnvelope
      const original=object(result.request,'original analysis request')
      if(result.operation!=='query')throw new Error('For statistical drill-down, query the described source dataset with the original filters.')
      const filters=[...list(original.filters??[],'original filters'),...list(r.filters??[],'drill filters')]
      job={action:'query',paths,payload:{datasetIds:original.datasetIds,join:original.join,filters,columns:r.columns,limit:r.limit}}
    }
    if(job.action==='query'||job.action==='sql'||job.action==='analyze'){
      if(job.action==='analyze'&&object(job.payload).join!==undefined)throw new Error('Statistical methods do not accept joins. Use query_data for validated joins.')
      let snapshot:{path:string;hash:string}|undefined
      if(job.action==='sql'){
        const r=object(job.payload),refs=list(r.datasetIds,'dataset IDs',16).map(id=>{
          const record=this.store.dataset(text(id,'dataset ID',80))
          if(!record||!this.selected(paths,record.data.path))throw new Error('Dataset is not available within the selected-file scope.')
          if(record.data.status!=='ready'||!record.typedTable)throw new Error('Dataset is not analytics-ready. Use Prepare & export first.')
          return record
        })
        const exports=refs.map(record=>{const saved=record?.data.profile.sqliteExport as {path:string;hash:string;generation:string}|undefined;return saved?.generation===record?.data.generation?saved:undefined})
        const first=exports[0]
        if(first&&exports.every(saved=>saved?.path===first.path&&saved?.hash===first.hash)){snapshot=first;await this.verifySqlite(snapshot)}
      }
      const session=new QuerySession(this.store,paths,this.settings,this.check,snapshot?.path)
      let result:AnalyticsResult
      try{
        if(job.action==='sql'){
          const r=object(job.payload),sources=list(r.datasetIds,'dataset IDs',16).map(id=>{const {data:d}=session.dataset(id);return {path:d.path,hash:d.sourceHash,datasetId:d.id,generation:d.generation}})
          await this.verify(sources,paths);result=executeSql(session,job.payload)
        }else{
          const relation=session.relation(job.payload);await this.verify(relation.sources,paths)
          result=job.action==='query'?session.execute(job.payload):analyze(session,job.payload)
        }
      }finally{session.close()}
      await this.verify(result.sources,paths);this.check()
      if(snapshot){await this.verifySqlite(snapshot);result.summary={...result.summary,sqliteSnapshot:snapshot}}
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
    throw new Error('Unknown analytics action.')
  }
}
