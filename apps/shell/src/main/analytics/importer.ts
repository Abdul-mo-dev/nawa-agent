import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, copyFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { ANALYTICS_VERSION, type Dataset, type DataColumn, type TablePolicy, type AnalyticsSettings } from '../../shared/analytics-api'
import { regularFile, hashFile } from '../directory-actions/file-safety'
import { readTables, columnName } from './readers'
import { decimal, validDate, convert, MIN_I64, MAX_I64 } from './numeric'
import { policy as validatePolicy } from './validation'
import { AnalyticsStore, tableName, quotedTable, type StoredDataset } from './store'
import { automaticApprovalIssues } from './preparation'
import type { RawRow, RawCell, SourceTable } from './stream'
interface Draft { meta:SourceTable; rawTable:string; count:number }
interface Infer { count:number; blank:number; decimal:boolean; boolean:boolean; date:boolean; scale:number; min:bigint|null; max:bigint|null; leadingZero:boolean; errors:number; formulas:number }
const inference=():Infer=>({count:0,blank:0,decimal:true,boolean:true,date:true,scale:0,min:null,max:null,leadingZero:false,errors:0,formulas:0})
function add(profile:Infer,cell:RawCell|undefined):void{
  if(cell?.formula)profile.formulas++
  if(cell?.error)profile.errors++
  const value=cell?.value
  if(value==null||value===''){profile.blank++;return}
  profile.count++;const s=value.trim()
  profile.boolean&&=/^(true|false)$/i.test(s)
  profile.date&&=validDate(s)
  if(/^[-+]?0\d+/.test(s))profile.leadingZero=true
  if(profile.decimal)try{const d=decimal(s);profile.scale=Math.max(profile.scale,d.scale);if(d.scale===0){profile.min=profile.min===null||d.coefficient<profile.min?d.coefficient:profile.min;profile.max=profile.max===null||d.coefficient>profile.max?d.coefficient:profile.max}if(d.scale>12)profile.decimal=false}catch{profile.decimal=false}
}
const identifierName=(name:string)=>/(^id$|(?:^|[_\s])id$|code|postal|phone|account|identifier|番号|コード|郵便|電話)/i.test(name)
function inferColumn(index:number,name:string,p:Infer):DataColumn {
  let type:DataColumn['type']='text'
  if(p.count&&!identifierName(name)&&!p.leadingZero){if(p.boolean)type='boolean';else if(p.date)type='date';else if(p.decimal&&p.scale<=12&&!(p.min!==null&&p.min<MIN_I64)&&!(p.max!==null&&p.max>MAX_I64))type=p.scale?'decimal':'integer'}
  return {id:`c${index}`,name:name||`Column ${index+1}`,type,scale:type==='decimal'?p.scale:0,role:identifierName(name)?'identifier':['integer','decimal'].includes(type)?'measure':'dimension',unit:'',nullable:true,description:''}
}
function rowIterator(store:AnalyticsStore,table:string):Iterable<{row:number;data:string}>{return store.db.prepare(`SELECT row,data FROM ${quotedTable(table)} ORDER BY row`).iterate() as unknown as Iterable<{row:number;data:string}>}
export function describeDraft(store:AnalyticsStore,draft:Draft,path:string,hash:string,check:()=>void):StoredDataset {
  const m=draft.meta
  if(!draft.count||m.lastColumn<m.firstColumn)throw new Error(`No populated data in ${m.name}.`)
  const width=m.lastColumn-m.firstColumn+1,profiles=Array.from({length:width},inference),preview:Dataset['preview']=[]
  let headers=m.headers?[...m.headers]:[],formulas=0,dataRows=0,hidden=0,suspicious=0
  const suspiciousRows:number[]=[]
  for(const r of rowIterator(store,draft.rawTable)){
    if(r.row%1024===0)check()
    const row=JSON.parse(r.data) as RawRow
    if(r.row===m.headerRow&&!m.headers)headers=Array.from({length:width},(_,i)=>row.cells[m.firstColumn+i]?.value??'')
    if(preview.length<8)preview.push({row:r.row,values:Array.from({length:width},(_,i)=>(row.cells[m.firstColumn+i]?.value??'').slice(0,200))})
    if(r.row<m.firstRow||m.lastRow!==null&&r.row>m.lastRow)continue
    dataRows++;if(row.hidden)hidden++
    for(let i=0;i<width;i++){const cell=row.cells[m.firstColumn+i];add(profiles[i]!,cell);if(cell?.formula)formulas++}
    if(Object.values(row.cells).slice(0,3).some(c=>/^(?:grand\s+total|sub\s*total|total|合計|小計|総計)(?:\s|$|:)/i.test(c.value?.trim()??''))){suspicious++;if(suspiciousRows.length<50)suspiciousRows.push(r.row)}
  }
  const seen=new Map<string,number>(),columns=profiles.map((p,i)=>{
    let name=headers[i]?.trim()||`Column ${i+1}`;const key=name.normalize('NFKC').toLowerCase(),n=(seen.get(key)??0)+1;seen.set(key,n);if(n>1)name+=` (${n})`;return inferColumn(i,name,p)
  })
  const warnings=[...m.warnings,'Analytics is blocked until a user confirms this table policy. Review numeric units and exclusions.']
  if(hidden)warnings.push(`${hidden} hidden rows found; the default policy excludes them and reports that exclusion.`)
  if(formulas)warnings.push(`${formulas} formula cells found. Default policy rejects formulas. Selecting saved-cache explicitly accepts unverified saved values; nothing is recalculated.`)
  if(suspicious)warnings.push(`${suspicious} possible total/subtotal rows found, including ${suspiciousRows.join(', ')}. They are NOT automatically removed; review skipRows/range.`)
  const pol:TablePolicy={name:m.name,description:'',grain:'',headerRow:m.headerRow,firstRow:m.firstRow,lastRow:m.lastRow,firstColumn:m.firstColumn,lastColumn:m.lastColumn,columns,key:[],currencyColumn:null,includeHiddenRows:false,skipRows:[],formulaPolicy:'reject',confirmed:false}
  const data:Dataset={id:'d_'+createHash('sha256').update(path+'\0'+m.key).digest('hex').slice(0,32),path,sourceHash:hash,generation:randomUUID(),name:m.name,sheet:m.sheet,range:m.range,kind:m.kind,status:'needs-review',policy:pol,rows:0,rawRows:draft.count,excludedRows:0,formulaCells:formulas,warnings,profile:{importerVersion:ANALYTICS_VERSION,sourceBounds:{firstColumn:m.firstColumn,lastColumn:m.lastColumn,firstRow:m.firstRow,lastRow:m.lastRow},candidateDataRows:dataRows,hiddenRows:hidden,possibleSubtotalRows:suspiciousRows,columns:Object.fromEntries(columns.map((c,i)=>[c.id,{nonblank:profiles[i]!.count,blank:profiles[i]!.blank,formulaCells:profiles[i]!.formulas,errorCells:profiles[i]!.errors}]))},preview,importedAt:Date.now()}
  return {data,rawTable:draft.rawTable,typedTable:null,tableKey:m.key}
}
export async function importFile(store:AnalyticsStore,path:string,roots:string[],settings:AnalyticsSettings,check:()=>void,progress:(rows:number)=>void):Promise<'imported'|'unchanged'> {
  await regularFile(roots,path,settings.maxFileMiB*1048576);check()
  const stat=await lstat(path),hash=await hashFile(path),old=store.file(path)
  if(old?.hash===hash&&['ready','needs-review'].includes(old.state)&&store.datasets([path]).every(d=>d.data.profile.importerVersion===ANALYTICS_VERSION)){
    store.putFile({...old,mtime:stat.mtimeMs,ctime:stat.ctimeMs,size:stat.size});return 'unchanged'
  }
  const staging=join(dirname(store.path),'staging',randomUUID()),copy=join(staging,path.split(/[\\/]/).pop()!)
  await mkdir(staging,{recursive:true})
  const drafts=new Map<string,Draft>(),created:string[]=[]
  store.putFile({path,hash,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,state:'importing',error:'',imported:old?.imported??0})
  let transaction=false,total=0
  const flush=()=>{if(transaction){store.db.exec('COMMIT');transaction=false}}
  try{
    await copyFile(path,copy,constants.COPYFILE_EXCL);if(await hashFile(copy)!==hash)throw new Error('File changed while preparing the source snapshot.')
    const inserts=new Map<string,import('node:sqlite').StatementSync>()
    for await(const event of readTables(copy,store.db,{maxColumns:settings.maxColumns,maxRows:settings.maxRows,maxBytes:settings.maxFileMiB*1048576,check})){
      check()
      if(event.kind==='table'){
        flush();if(drafts.has(event.table.key))throw new Error('Duplicate source table key.')
        const rawTable=tableName('ar');created.push(rawTable)
        store.db.exec(`CREATE TABLE ${quotedTable(rawTable)}(row INTEGER PRIMARY KEY,data TEXT NOT NULL) STRICT`)
        drafts.set(event.table.key,{meta:event.table,rawTable,count:0});inserts.set(event.table.key,store.db.prepare(`INSERT INTO ${quotedTable(rawTable)} VALUES(?,?)`))
      }else{
        if(++total>settings.maxRows+drafts.size)throw new Error('File exceeds the configured total row limit. No partial file was published.')
        const d=drafts.get(event.table);if(!d)throw new Error('Source row has no table declaration.')
        if(!transaction){store.db.exec('BEGIN');transaction=true}
        inserts.get(event.table)!.run(event.row.row,JSON.stringify(event.row));d.count++
        if(total%1000===0){flush();progress(total);await new Promise<void>(resolve=>setImmediate(resolve))}
      }
    }
    flush();progress(total)
    const populated=[...drafts.values()].filter(d=>d.count>0&&d.meta.lastColumn>=d.meta.firstColumn)
    if(!populated.length)throw new Error('The source contains no importable table records.')
    const datasets=populated.map(d=>describeDraft(store,d,path,hash,check))
    await regularFile(roots,path,settings.maxFileMiB*1048576)
    if(await hashFile(path)!==hash)throw new Error('Source changed during import. The new generation was discarded.')
    check()
    store.replaceFile({path,hash,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,state:'needs-review',error:'Review table types, ranges, units and row grain.',imported:Date.now()},datasets)
    for(const d of drafts.values())if(!populated.includes(d))store.dropTable(d.rawTable)
    return 'imported'
  }catch(e){if(transaction&&store.db.isTransaction){store.db.exec('ROLLBACK');transaction=false}for(const t of created)store.dropTable(t);store.putFile({path,hash,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,state:'failed',error:e instanceof Error?e.message:String(e),imported:old?.imported??0});throw e}
  finally{await rm(staging,{recursive:true,force:true})}
}
export async function approveDataset(store:AnalyticsStore,datasetId:string,expectedGeneration:string,rawPolicy:unknown,roots:string[],settings:AnalyticsSettings,check:()=>void,progress:(rows:number)=>void):Promise<Dataset>{
  return materializeDataset(store,datasetId,expectedGeneration,rawPolicy,roots,settings,check,progress,'user')
}
/** Saved preparation/approval consent is checked independently of any model-provided confirmation. */
export async function approveDatasetByAgent(store:AnalyticsStore,datasetId:string,expectedGeneration:string,rawPolicy:unknown,roots:string[],settings:AnalyticsSettings,check:()=>void,progress:(rows:number)=>void):Promise<Dataset>{
  if(!settings.allowAgentPreparation||!settings.allowAgentApproval)throw new Error('Enable automatic agent approval in Table settings first.')
  return materializeDataset(store,datasetId,expectedGeneration,rawPolicy,roots,settings,check,progress,'agent')
}
/** Validate every included row and key, then discard the temporary typed table. Never publishes approval. */
export async function validateDatasetPolicy(store:AnalyticsStore,datasetId:string,expectedGeneration:string,rawPolicy:unknown,roots:string[],settings:AnalyticsSettings,check:()=>void,progress:(rows:number)=>void):Promise<Dataset>{
  return materializeDataset(store,datasetId,expectedGeneration,rawPolicy,roots,settings,check,progress,null)
}
async function materializeDataset(store:AnalyticsStore,datasetId:string,expectedGeneration:string,rawPolicy:unknown,roots:string[],settings:AnalyticsSettings,check:()=>void,progress:(rows:number)=>void,publication:'user'|'agent'|null):Promise<Dataset>{
  const record=store.dataset(datasetId);if(!record||record.data.generation!==expectedGeneration)throw new Error('Dataset changed. Reload its review before applying a policy.')
  const d=record.data,pol=validatePolicy(rawPolicy,settings.maxColumns),publish=publication!==null
  if(publication==='user'&&!pol.confirmed)throw new Error('A human must confirm the table policy before analytics is enabled.')
  if(publication==='agent'){const issues=automaticApprovalIssues(d,pol);if(issues.length)throw new Error(issues.join(' '))}
  const bounds=d.profile.sourceBounds as {firstColumn:number;lastColumn:number;firstRow:number;lastRow:number|null}|undefined
  if(bounds&&(pol.firstColumn<bounds.firstColumn||pol.lastColumn>bounds.lastColumn||pol.firstRow<bounds.firstRow||(bounds.lastRow!==null&&(pol.lastRow===null||pol.lastRow>bounds.lastRow))))throw new Error('The approved range exceeds the imported source table bounds. Import an explicit larger table before expanding this policy.')
  await regularFile(roots,d.path,settings.maxFileMiB*1048576)
  if(await hashFile(d.path)!==d.sourceHash)throw new Error('Source changed. Import again before reviewing.')
  const file=store.file(d.path);if(!file||!['needs-review','ready'].includes(file.state))throw new Error('File import is not complete.')
  const typed=tableName('at'),skip=new Set(pol.skipRows);let included=0,excluded=0,formulas=0,tx=false
  const types:Record<DataColumn['type'],string>={text:'TEXT',date:'TEXT',integer:'INTEGER',decimal:'INTEGER',boolean:'INTEGER',real:'REAL'}
  store.db.exec(`CREATE TABLE ${quotedTable(typed)}(__row INTEGER PRIMARY KEY,${pol.columns.map(c=>`"${c.id}" ${types[c.type]}${c.nullable?'':' NOT NULL'}`).join(',')}) STRICT`)
  const insert=store.db.prepare(`INSERT INTO ${quotedTable(typed)} VALUES(${Array.from({length:pol.columns.length+1},()=>'?').join(',')})`)
  try{
    for(const item of rowIterator(store,record.rawTable)){
      check();const row=JSON.parse(item.data) as RawRow
      if(row.row<pol.firstRow||pol.lastRow!==null&&row.row>pol.lastRow||skip.has(row.row)||row.hidden&&!pol.includeHiddenRows){excluded++;continue}
      const raw=pol.columns.map((_,i)=>row.cells[pol.firstColumn+i])
      if(raw.every(c=>!c?.formula&&!c?.error&&(c?.value==null||c.value===''))){excluded++;continue}
      const values=pol.columns.map((c,i)=>{const cell=raw[i];if(cell?.error)throw new Error(`Row ${row.row}, ${c.name}: ${cell.error}. Fix or explicitly exclude this source row/column.`);if(cell?.formula){formulas++;if(pol.formulaPolicy==='reject')throw new Error(`Row ${row.row}, ${c.name} contains a formula. Review the saved-cache policy or exclude the formula column.`);if(cell.value==null)throw new Error(`Row ${row.row}, ${c.name}: formula has no saved value.`)}try{return convert(cell?.value??null,c)}catch(e){throw new Error(`Row ${row.row}, ${c.name}: ${e instanceof Error?e.message:String(e)}`,{cause:e})}})
      if(!tx){store.db.exec('BEGIN');tx=true}insert.run(row.row,...values);included++
      if(included%1000===0){store.db.exec('COMMIT');tx=false;progress(included);await new Promise<void>(resolve=>setImmediate(resolve))}
    }
    if(tx){store.db.exec('COMMIT');tx=false}
    if(!included)throw new Error('The approved range contains no data rows.')
    if(pol.key.length){
      const fields=pol.key.map(k=>`"${k}"`),nullCount=(store.db.prepare(`SELECT COUNT(*) n FROM ${quotedTable(typed)} WHERE ${fields.map(k=>`${k} IS NULL OR ${k}=''`).join(' OR ')}`).get() as {n:number}).n
      if(nullCount)throw new Error(`Declared row key has ${nullCount} missing values.`)
      const duplicate=store.db.prepare(`SELECT 1 FROM ${quotedTable(typed)} GROUP BY ${fields.join(',')} HAVING COUNT(*)>1 LIMIT 1`).get()
      if(duplicate)throw new Error('Declared row key is not unique. Do not use it for joins or duplicate-export detection.')
      store.db.exec(`CREATE UNIQUE INDEX "${typed}_key" ON ${quotedTable(typed)}(${fields.join(',')})`)
    }
    for(const c of pol.columns.filter(c=>c.type==='date').slice(0,4))store.db.exec(`CREATE INDEX "${typed}_${c.id}" ON ${quotedTable(typed)}("${c.id}")`)
    await regularFile(roots,d.path,settings.maxFileMiB*1048576);if(await hashFile(d.path)!==d.sourceHash)throw new Error('Source changed during schema validation. No new typed table was published.')
    check()
    const warnings=d.warnings.filter(w=>!w.startsWith('Analytics is blocked')&&!w.startsWith('This policy was automatically approved')&&!w.startsWith('Row grain is structural'))
    if(formulas)warnings.push(publication==='user'?'Statistics use saved formula caches, explicitly accepted by the user; these values were not recalculated or verified against external dependencies.':'The proposed policy uses unverified saved formula caches. User approval is pending; these values were not recalculated or verified against external dependencies.')
    if(pol.columns.some(c=>c.type==='real'))warnings.push('REAL columns use approximate floating-point arithmetic, not exact decimal arithmetic.')
    if(pol.columns.some(c=>c.role==='measure'&&!c.unit))warnings.push('Some measure units are unspecified. Treat results as mechanical column statistics, not validated business metrics.')
    if(publication==='agent'){
      warnings.push('This policy was automatically approved by the agent after full validation under automatic approval mode; it has not been manually reviewed by a user.')
      if(pol.grain==='One source data record')warnings.push('Row grain is structural: one source data record. Business meaning was not inferred.')
    }
    const next:Dataset={...d,preparedPolicy:undefined,preparationError:undefined,approval:publication?{by:publication,at:Date.now(),reason:publication==='agent'?'Validated all included rows and declared keys; preserved the imported population and rejected formula caches.':'User confirmed the table policy.'}:undefined,generation:publish?randomUUID():d.generation,name:pol.name,status:publish?'ready':'needs-review',policy:{...pol,confirmed:publication==='user'},rows:included,excludedRows:excluded,formulaCells:formulas,warnings,range:`${d.sheet?d.sheet+'!':''}${columnName(pol.firstColumn)}${pol.firstRow}:${columnName(pol.lastColumn)}${pol.lastRow??'end'}`}
    if(!publish){store.dropTable(typed);return next}
    store.db.exec('BEGIN IMMEDIATE')
    try{store.putDataset({...record,data:next,typedTable:typed});store.dropTable(record.typedTable);const all=store.datasets([d.path]);store.putFile({...file,state:all.every(x=>x.data.status==='ready')?'ready':'needs-review',error:all.every(x=>x.data.status==='ready')?'':'Some tables still need review.'});store.db.exec('COMMIT')}
    catch(e){store.db.exec('ROLLBACK');throw e}
    return next
  }catch(e){if(tx&&store.db.isTransaction)store.db.exec('ROLLBACK');store.dropTable(typed);throw e}
}
