import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
const root=process.env.NAWA_ANALYTICS_BUILD,project=process.env.NAWA_ANALYTICS_PROJECT
if(!root||!project)throw new Error('Use node tools/analytics/test.mjs.')
const load=name=>import(pathToFileURL(path.join(root,'apps/shell/src/main/analytics',name+'.mjs')).href)
const {AnalyticsEngine}=await load('engine'),{decimal,scaled,display,divide}=await load('numeric'),{delimited,jsonRecord,jsonArray,xmlFragments}=await load('stream'),{settings}=await load('validation')
const {DEFAULT_ANALYTICS_SETTINGS}=await import(pathToFileURL(path.join(root,'apps/shell/src/shared/analytics-api.mjs')).href)
const require=createRequire(path.join(project,'package.json')),JSZip=require('jszip')
async function fixture(fn,options={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nawa-analytics-case-')),source=path.join(directory,'source'),state=path.join(directory,'state');await fs.mkdir(source);await fs.mkdir(state);let cancelled=false;const engine=new AnalyticsEngine(path.join(state,'data.sqlite3'),[source],{...DEFAULT_ANALYTICS_SETTINGS,...options},()=>{if(cancelled)throw new Error('Cancelled')});try{return await fn({engine,source,state,directory,cancel:()=>{cancelled=true}})}finally{engine.close();await fs.rm(directory,{recursive:true,force:true})}}
async function importCsv(ctx,name,text){const file=path.join(ctx.source,name);await fs.writeFile(file,text);await ctx.engine.execute({action:'import',folder:ctx.source});return ctx.engine.store.datasets([file])[0].data}
async function approve(ctx,d,patch={}){const policy={...d.policy,grain:'One input detail record',confirmed:true,...patch};return ctx.engine.execute({action:'review',payload:{datasetId:d.id,expectedGeneration:d.generation,policy}})}
const run=async(ctx,d,payload)=> (await ctx.engine.execute({action:'query',paths:[d.path],payload:{datasetIds:[d.id],...payload}})).value
const chunks=async function*(value,width=1){for(let i=0;i<value.length;i+=width)yield value.slice(i,i+width)}
const limits={maxRows:100,maxColumns:20,maxBytes:1024*1024,check:()=>{}}

const {DatabaseSync}=require('node:sqlite')
async function prepareAndExport(ctx,paths,folder=path.dirname(paths[0])){
  const batch=new AnalyticsEngine(ctx.engine.databasePath,ctx.engine.roots,{...ctx.engine.settings,allowAgentPreparation:true,allowAgentApproval:false},ctx.engine.check,ctx.engine.progress,{initialize:false})
  batch.verify=ctx.engine.verify.bind(ctx.engine)
  try{
    await batch.execute({action:'prepare',paths})
    const reviewedDatasets=[]
    for(const record of batch.store.datasets(paths)){
      let offset=0
      do{const description=(await batch.execute({action:'describe',paths,payload:{datasetId:record.data.id,columnOffset:offset,columnLimit:64}})).value;offset=description.nextColumnOffset}while(offset!==null)
      if(record.data.status!=='ready'){
        batch.settings.allowAgentApproval=true
        await batch.execute({action:'propose-policy',paths,payload:{datasetId:record.data.id,expectedGeneration:record.data.generation,policy:{}}}).catch(error=>{if(!record.data.preparationError)throw error})
      }
      reviewedDatasets.push({datasetId:record.data.id,generation:batch.store.dataset(record.data.id).data.generation})
    }
    return (await batch.execute({action:'export-sqlite',paths,folder,preparationAuthorized:true,reviewedDatasets})).value
  }finally{batch.close()}
}
function exportedDb(result){return new DatabaseSync(result.databasePath,{readOnly:true,allowExtension:false})}

test('agent preparation/review/export publishes a standalone selected SQLite population',async()=>fixture(async ctx=>{
  const selected=path.join(ctx.source,'records.csv'),unselected=path.join(ctx.source,'unselected.csv')
  const content='id,amount\n'+Array.from({length:125},(_,i)=>`record${i},${i+1}`).join('\n')+'\n'
  await fs.writeFile(selected,content);await fs.writeFile(unselected,'id\nunselected\n')
  const first=await prepareAndExport(ctx,[selected],ctx.source)
  assert.equal(first.exports.length,1);assert.equal(first.exports[0].rows,125)
  assert.equal(ctx.engine.settings.allowAgentPreparation,false);assert.equal(ctx.engine.settings.allowAgentApproval,false)
  assert.equal(ctx.engine.store.file(unselected),undefined);assert.equal(await fs.readFile(selected,'utf8'),content)
  const db=exportedDb(first)
  try{
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${first.exports[0].sqlTable}"`).get().n,125)
    assert.equal(db.prepare('SELECT source_path FROM nawa_tables').get().source_path,selected)
    assert.equal(JSON.parse(db.prepare('SELECT json FROM nawa_manifest').get().json).completePopulations,true)
    assert.equal(db.prepare(`SELECT c0,c1,__row FROM "${first.exports[0].sqlTable}" ORDER BY __row DESC LIMIT 1`).get().c0,'record124')
  }finally{db.close()}
  const second=await prepareAndExport(ctx,[selected])
  assert.notEqual(second.databasePath,first.databasePath);assert.equal(second.exports.length,1)
}, {resultRows:1}))

test('SQLite export retains exact scaled integers, multiline text, row references and user policies',async()=>fixture(async ctx=>{
  const imported=await importCsv(ctx,'exact.csv','id,amount,big,note\na,0.10,9007199254740993,"quoted ""value"", next"\nb,1.20,9007199254740994,"line1\nline2"\n')
  const d=await approve(ctx,imported,{columns:imported.policy.columns.map(c=>c.id==='c1'?{...c,type:'decimal',scale:2}:c)})
  const result=await prepareAndExport(ctx,[d.path]),db=exportedDb(result)
  try{
    const statement=db.prepare(`SELECT * FROM "${result.exports[0].sqlTable}" ORDER BY __row`);statement.setReadBigInts(true)
    const rows=statement.all()
    assert.equal(rows[0].c1,10n);assert.equal(rows[0].c2,9007199254740993n);assert.equal(rows[1].c1,120n);assert.equal(rows[1].c3,'line1\nline2')
    assert.equal(db.prepare("SELECT scale FROM nawa_columns WHERE column_id='c1'").get().scale,2)
    assert.equal(JSON.parse(db.prepare('SELECT approval_json FROM nawa_tables').get().approval_json).by,'user')
  }finally{db.close()}
}))

test('one SQLite file covers every selected table beyond catalog pagination',async()=>fixture(async ctx=>{
  const files=[]
  for(let i=0;i<27;i++){const file=path.join(ctx.source,`table-${i}.csv`);await fs.writeFile(file,'id,value\na,1\n');files.push(file)}
  const result=await prepareAndExport(ctx,files),db=exportedDb(result)
  try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nawa_tables').get().n,27)}finally{db.close()}
  assert.equal(new Set(result.exports.map(e=>e.sqlTable)).size,27)
  assert.deepEqual((await fs.readdir(result.exportDirectory)).sort(),['manifest.json','tables.sqlite3'])
}))

test('SQLite manifests isolate formula blockers, ambiguous populations and unsupported files',async()=>fixture(async ctx=>{
  const plain=path.join(ctx.source,'plain.csv'),subtotal=path.join(ctx.source,'subtotal.csv'),formula=path.join(ctx.source,'formula.xlsx'),unsupported=path.join(ctx.source,'notes.docx')
  await fs.writeFile(plain,'id,value\na,10\n');await fs.writeFile(subtotal,'name,value\nA,10\nTotal,10\n');await fs.writeFile(unsupported,'narrative');await xlsx(formula,{formula:true})
  const result=await prepareAndExport(ctx,[plain,subtotal,formula,unsupported])
  assert.equal(result.exports.length,1);assert.equal(result.preparation.blockedTables,1);assert.equal(result.preparation.reviewTables,1);assert.equal(result.preparation.unsupportedFiles,1)
  const manifest=JSON.parse(await fs.readFile(result.manifestPath,'utf8'))
  assert.equal(manifest.tables.filter(d=>!d.exported).length,2);assert.equal(manifest.selectedFiles.length,4)
}))

test('export refuses unreviewed schemas and destinations outside the workspace',async()=>fixture(async ctx=>{
  const d=await approve(ctx,await importCsv(ctx,'data.csv','id,value\na,10\n'))
  await assert.rejects(()=>ctx.engine.execute({action:'export-sqlite',paths:[d.path],folder:ctx.source}),/Prepare & export/)
  await assert.rejects(()=>ctx.engine.execute({action:'export-sqlite',paths:[d.path],folder:ctx.source,preparationAuthorized:true}),/Describe all columns/)
  await assert.rejects(()=>prepareAndExport(ctx,[d.path],ctx.state),/outside the registered/)
}))

test('cancelled SQLite export leaves no completed batch or staging directory',async()=>fixture(async ctx=>{
  const d=await approve(ctx,await importCsv(ctx,'data.csv','id,value\na,10\nb,20\n'))
  ctx.engine.progress=p=>{if(p.message.startsWith('Exporting SQLite'))ctx.cancel()}
  await assert.rejects(()=>prepareAndExport(ctx,[d.path]),/Cancelled/)
  assert.deepEqual(await fs.readdir(ctx.source),['data.csv'])
}))

test('read-only SQL supports parameterized searches, CTEs, window functions, joins and source receipts',async()=>fixture(async ctx=>{
  const a=await approve(ctx,await importCsv(ctx,'employees.csv','id,department,salary\na,Sales,10\nb,Sales,20\nc,Support,30\n'))
  const b=await approve(ctx,await importCsv(ctx,'departments.csv','department,label\nSales,Commercial\nSupport,Service\n'))
  const ta=ctx.engine.store.dataset(a.id).typedTable,tb=ctx.engine.store.dataset(b.id).typedTable
  const description=(await ctx.engine.execute({action:'describe',paths:[a.path],payload:{datasetId:a.id}})).value
  assert.equal(description.sqlSchema.table,ta)
  const result=(await ctx.engine.execute({action:'sql',paths:[a.path,b.path],payload:{datasetIds:[a.id,b.id],sql:`WITH ranked AS (SELECT c0,c1,c2,__row,ROW_NUMBER() OVER(PARTITION BY c1 ORDER BY c2 DESC) AS rank FROM "${ta}") SELECT r.c0,d.c1 AS label,r.__row FROM ranked r JOIN "${tb}" d ON r.c1=d.c0 WHERE rank=1 AND d.c1 LIKE ?`,parameters:['%mercial%']}})).value
  assert.equal(result.rows[0].c0,'b');assert.equal(result.rows[0].label,'Commercial');assert.equal(result.rows[0].__row,'3')
  assert.equal(result.sources.length,2);assert.equal(ctx.engine.store.result(result.id).operation,'sql')
}))

test('SQL output limits never sample aggregate inputs and serialization retains large integers',async()=>fixture(async ctx=>{
  const d=await approve(ctx,await importCsv(ctx,'big.csv','id,value\na,9007199254740993\nb,2\nc,3\n')),table=ctx.engine.store.dataset(d.id).typedTable
  const execute=sql=>ctx.engine.execute({action:'sql',paths:[d.path],payload:{datasetIds:[d.id],sql}})
  const result=(await execute(`SELECT COUNT(*) AS n,SUM(c1) AS total FROM "${table}"`)).value
  assert.equal(result.rows[0].n,'3');assert.equal(result.rows[0].total,'9007199254740998');assert.equal(result.inputSampled,false)
  const details=(await execute(`SELECT c0 FROM "${table}" ORDER BY __row`)).value
  assert.equal(details.rows.length,1);assert.equal(details.outputTruncated,true);assert.equal(details.summary.totalResultRowsExact,false)
}, {resultRows:1}))

test('SQL queries use the exported snapshot, verify its fingerprint and keep original-file authority',async()=>fixture(async ctx=>{
  const d=await approve(ctx,await importCsv(ctx,'snapshot.csv','id,value\na,10\nb,20\n'))
  const exported=await prepareAndExport(ctx,[d.path]),table=exported.exports[0].sqlTable
  const input={datasetIds:[d.id],sql:`SELECT COUNT(*) AS n FROM "${table}"`}
  const result=(await ctx.engine.execute({action:'sql',paths:[d.path],payload:input})).value
  assert.equal(result.rows[0].n,'2');assert.equal(result.summary.sqliteSnapshot.path,exported.databasePath)
  await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[],payload:input}),/selected-file/)
  const changed=new DatabaseSync(exported.databasePath);changed.exec(`UPDATE "${table}" SET c1=999`);changed.close()
  await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[d.path],payload:input}),/snapshot changed/)
  await assert.rejects(()=>ctx.engine.execute({action:'result',paths:[d.path],payload:{resultId:result.id}}),/snapshot changed/)
}))

test('SQL rejects non-finite computed numbers instead of returning misleading nulls',async()=>fixture(async ctx=>{
  const d=await approve(ctx,await importCsv(ctx,'finite.csv','id,value\na,1\n'))
  await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[d.path],payload:{datasetIds:[d.id],sql:'SELECT 1e999 AS infinite'}}),/non-finite/)
}))

test('SQLite authorizer rejects writes, extra statements, metadata, extensions and unselected tables even inside CTEs',async()=>fixture(async ctx=>{
  const a=await approve(ctx,await importCsv(ctx,'selected.csv','id,value\na,10\n')),b=await approve(ctx,await importCsv(ctx,'private.csv','id,value\nb,20\n'))
  const ta=ctx.engine.store.dataset(a.id).typedTable,tb=ctx.engine.store.dataset(b.id).typedTable
  for(const sql of [`DELETE FROM "${ta}"`,`SELECT * FROM "${ta}"; DELETE FROM "${ta}"`,'PRAGMA database_list',"ATTACH DATABASE ':memory:' AS other",'SELECT * FROM analytics_files','SELECT * FROM sqlite_master',`WITH stolen AS (SELECT * FROM "${tb}") SELECT * FROM stolen`,"SELECT load_extension('x')","SELECT * FROM pragma_table_info('analytics_files')"]){
    await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[a.path,b.path],payload:{datasetIds:[a.id],sql}}))
  }
  assert.equal((await run(ctx,a,{metrics:[{op:'count',as:'n'}]})).rows[0].n,'1')
  await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[a.path],payload:{datasetIds:[b.id],sql:'SELECT 1'}}),/selected-file/)
  await fs.writeFile(a.path,'id,value\na,99\n')
  await assert.rejects(()=>ctx.engine.execute({action:'sql',paths:[a.path],payload:{datasetIds:[a.id],sql:'SELECT 1'}}),/source file changed/)
}))

test('decimal lexemes, scientific notation, exact scales and BigInt display',()=>{assert.deepEqual(decimal('1.23e2'),{coefficient:123n,scale:0});assert.equal(scaled('0.10',2),10n);assert.equal(display(-125n,2),'-1.25');assert.equal(divide(1n,8n,2),'0.13');assert.equal(divide(1n,0n),null);assert.throws(()=>scaled('1.234',2),/No rounding/);assert.throws(()=>scaled('9223372036854775808',0),/64-bit/);assert.throws(()=>decimal('1,234'),/unambiguous/)})
test('settings are bounded and do not change embedding configuration',()=>{assert.equal(settings({}).maxFileMiB,2048);assert.throws(()=>settings({maxRows:-1}));assert.throws(()=>settings({queryTimeoutSeconds:99999}))})
test('agent preparation consent defaults off and rejects non-boolean settings',()=>{assert.equal(settings({}).allowAgentPreparation,false);assert.equal(settings({allowAgentPreparation:true}).allowAgentPreparation,true);assert.throws(()=>settings({allowAgentPreparation:'true'}),/consent/)})
test('automatic approval defaults off, requires preparation consent and accepts only saved booleans',()=>{
  assert.equal(settings({allowAgentPreparation:true}).allowAgentApproval,false)
  assert.throws(()=>settings({allowAgentPreparation:true,allowAgentApproval:'true'}),/approval consent/)
  assert.throws(()=>settings({allowAgentApproval:true}),/Enable agent preparation/)
  assert.equal(settings({allowAgentPreparation:true,allowAgentApproval:true}).allowAgentApproval,true)
})
test('agent preparation requires saved consent before importing anything',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'selected.csv');await fs.writeFile(file,'id,value\na,1\n');await assert.rejects(()=>ctx.engine.execute({action:'prepare',paths:[file]}),/Allow agent preparation/);assert.equal(ctx.engine.store.file(file),undefined)}))
test('model-supplied approval flags cannot enable publication when saved approval is off',async()=>fixture(async ctx=>{
  const file=path.join(ctx.source,'records.csv');await fs.writeFile(file,'id,value\na,10\n')
  const result=await ctx.engine.execute({action:'prepare',paths:[file],payload:{allowAgentApproval:true,confirmed:true}})
  assert.equal(result.value.preparation.approvedTables,0);assert.equal(result.value.preparation.draftTables,1)
  const d=ctx.engine.store.datasets([file])[0].data
  const proposal=await ctx.engine.execute({action:'propose-policy',paths:[file],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One record',confirmed:true}}})
  assert.equal(proposal.value.approved,false);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review')
}, {allowAgentPreparation:true}))
test('automatic approval enables full native querying without a manual review or invented keys/units',async()=>fixture(async ctx=>{
  const d=await importCsv(ctx,'records.csv','id,amount\na,10\nb,20\n')
  const result=await ctx.engine.execute({action:'prepare',paths:[d.path]})
  assert.equal(result.value.preparation.approvedTables,1);assert.equal(result.value.preparation.readyTables,1);assert.equal(result.value.preparation.draftTables,0);assert.equal(result.value.preparation.approvalRequired,false)
  const ready=ctx.engine.store.dataset(d.id).data
  assert.equal(ready.status,'ready');assert.equal(ready.approval.by,'agent');assert.equal(ready.policy.confirmed,false);assert.equal(ready.preparedPolicy,undefined)
  assert.deepEqual(ready.policy.key,[]);assert.equal(ready.policy.columns[1].unit,'')
  assert.notEqual(ready.generation,d.generation);assert.equal(result.policyChanges[0].previousGeneration,d.generation);assert.equal(result.value.datasets[0].approval.by,'agent')
  const query=await run(ctx,ready,{metrics:[{op:'sum',column:'c1',as:'total'}]})
  assert.equal(query.rows[0].total,'30');assert.ok(query.warnings.some(w=>w.includes('mechanical column statistics')));assert.ok(query.warnings.some(w=>w.includes('automatically approved by the agent')))
}, {allowAgentPreparation:true,allowAgentApproval:true}))
test('automatic preparation finishes existing drafts and remains idempotent',async()=>fixture(async ctx=>{
  const file=path.join(ctx.source,'records.csv');await fs.writeFile(file,'name\nA\n')
  const drafted=await ctx.engine.execute({action:'prepare',paths:[file]});assert.equal(drafted.value.preparation.draftTables,1)
  ctx.engine.settings.allowAgentApproval=true
  const approved=await ctx.engine.execute({action:'prepare',paths:[file]});assert.equal(approved.value.preparation.approvedTables,1);assert.equal(approved.value.preparation.existingDrafts,0)
  const generation=approved.sources[0].generation
  const repeat=await ctx.engine.execute({action:'prepare',paths:[file]});assert.equal(repeat.value.preparation.alreadyReady,1);assert.equal(repeat.value.preparation.approvedTables,0);assert.equal(repeat.sources[0].generation,generation)
}, {allowAgentPreparation:true}))
test('automatic approval preserves user-approved policies and isolates formulas, hidden rows and subtotals',async()=>fixture(async ctx=>{
  const plain=path.join(ctx.source,'plain.csv'),subtotal=path.join(ctx.source,'subtotal.csv'),hidden=path.join(ctx.source,'hidden.xlsx'),formula=path.join(ctx.source,'formula.xlsx')
  await fs.writeFile(plain,'id,amount\na,10\n');await fs.writeFile(subtotal,'name,amount\nA,10\nTotal,10\n');await xlsx(hidden,{hidden:true});await xlsx(formula,{formula:true})
  const user=await approve(ctx,await importCsv(ctx,'user.csv','id,amount\nb,20\n'))
  const result=await ctx.engine.execute({action:'prepare',paths:[plain,subtotal,hidden,formula,user.path]})
  const counts=result.value.preparation
  assert.equal(counts.approvedTables,1);assert.equal(counts.alreadyReady,1);assert.equal(counts.reviewTables,2);assert.equal(counts.draftTables,2);assert.equal(counts.blockedTables,1)
  assert.equal(ctx.engine.store.dataset(user.id).data.generation,user.generation);assert.equal(user.approval.by,'user')
  for(const file of [subtotal,hidden]){const d=ctx.engine.store.datasets([file])[0].data;assert.equal(d.status,'needs-review');assert.ok(d.preparedPolicy);await assert.rejects(()=>run(ctx,d,{metrics:[{op:'count',as:'rows'}]}),/not analytics-ready/)}
  const blocked=ctx.engine.store.datasets([formula])[0].data;assert.equal(blocked.status,'needs-review');assert.equal(blocked.preparedPolicy,undefined)
  assert.equal(result.value.preparation.issues.filter(issue=>issue.kind==='needs-review').length,2)
}, {allowAgentPreparation:true,allowAgentApproval:true}))
test('agent proposals can refine agent policies but cannot silently replace a user-approved policy',async()=>fixture(async ctx=>{
  const d=await importCsv(ctx,'records.csv','id,amount\na,10\nb,20\n')
  const first=await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One transaction'}}})
  assert.equal(first.value.approved,true);assert.equal(first.value.approvalRequired,false)
  const refined=await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:first.value.generation,policy:{key:['c0']}}})
  assert.equal(refined.value.approved,true);assert.notEqual(refined.value.generation,first.value.generation)
  const ready=ctx.engine.store.dataset(d.id).data;assert.deepEqual(ready.policy.key,['c0']);assert.equal(ready.warnings.filter(w=>w.startsWith('This policy was automatically approved')).length,1)
  const user=await approve(ctx,ready)
  assert.equal(user.approval.by,'user');assert.equal(user.policy.confirmed,true);assert.ok(!user.warnings.some(w=>w.startsWith('This policy was automatically approved')))
  const pending=await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:user.generation,policy:{grain:'One source transaction'}}})
  assert.equal(pending.value.approved,false);assert.match(pending.value.reviewReasons.join(' '),/user-approved/);assert.equal(ctx.engine.store.dataset(d.id).data.generation,user.generation)
}, {allowAgentPreparation:true,allowAgentApproval:true}))
test('saved caches and changed populations remain drafts even when automatic approval is enabled',async()=>fixture(async ctx=>{
  const formula=path.join(ctx.source,'formula.xlsx');await xlsx(formula,{formula:true});await ctx.engine.execute({action:'import',folder:ctx.source})
  const d=ctx.engine.store.datasets([formula])[0].data
  const cached=await ctx.engine.execute({action:'propose-policy',paths:[formula],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One sales record',formulaPolicy:'saved-cache'}}})
  assert.equal(cached.value.approved,false);assert.match(cached.value.reviewReasons.join(' '),/saved formula caches/)
  assert.ok(cached.value.warnings.some(w=>w.includes('User approval is pending')));assert.ok(!cached.value.warnings.some(w=>w.includes('explicitly accepted by the user')))
  const excluded=await ctx.engine.execute({action:'propose-policy',paths:[formula],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{formulaPolicy:'reject',firstRow:3}}})
  assert.equal(excluded.value.approved,false);assert.match(excluded.value.reviewReasons.join(' '),/row boundaries/);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review')
}, {allowAgentPreparation:true,allowAgentApproval:true}))
test('automatic proposal checks late invalid values, duplicate keys and stale sources before publishing',async()=>fixture(async ctx=>{
  const d=await importCsv(ctx,'late.csv','id,value\n'+Array.from({length:10},(_,i)=>`id${i},${i===9?'invalid':i}`).join('\n')+'\n')
  const request={action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One record',columns:[{id:'c1',type:'integer'}]}}}
  await assert.rejects(()=>ctx.engine.execute(request),/Row 11/);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review')
  const dup=await importCsv(ctx,'duplicates.csv','id,value\na,1\na,2\n')
  await assert.rejects(()=>ctx.engine.execute({action:'propose-policy',paths:[dup.path],payload:{datasetId:dup.id,expectedGeneration:dup.generation,policy:{grain:'One record',key:['c0']}}}),/not unique/)
  await fs.appendFile(d.path,'new,20\n');await assert.rejects(()=>ctx.engine.execute({...request,payload:{...request.payload,policy:{grain:'One record'}}}),/Source changed/)
  assert.equal(ctx.engine.store.dataset(d.id).typedTable,null);assert.equal(ctx.engine.store.dataset(dup.id).typedTable,null)
}, {allowAgentPreparation:true,allowAgentApproval:true}))
test('agent preparation imports only selected targets and never scans or prunes their folder',async()=>fixture(async ctx=>{const selected=path.join(ctx.source,'selected.csv'),other=path.join(ctx.source,'other.csv');await fs.writeFile(selected,'id,value\na,1\n');await fs.writeFile(other,'id,value\nb,2\n');const value=(await ctx.engine.execute({action:'prepare',paths:[selected]})).value;assert.equal(value.preparation.imported,1);assert.equal(value.preparation.approvalRequired,true);assert.equal(ctx.engine.store.datasets([selected])[0].data.status,'needs-review');assert.equal(ctx.engine.store.file(other),undefined);await ctx.engine.execute({action:'prepare',paths:[other]});await ctx.engine.execute({action:'prepare',paths:[selected]});assert.equal(ctx.engine.store.datasets([other]).length,1)}, {allowAgentPreparation:true}))
test('preparation rejects an expanded target scope before any import',async()=>fixture(async ctx=>{const selected=path.join(ctx.source,'selected.csv'),other=path.join(ctx.source,'other.csv');await fs.writeFile(selected,'id\na\n');await fs.writeFile(other,'id\nb\n');await assert.rejects(()=>ctx.engine.execute({action:'prepare',paths:[selected],payload:{paths:[selected,other]}}),/individually selected/);assert.equal(ctx.engine.store.files().length,0)}, {allowAgentPreparation:true}))
test('preparation resolves unique selected filenames, deduplicates them and preserves a requested subset',async()=>fixture(async ctx=>{
  const selected=path.join(ctx.source,'Survey data.csv'),other=path.join(ctx.source,'other.csv'),unselected=path.join(ctx.source,'unselected.csv')
  for(const file of [selected,other,unselected])await fs.writeFile(file,'answer\nAgree\n')
  const filename=process.platform==='win32'?'SURVEY DATA.CSV':'Survey data.csv'
  const result=await ctx.engine.execute({action:'prepare',paths:[selected,other],payload:{paths:[filename,selected,filename]}})
  assert.equal(result.value.preparation.selectedFileCount,1);assert.equal(result.value.preparation.imported,1);assert.equal(result.value.preparation.draftTables,1)
  assert.deepEqual(result.sources.map(source=>source.path),[selected]);assert.equal(ctx.engine.store.file(other),undefined);assert.equal(ctx.engine.store.file(unselected),undefined)
}, {allowAgentPreparation:true}))
test('ambiguous filenames reject the whole batch before import and full paths disambiguate',async()=>fixture(async ctx=>{
  const first=path.join(ctx.source,'first'),second=path.join(ctx.source,'second');await fs.mkdir(first);await fs.mkdir(second)
  const a=path.join(first,'records.csv'),b=path.join(second,'records.csv'),clear=path.join(ctx.source,'clear.csv')
  for(const file of [a,b,clear])await fs.writeFile(file,'id\nx\n')
  await assert.rejects(()=>ctx.engine.execute({action:'prepare',paths:[a,b,clear],payload:{paths:['clear.csv','records.csv']}}),/Ambiguous selected filename.*full selected path/)
  assert.equal(ctx.engine.store.files().length,0)
  const result=await ctx.engine.execute({action:'prepare',paths:[a,b],payload:{paths:[b]}})
  assert.equal(result.value.preparation.imported,1);assert.equal(ctx.engine.store.file(a),undefined);assert.equal(result.sources[0].path,b)
}, {allowAgentPreparation:true}))
test('filename preparation rejects unselected paths and relative directory aliases before import',async()=>fixture(async ctx=>{
  const selected=path.join(ctx.source,'selected.csv'),unselectedFolder=path.join(ctx.source,'other');await fs.mkdir(unselectedFolder)
  const other=path.join(unselectedFolder,'selected.csv');await fs.writeFile(selected,'id\na\n');await fs.writeFile(other,'id\nb\n')
  for(const target of [other,'other/selected.csv','other\\selected.csv','../source/selected.csv','not-selected.csv',...(process.platform==='win32'?['C:selected.csv']:[])]){
    await assert.rejects(()=>ctx.engine.execute({action:'prepare',paths:[selected],payload:{paths:['selected.csv',target]}}),/individually selected/)
    assert.equal(ctx.engine.store.files().length,0)
  }
}, {allowAgentPreparation:true}))
test('bulk preparation creates drafts despite optional keys, unknown units, mixed answers and other-table formula blockers',async()=>fixture(async ctx=>{
  const formula=path.join(ctx.source,'formula.xlsx'),plain=path.join(ctx.source,'records.csv'),survey=path.join(ctx.source,'survey.csv'),word=path.join(ctx.source,'notes.docx')
  await xlsx(formula,{formula:true});await fs.writeFile(plain,'name,amount\nA,10\nB,20\n');await fs.writeFile(survey,'answer\n10\nAgree\nUnknown\n');await fs.writeFile(word,'Unsupported table input')
  const result=await ctx.engine.execute({action:'prepare',paths:[formula,plain,survey,word]})
  assert.equal(result.value.preparation.draftsPrepared,2);assert.equal(result.value.preparation.blockedTables,1);assert.equal(result.value.preparation.unsupportedFiles,1);assert.equal(result.value.preparation.failedFiles,0)
  assert.equal(Object.keys(result.value)[0],'preparation');assert.equal(result.value.preparation.draftTables,2);assert.equal(result.value.preparation.issuesTruncated,false)
  assert.equal(result.value.preparation.issues.find(issue=>issue.kind==='unsupported-file').path,word)
  assert.match(result.value.preparation.issues.find(issue=>issue.kind==='blocked-table').reason,/contains a formula/)
  const draft=ctx.engine.store.datasets([plain])[0].data
  assert.equal(draft.preparedPolicy.validatedRows,2);assert.deepEqual(draft.preparedPolicy.policy.key,[]);assert.equal(draft.preparedPolicy.policy.columns[1].unit,'');assert.ok(draft.preparedPolicy.notes.some(note=>note.includes('provisional')))
  const answers=ctx.engine.store.datasets([survey])[0].data
  assert.equal(answers.preparedPolicy.policy.columns[0].type,'text');assert.equal(answers.preparedPolicy.validatedRows,3)
  const blocked=ctx.engine.store.datasets([formula])[0].data
  assert.equal(blocked.preparedPolicy,undefined);assert.match(blocked.preparationError,/contains a formula/)
  assert.equal(ctx.engine.store.file(word),undefined)
  assert.equal(result.value.datasets.find(d=>d.id===draft.id).preparationState,'draft-ready')
  assert.equal(result.value.datasets.find(d=>d.id===blocked.id).preparationState,'blocked')
}, {allowAgentPreparation:true}))
test('file inventories are drafted automatically and repeated preparation preserves model refinements',async()=>fixture(async ctx=>{
  const file=path.join(ctx.source,'inventory.csv');await fs.writeFile(file,'Name,Type,Size (bytes),Relative Path\na.txt,file,10,a.txt\nb.txt,file,20,b.txt\n')
  await ctx.engine.execute({action:'prepare',paths:[file]});const d=ctx.engine.store.datasets([file])[0].data
  assert.equal(d.preparedPolicy.policy.grain,'One directory entry (file or folder)');assert.equal(d.preparedPolicy.policy.columns[2].unit,'bytes');assert.equal(d.status,'needs-review');assert.equal(d.preparedPolicy.policy.confirmed,false)
  await ctx.engine.execute({action:'propose-policy',paths:[file],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One listed file',key:['c3']}}})
  const result=await ctx.engine.execute({action:'prepare',paths:[file]})
  assert.equal(result.value.preparation.existingDrafts,1);assert.equal(result.value.preparation.draftsPrepared,0)
  assert.equal(result.value.preparation.draftTables,1)
  assert.equal(ctx.engine.store.dataset(d.id).data.preparedPolicy.policy.grain,'One listed file');assert.deepEqual(ctx.engine.store.dataset(d.id).data.preparedPolicy.policy.key,['c3'])
}, {allowAgentPreparation:true}))
test('preparation lists a blocker beyond its first catalog page without another preparation call',async()=>fixture(async ctx=>{
  const paths=[];for(let i=0;i<26;i++){const file=path.join(ctx.source,`table${i}.csv`);paths.push(file);await fs.writeFile(file,'name\nA\n')}
  const formula=path.join(ctx.source,'blocked.xlsx'),empty=path.join(ctx.source,'empty.xlsx'),word=path.join(ctx.source,'notes.docx')
  await xlsx(formula,{formula:true});await xlsx(empty,{named:false})
  const zip=await JSZip.loadAsync(await fs.readFile(empty));zip.file('xl/worksheets/sheet1.xml','<worksheet><sheetData/></worksheet>');await fs.writeFile(empty,await zip.generateAsync({type:'nodebuffer'}))
  await fs.writeFile(word,'Narrative input');paths.push(formula,empty,word)
  const result=await ctx.engine.execute({action:'prepare',paths,payload:{paths:paths.map(file=>path.basename(file))}})
  assert.equal(result.value.preparation.draftTables,26);assert.equal(result.value.preparation.blockedTables,1);assert.equal(result.value.preparation.failedFiles,1);assert.equal(result.value.preparation.unsupportedFiles,1)
  assert.equal(result.value.preparation.issuesTruncated,false);assert.equal(result.value.preparation.issues.length,3)
  const blocker=result.value.preparation.issues.find(issue=>issue.kind==='blocked-table')
  assert.equal(blocker.path,formula);assert.equal(blocker.name,'SalesTable');assert.match(blocker.reason,/contains a formula/)
  assert.ok(!result.value.datasets.some(dataset=>dataset.id===blocker.datasetId));assert.equal(result.value.nextOffset,25)
  assert.equal(result.value.datasets[0].schemaOmitted,true);assert.equal(result.value.datasets[0].columns,undefined)
  assert.equal(result.sources.length,27);assert.ok(Buffer.byteLength(JSON.stringify(result.value))<64000)
  assert.equal(result.value.preparation.issues.find(issue=>issue.kind==='failed-file').path,empty)
}, {allowAgentPreparation:true}))
test('large preparation issue lists stay bounded without losing complete counters or pagination',async()=>fixture(async ctx=>{
  const paths=[];for(let i=0;i<128;i++){const file=path.join(ctx.source,`unsupported-narrative-file-${i}.docx`);paths.push(file);await fs.writeFile(file,'Narrative')}
  const result=await ctx.engine.execute({action:'prepare',paths})
  assert.equal(result.value.preparation.unsupportedFiles,128);assert.equal(result.value.preparation.selectedFileCount,128)
  assert.equal(result.value.preparation.issuesTruncated,true);assert.ok(result.value.preparation.issues.length<128)
  assert.equal(result.value.preparation.draftTables,0);assert.equal(result.value.nextFileOffset,16)
  assert.ok(Buffer.byteLength(JSON.stringify(result.value))<64000);assert.equal(ctx.engine.store.files().length,0)
}, {allowAgentPreparation:true}))
test('bulk preparation processes tables beyond the first catalog page and verifies their sources',async()=>fixture(async ctx=>{
  const paths=[];for(let i=0;i<26;i++){const file=path.join(ctx.source,`table${i}.csv`);paths.push(file);await fs.writeFile(file,'name\nA\n')}
  const result=await ctx.engine.execute({action:'prepare',paths})
  assert.equal(result.value.preparation.draftsPrepared,26);assert.equal(result.value.datasets.length,25);assert.equal(result.value.nextOffset,25);assert.equal(result.sources.length,26)
  assert.equal(ctx.engine.store.datasets([paths[25]])[0].data.preparedPolicy.validatedRows,1)
  await fs.appendFile(paths[25],'B\n');await assert.rejects(()=>ctx.engine.verify(result.sources,paths),/changed after import/)
}, {allowAgentPreparation:true}))
test('a blocked preparation records its reason until a validated explicit policy resolves it',async()=>fixture(async ctx=>{
  const file=path.join(ctx.source,'formulas.xlsx');await xlsx(file,{formula:true});await ctx.engine.execute({action:'prepare',paths:[file]})
  const d=ctx.engine.store.datasets([file])[0].data;assert.match(d.preparationError,/contains a formula/)
  await ctx.engine.execute({action:'propose-policy',paths:[file],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One sales record',formulaPolicy:'saved-cache'}}})
  const proposed=ctx.engine.store.dataset(d.id).data
  assert.equal(proposed.preparationError,undefined);assert.equal(proposed.preparedPolicy.validatedRows,2);assert.equal(proposed.preparedPolicy.policy.confirmed,false);assert.equal(proposed.status,'needs-review')
}, {allowAgentPreparation:true}))
test('valid agent policies are stored as unapproved drafts until explicit UI approval',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'files.csv','Name,Type,Size (bytes),Relative Path\na.txt,file,10,a.txt\nb.txt,file,20,b.txt\n');const proposal=(await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One listed file',key:['c3'],columns:[{id:'c2',unit:'bytes'},{id:'c3',role:'identifier'}],confirmed:true}}})).value;assert.equal(proposal.validatedRows,2);assert.equal(proposal.approved,false);const stored=ctx.engine.store.dataset(d.id);assert.equal(stored.data.status,'needs-review');assert.equal(stored.data.generation,d.generation);assert.equal(stored.data.policy.grain,'');assert.equal(stored.data.preparedPolicy.policy.confirmed,false);assert.equal(stored.typedTable,null);assert.equal(stored.data.preparedPolicy.policy.columns.length,4);await assert.rejects(()=>run(ctx,d,{metrics:[{op:'count',as:'n'}]}),/not analytics-ready/);const ready=await approve(ctx,d,stored.data.preparedPolicy.policy.confirmed?{}:{...stored.data.preparedPolicy.policy,confirmed:true});assert.equal(ready.rows,2);assert.equal(ready.preparedPolicy,undefined);assert.equal((await run(ctx,ready,{metrics:[{op:'sum',column:'c2',as:'bytes'}]})).rows[0].bytes,'30')}, {allowAgentPreparation:true}))
test('draft validation checks types and duplicate keys beyond the preview and publishes nothing on failure',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'late-invalid.csv','id,value\n'+Array.from({length:10},(_,i)=>`id${i},${i===9?'invalid':i}`).join('\n')+'\n');await assert.rejects(()=>ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One record',columns:[{id:'c1',type:'integer'}]}}}),/Row 11/);assert.equal(ctx.engine.store.dataset(d.id).data.preparedPolicy,undefined);const dup=await importCsv(ctx,'late-duplicate.csv','id,value\n'+Array.from({length:10},(_,i)=>`id${i===9?0:i},${i}`).join('\n')+'\n');await assert.rejects(()=>ctx.engine.execute({action:'propose-policy',paths:[dup.path],payload:{datasetId:dup.id,expectedGeneration:dup.generation,policy:{grain:'One record',key:['c0']}}}),/not unique/);assert.equal(ctx.engine.store.dataset(dup.id).data.preparedPolicy,undefined);assert.equal(ctx.engine.store.dataset(dup.id).typedTable,null)}, {allowAgentPreparation:true}))
test('policy drafts reject unselected datasets, stale generations and changed source bytes',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'draft.csv','id,value\na,1\n'),request={action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One record'}}};await assert.rejects(()=>ctx.engine.execute({...request,paths:[path.join(ctx.source,'other.csv')]}),/selected scope/);await assert.rejects(()=>ctx.engine.execute({...request,payload:{...request.payload,expectedGeneration:'old'}}),/Dataset changed/);await fs.appendFile(d.path,'b,2\n');await assert.rejects(()=>ctx.engine.execute(request),/Source changed/);assert.equal(ctx.engine.store.dataset(d.id).data.preparedPolicy,undefined)}, {allowAgentPreparation:true}))
test('preparing a replacement policy preserves ready queries until the user applies it',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'ready.csv','id,value\na,1\nb,2\n'));const original=await run(ctx,d,{metrics:[{op:'sum',column:'c1',as:'total'}]});await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One filtered record',firstRow:3}}});const stored=ctx.engine.store.dataset(d.id).data;assert.equal(stored.status,'ready');assert.equal(stored.generation,d.generation);assert.equal(stored.policy.firstRow,2);assert.equal(stored.preparedPolicy.validatedRows,1);assert.equal((await run(ctx,d,{metrics:[{op:'sum',column:'c1',as:'total'}]})).rows[0].total,'3');assert.equal((await ctx.engine.execute({action:'result',paths:[d.path],payload:{resultId:original.id}})).value.id,original.id)}, {allowAgentPreparation:true}))
test('partial column proposals preserve unpaged columns and explicit exclusions',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'wide.csv','a,b,c\nx,1,10\ny,2,20\nz,3,30\n');await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One record',skipRows:[3],columns:[{id:'c2',unit:'items'}]}}});const p=ctx.engine.store.dataset(d.id).data.preparedPolicy.policy;assert.equal(p.columns.length,3);assert.deepEqual(p.skipRows,[3]);assert.equal(p.columns[2].unit,'items');assert.equal(ctx.engine.store.dataset(d.id).data.preparedPolicy.validatedRows,2)}, {allowAgentPreparation:true}))
test('streaming CSV retains quoted multiline records across every character boundary',async()=>{const rows=[];for await(const row of delimited(chunks('id,text\r\n001,"a\r\nb"\r\n002,"x""y"\r\n'),',',limits))rows.push(row);assert.equal(rows.length,3);assert.equal(rows[1].cells[2].value,'a\r\nb');assert.equal(rows[2].cells[2].value,'x"y');assert.equal(rows[1].cells[1].value,'001');await assert.rejects(async()=>{for await(const _ of delimited(chunks('a\n"oops'),',',limits)){/* Consume input to reach parser errors. */}},/Unclosed/)})
test('lossless JSON preserves large numbers and nested JSON without flattening arrays',()=>{const r=jsonRecord('{"id":9007199254740993,"amount":0.10,"nested":{"a":[1,2]},"s":"\\u65e5"}');assert.equal(r.id.value,'9007199254740993');assert.equal(r.amount.value,'0.10');assert.equal(r.nested.value,'{"a":[1,2]}');assert.equal(r.s.value,'日');assert.throws(()=>jsonRecord('{"a":1,"a":2}'),/Duplicate/);assert.throws(()=>jsonRecord('{"a":01}'))})
test('streaming JSON array rejects truncation and trailing commas',async()=>{const rows=[];for await(const row of jsonArray(chunks('[{"a":1},{"a":"x}y"}]'),limits))rows.push(row);assert.equal(rows.length,2);await assert.rejects(async()=>{for await(const _ of jsonArray(chunks('[{"a":1},]'),limits)){/* Consume input to reach parser errors. */}},/Expected/);await assert.rejects(async()=>{for await(const _ of jsonArray(chunks('[{"a":1}'),limits)){/* Consume input to reach parser errors. */}},/Incomplete/)})
test('streaming XML keeps complete rows and rejects DTDs and mismatched tags',async()=>{const bytes=async function*(s){for await(const part of chunks(s,2))yield Buffer.from(part)};const rows=[];for await(const x of xmlFragments(bytes('<s><row r="1"><c><v>12</v></c></row><row r="2"/></s>'),'row',limits))rows.push(x);assert.equal(rows.length,2);await assert.rejects(async()=>{for await(const _ of xmlFragments(bytes('<!DOCTYPE s><s/>'),'row',limits)){/* Consume input to reach parser errors. */}},/forbidden/);await assert.rejects(async()=>{for await(const _ of xmlFragments(bytes('<s><row></s>'),'row',limits)){/* Consume input to reach parser errors. */}},/Mismatched/)})
test('imports require human schema review; SQL cannot analyze unreviewed rows',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'sales.csv','id,amount\n001,0.10\n002,0.20\n');assert.equal(d.status,'needs-review');assert.equal(d.policy.columns[0].type,'text');await assert.rejects(()=>run(ctx,d,{metrics:[{op:'count',as:'n'}]}),/not analytics-ready/);const ready=await approve(ctx,d,{key:['c0']});assert.equal(ready.rows,2);assert.equal(ready.excludedRows,1);const q=await run(ctx,ready,{metrics:[{op:'sum',column:'c1',as:'total'},{op:'count',as:'n'}]});assert.equal(q.rows[0].total,'0.3');assert.equal(q.rows[0].n,'2');assert.equal(q.inputSampled,false)}))
test('SUM remains exact above 64-bit total; large IDs and integers do not pass through Number',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'big.csv','identifier,value\n9007199254740993,9000000000000000000\n9007199254740994,9000000000000000000\n');const ready=await approve(ctx,d);const q=await run(ctx,ready,{metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(q.rows[0].total,'18000000000000000000');const detail=await run(ctx,ready,{columns:['c0']});assert.equal(detail.rows[0].c0,'9007199254740993')}))
test('query parameters resist SQL injection and raw SQL is not exposed',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'names.csv','name,value\nnormal,1\n"x\'); DROP TABLE analytics_files; --",2\n'));const q=await run(ctx,d,{filters:[{column:'c0',op:'eq',value:"x'); DROP TABLE analytics_files; --"}],metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(q.rows[0].total,'2');assert.ok(ctx.engine.store.file(d.path));await assert.rejects(()=>run(ctx,d,{sql:'ATTACH DATABASE secret'}),/Raw SQL/);await assert.rejects(()=>run(ctx,d,{metrics:[{op:'sum',column:'c1); DROP TABLE x',as:'total'}]}),/Unknown column/)}))
test('population aggregates are complete even when output groups are capped for display',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'groups.csv','group,value\nA,1\nB,2\nC,3\nD,4\n'));const q=await run(ctx,d,{groupBy:[{column:'c0',as:'category'}],metrics:[{op:'sum',column:'c1',as:'total'}],orderBy:[{column:'total',descending:true}],limit:2});assert.equal(q.population.matchedRows,4);assert.equal(q.totalResultRows,4);assert.equal(q.rows.length,2);assert.equal(q.rows[0].total,'4');assert.equal(q.outputTruncated,true);assert.equal(q.inputSampled,false)}))
test('NULL count, mean and exact quantiles have explicit denominator behavior',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'null.csv','id,value\na,1\nb,2\nc,\nd,9\n'));const q=await run(ctx,d,{metrics:[{op:'count',as:'all'},{op:'count',column:'c1',as:'non_null'},{op:'mean',column:'c1',as:'mean'}]});assert.equal(q.rows[0].all,'4');assert.equal(q.rows[0].non_null,'3');assert.equal(q.rows[0].mean.value,'4.000000');const s=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'describe',column:'c1'}})).value;assert.equal(s.summary.missing,1);assert.equal(s.summary.median.value,'2.000000');assert.equal(s.summary.q1.value,'1.500000');assert.equal(s.summary.sampleVariance,19)}))

test('unselected datasets and saved receipts are denied even when present in the database',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'a.csv','id,value\na,1\n'));const b=await approve(ctx,await importCsv(ctx,'b.csv','id,value\nb,2\n'));await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path],payload:{datasetIds:[b.id],metrics:[{op:'count',as:'n'}]}}),/selected-file scope/);const q=await run(ctx,b,{metrics:[{op:'count',as:'n'}]});await assert.rejects(()=>ctx.engine.execute({action:'result',paths:[a.path],payload:{resultId:q.id}}),/selected-file scope/);const catalog=(await ctx.engine.execute({action:'discover',paths:[a.path],payload:{}})).value;assert.equal(catalog.datasets.length,1);assert.equal(catalog.datasets[0].id,a.id)}))
test('mixed currencies require grouping or a complete single-currency filter',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'money.csv','id,amount,currency\na,10,JPY\nb,20,USD\n'),{currencyColumn:'c2'});await assert.rejects(()=>run(ctx,d,{metrics:[{op:'sum',column:'c1',as:'total'}]}),/Currency scope/);const grouped=await run(ctx,d,{groupBy:[{column:'c2',as:'currency'}],metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(grouped.rows.length,2);const filtered=await run(ctx,d,{filters:[{column:'c2',op:'eq',value:'JPY'}],metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(filtered.rows[0].total,'10')}))
test('declared keys reject duplicates and nulls before publishing an approved table',async()=>fixture(async ctx=>{let d=await importCsv(ctx,'dups.csv','id,value\na,1\na,2\n');await assert.rejects(()=>approve(ctx,d,{key:['c0']}),/not unique/);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review');d=await importCsv(ctx,'missing.csv','id,value\n,1\na,2\n');await assert.rejects(()=>approve(ctx,d,{key:['c0']}),/missing values/)}))
test('unions require identical schemas and disjoint business keys',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'a.csv','id,value\na,10\n'),{key:['c0']});const b=await approve(ctx,await importCsv(ctx,'b.csv','id,value\nb,20\n'),{key:['c0']});const q=(await ctx.engine.execute({action:'query',paths:[a.path,b.path],payload:{datasetIds:[a.id,b.id],metrics:[{op:'sum',column:'c1',as:'total'}]}})).value;assert.equal(q.rows[0].total,'30');assert.equal(q.sources.length,2);const c=await approve(ctx,await importCsv(ctx,'c.csv','id,value\na,30\n'),{key:['c0']});await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path,c.path],payload:{datasetIds:[a.id,c.id],metrics:[{op:'count',as:'n'}]}}),/Overlapping row keys/)}))
test('identical copied exports and missing-key unions are blocked',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'a.csv','id,value\na,10\n'),{key:['c0']});const b=await approve(ctx,await importCsv(ctx,'copy.csv','id,value\na,10\n'),{key:['c0']});await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path,b.path],payload:{datasetIds:[a.id,b.id],metrics:[{op:'count',as:'n'}]}}),/Identical source-file/);const c=await approve(ctx,await importCsv(ctx,'nokey.csv','id,value\nc,20\n'));await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[c.path,a.path],payload:{datasetIds:[c.id,a.id],metrics:[{op:'count',as:'n'}]}}),/schemas|key/)}))
test('many-to-one joins preserve fact grain and report unmatched left rows',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'lines.csv','id,product,amount\nl1,p1,10\nl2,p1,20\nl3,p2,30\n'),{key:['c0']});const b=await approve(ctx,await importCsv(ctx,'products.csv','product,category\np1,Alpha\n'),{key:['c0']});const q=(await ctx.engine.execute({action:'query',paths:[a.path,b.path],payload:{datasetIds:[a.id],join:{datasetId:b.id,leftKeys:['c1'],rightKeys:['c0'],kind:'left'},groupBy:[{column:'right.c1',as:'category'}],metrics:[{op:'sum',column:'c2',as:'total'}]}})).value;assert.equal(q.population.matchedRows,3);assert.equal(q.population.unmatchedJoinRowsBeforeFilters,1);assert.equal(q.rows.find(r=>r.category==='Alpha').total,'30')}))
test('join fan-out and summing repeated lookup-side measures are rejected',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'facts.csv','product,amount\np1,10\np1,20\n'));const b=await approve(ctx,await importCsv(ctx,'lookup.csv','product,price\np1,4\np1,5\n'));const spec={datasetIds:[a.id],join:{datasetId:b.id,leftKeys:['c0'],rightKeys:['c0'],kind:'left'},metrics:[{op:'sum',column:'c1',as:'total'}]};await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path,b.path],payload:spec}),/multiply fact rows/);const c=await approve(ctx,await importCsv(ctx,'unique.csv','product,price\np1,4\n'),{key:['c0']});await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path,c.path],payload:{...spec,join:{...spec.join,datasetId:c.id},metrics:[{op:'sum',column:'right.c1',as:'total'}]}}),/double-count/)}))
test('same-length edits with restored mtime invalidate SQL and historical receipts',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'file.csv','id,value\na,10\n'));const q=await run(ctx,d,{metrics:[{op:'sum',column:'c1',as:'total'}]});const s=await fs.stat(d.path);await fs.writeFile(d.path,'id,value\na,90\n');await fs.utimes(d.path,s.atime,s.mtime);const status=await ctx.engine.execute({action:'statuses',paths:[d.path],verify:true});assert.equal(status[0].state,'changed');await assert.rejects(()=>run(ctx,d,{metrics:[{op:'count',as:'n'}]}),/changed after import/);await assert.rejects(()=>ctx.engine.execute({action:'result',paths:[d.path],payload:{resultId:q.id}}),/changed after import/)}))
test('re-importing unchanged files reuses the approved generation without embeddings',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'same.csv','id,value\na,10\n'));const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.unchanged,1);assert.equal(ctx.engine.store.dataset(d.id).data.generation,d.generation);assert.equal(ctx.engine.store.dataset(d.id).data.status,'ready')}))
test('invalid typed values fail the entire approval instead of dropping bad records',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'mixed.csv','id,amount\na,10\nb,oops\n');const columns=d.policy.columns.map((c,i)=>i===1?{...c,type:'integer',role:'measure'}:c);await assert.rejects(()=>approve(ctx,d,{columns}),/Row 3/);assert.equal(ctx.engine.store.dataset(d.id).typedTable,null);assert.equal(ctx.engine.store.dataset(d.id).data.rows,0)}))
test('explicit source-row exclusions prevent subtotal double counting and are audited',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'totals.csv','item,value\na,10\nb,20\nTotal,30\n');assert.ok(d.warnings.some(w=>w.includes('subtotal')));const ready=await approve(ctx,d,{skipRows:[4]});assert.equal(ready.excludedRows,2);const q=await run(ctx,ready,{metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(q.rows[0].total,'30');assert.equal(q.population.sourceRows[0].excludedByPolicy,2)}))
test('period grouping uses validated dates and numeric aggregate ordering is not lexicographic',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'dates.csv','posted,value\n2026-01-01,2\n2026-02-01,10\n'));const q=await run(ctx,d,{groupBy:[{column:'c0',period:'month',as:'month'}],metrics:[{op:'sum',column:'c1',as:'total'}],orderBy:[{column:'total',descending:true}]});assert.equal(q.rows[0].month,'2026-02');assert.equal(q.rows[0].total,'10')}))
test('period contributions reconcile exactly; percentages use explicit denominators',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'periods.csv','date,product,amount\n2026-01-02,A,100\n2026-01-02,B,100\n2026-04-02,A,60\n2026-04-02,B,110\n'));const r=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'compare-periods',column:'c2',dateColumn:'c0',groupColumn:'c1',current:{from:'2026-04-01',to:'2026-07-01'},previous:{from:'2026-01-01',to:'2026-04-01'}}})).value;assert.equal(r.summary.current,'170');assert.equal(r.summary.previous,'200');assert.equal(r.summary.change,'-30');assert.equal(r.summary.reconciled,true);assert.equal(r.rows[0].group,'A');assert.equal(r.rows[0].change,'-40');assert.equal(r.rows[0].contributionToNetChangePercent,'133.3333')}))
test('correlation uses all valid pairs and does not invent significance or causation',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'pairs.csv','x,y\n1,2\n2,4\n3,6\n4,\n'));const r=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'correlation',column:'c0',otherColumn:'c1'}})).value;assert.equal(r.summary.pairedRows,3);assert.equal(r.summary.excludedMissingPairs,1);assert.ok(Math.abs(r.summary.coefficient-1)<1e-14);assert.match(r.summary.interpretation,/not causation/)}))
test('drill-down retains original filters and returns exact source row references',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'drill.csv','category,value\nA,1\nB,2\nA,3\n'));const q=await run(ctx,d,{filters:[{column:'c0',op:'eq',value:'A'}],metrics:[{op:'sum',column:'c1',as:'total'}]});const detail=(await ctx.engine.execute({action:'drill',paths:[d.path],payload:{resultId:q.id,filters:[{column:'c1',op:'gt',value:'1'}],columns:['c0','c1']}})).value;assert.equal(detail.rows.length,1);assert.equal(detail.rows[0].__source_row,'4');assert.equal(detail.rows[0].c1,'3');assert.equal(detail.population.matchedRows,1)}))
test('clearing analytical data removes receipts but preserves source files, chats and RAG data',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'clear.csv','id,value\na,1\n'));const q=await run(ctx,d,{metrics:[{op:'count',as:'n'}]});await fs.writeFile(path.join(ctx.state,'conversations.sqlite3'),'chat sentinel');await fs.writeFile(path.join(ctx.state,'rag.sqlite3'),'rag sentinel');await ctx.engine.execute({action:'clear',folder:ctx.source});assert.equal(ctx.engine.store.result(q.id),undefined);assert.equal(ctx.engine.store.datasets().length,0);assert.equal(await fs.readFile(d.path,'utf8'),'id,value\na,1\n');assert.equal(await fs.readFile(path.join(ctx.state,'conversations.sqlite3'),'utf8'),'chat sentinel');assert.equal(await fs.readFile(path.join(ctx.state,'rag.sqlite3'),'utf8'),'rag sentinel')}))
test('a row-limit failure does not publish a partially imported source',async()=>fixture(async ctx=>{await fs.writeFile(path.join(ctx.source,'too-big.csv'),'id,value\na,1\nb,2\nc,3\n');const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.failed,1);assert.equal(ctx.engine.store.datasets().length,0);assert.equal(ctx.engine.store.files()[0].state,'failed')},{maxRows:2}))
test('hidden files and subdirectories are excluded unless recursion is explicitly enabled',async()=>fixture(async ctx=>{await fs.mkdir(path.join(ctx.source,'sub'));await fs.writeFile(path.join(ctx.source,'sub','data.csv'),'id,value\na,1\n');await fs.writeFile(path.join(ctx.source,'.hidden.csv'),'id,value\na,2\n');let p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.scanned,0);p=await ctx.engine.execute({action:'import',folder:ctx.source,recursive:true});assert.equal(p.scanned,1);assert.equal(ctx.engine.store.datasets().length,1)}))
test('malformed UTF-8 and JSON truncation fail instead of publishing corrupted text',async()=>fixture(async ctx=>{await fs.writeFile(path.join(ctx.source,'bad.csv'),Buffer.from([0x61,0x0a,0xc3,0x28]));await fs.writeFile(path.join(ctx.source,'bad.json'),'[{"a":1},');const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.failed,2);assert.equal(ctx.engine.store.datasets().length,0)}))
async function xlsx(file,{named=true,formula=false,missingCache=false,hidden=false,duplicateString=false}={}){
  const zip=new JSZip()
  zip.file('xl/workbook.xml','<workbook xmlns:r="urn:r"><workbookPr date1904="0"/><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://x/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://x/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
  zip.file('xl/sharedStrings.xml','<sst><si><t>id</t></si><si><t>amount</t></si><si><t>posted</t></si><si><t>001</t></si><si><r><t>00</t></r><r><t>2</t></r></si></sst>')
  zip.file('xl/styles.xml','<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
  zip.file('xl/worksheets/sheet1.xml',`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2">${formula?'<f>1+2</f>':''}${missingCache?'':'<v>3.25</v>'}</c><c r="C2" s="1"><v>45292</v></c></row><row r="3" ${hidden?'hidden="1"':''}><c r="A3" t="s"><v>${duplicateString?'3':'4'}</v></c><c r="B3"><v>4.75</v></c><c r="C3" s="1"><v>45293</v></c></row>${named?'<row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><v>8</v></c></row>':''}</sheetData>${named?'<tableParts count="1"><tablePart r:id="table1" xmlns:r="urn:r"/></tableParts>':''}</worksheet>`)
  if(named){zip.file('xl/worksheets/_rels/sheet1.xml.rels','<Relationships><Relationship Id="table1" Type="http://x/table" Target="../tables/table1.xml"/></Relationships>');zip.file('xl/tables/table1.xml','<table name="SalesTable" displayName="SalesTable" ref="A1:C4" totalsRowCount="1"><tableColumns><tableColumn id="1" name="id"/><tableColumn id="2" name="amount"/><tableColumn id="3" name="posted"/></tableColumns></table>')}
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))
}
test('XLSX streams named tables, shared strings, dates and excludes declared totals',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'sales.xlsx');await xlsx(file);const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.failed,0,JSON.stringify(ctx.engine.store.files()));const d=ctx.engine.store.datasets([file])[0].data;assert.equal(d.kind,'xlsx-named-table');assert.equal(d.policy.columns[2].type,'date');assert.equal(d.preview[1].values[2],'2024-01-01');assert.equal(d.preview[2].values[0],'002');const ready=await approve(ctx,d,{key:['c0']});const q=await run(ctx,ready,{metrics:[{op:'sum',column:'c1',as:'total'}]});assert.equal(q.rows[0].total,'8.00');assert.equal(ready.rows,2)}))
test('preparation suggests visible Excel headers when named-table metadata is generic',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'generic.xlsx');await xlsx(file);const zip=await JSZip.loadAsync(await fs.readFile(file));const table=await zip.file('xl/tables/table1.xml').async('string');zip.file('xl/tables/table1.xml',table.replace('name="id"','name="Column1"').replace('name="amount"','name="Column2"').replace('name="posted"','name="Column3"'));await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));await ctx.engine.execute({action:'prepare',paths:[file]});const d=ctx.engine.store.datasets([file])[0].data;assert.equal(d.policy.columns[0].name,'Column1');const described=(await ctx.engine.execute({action:'describe',paths:[file],payload:{datasetId:d.id}})).value;assert.deepEqual(described.suggestedPolicy.columns.map(c=>c.name),['id','amount','posted']);assert.equal(described.suggestionsAreUnapproved,true);await ctx.engine.execute({action:'propose-policy',paths:[file],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One sales record',columns:described.suggestedPolicy.columns,key:['c0']}}});assert.equal(ctx.engine.store.dataset(d.id).data.preparedPolicy.policy.columns[0].name,'id')}, {allowAgentPreparation:true}))
test('explicit units are suggested from column headers and refreshed source generations discard drafts',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'files.csv','Name,Size (bytes),Relative Path\na,10,a\n');const described=(await ctx.engine.execute({action:'describe',paths:[d.path],payload:{datasetId:d.id}})).value;assert.equal(described.suggestedPolicy.columns[1].unit,'bytes');assert.equal(described.suggestedPolicy.columns[2].role,'identifier');await ctx.engine.execute({action:'propose-policy',paths:[d.path],payload:{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One file',columns:described.suggestedPolicy.columns}}});await fs.appendFile(d.path,'b,20,b\n');await ctx.engine.execute({action:'prepare',paths:[d.path]});const fresh=ctx.engine.store.dataset(d.id).data;assert.notEqual(fresh.generation,d.generation);assert.equal(fresh.preparedPolicy.validatedRows,2);assert.equal(fresh.preparedPolicy.policy.confirmed,false);assert.equal(fresh.status,'needs-review')}, {allowAgentPreparation:true}))
test('XLSX formulas are rejected by default; explicit cache approval is recorded',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'formula.xlsx');await xlsx(file,{formula:true});await ctx.engine.execute({action:'import',folder:ctx.source});const d=ctx.engine.store.datasets([file])[0].data;await assert.rejects(()=>approve(ctx,d),/contains a formula/);const ready=await approve(ctx,d,{formulaPolicy:'saved-cache'});assert.equal(ready.formulaCells,1);assert.ok(ready.warnings.some(w=>w.includes('explicitly accepted')))}))
test('missing formula caches cannot be treated as zeros, even with cache approval',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'missing.xlsx');await xlsx(file,{formula:true,missingCache:true});await ctx.engine.execute({action:'import',folder:ctx.source});const d=ctx.engine.store.datasets([file])[0].data;await assert.rejects(()=>approve(ctx,d,{formulaPolicy:'saved-cache'}),/no saved value/)}))
test('hidden XLSX rows follow an explicit policy and excluded counts are visible',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'hidden.xlsx');await xlsx(file,{hidden:true});await ctx.engine.execute({action:'import',folder:ctx.source});const d=ctx.engine.store.datasets([file])[0].data;const a=await approve(ctx,d);assert.equal(a.rows,1);assert.equal(a.excludedRows,2);const b=await approve(ctx,a,{includeHiddenRows:true});assert.equal(b.rows,2)}))
test('unnamed worksheet regions remain review-required rather than guessed complete tables',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'region.xlsx');await xlsx(file,{named:false});await ctx.engine.execute({action:'import',folder:ctx.source});const d=ctx.engine.store.datasets([file])[0].data;assert.equal(d.kind,'xlsx-sheet-region');assert.equal(d.status,'needs-review');assert.ok(d.warnings.some(w=>w.includes('No named Excel table')))}))
test('corrupted XLSX ZIP content is rejected by CRC or decompression validation',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'corrupt.xlsx');await xlsx(file);const b=await fs.readFile(file);let central=0;for(;;){central=b.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),central);assert.ok(central>=0,'workbook central entry exists');const length=b.readUInt16LE(central+28);if(b.subarray(central+46,central+46+length).toString()==='xl/workbook.xml')break;central+=46+length+b.readUInt16LE(central+30)+b.readUInt16LE(central+32)}b.writeUInt32LE(1234,central+16);await fs.writeFile(file,b);const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.failed,1);assert.equal(ctx.engine.store.datasets().length,0)}))
test('schema generations invalidate previous receipts after policy changes',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'policy.csv','id,value\na,1\nb,2\n'));const q=await run(ctx,d,{metrics:[{op:'sum',column:'c1',as:'total'}]});await approve(ctx,d,{skipRows:[3]});await assert.rejects(()=>ctx.engine.execute({action:'result',paths:[d.path],payload:{resultId:q.id}}),/generation changed/)}))
test('constant-column correlation returns undefined, not invented evidence',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'constant.csv','x,y\n1,2\n1,3\n'));const q=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'correlation',column:'c0',otherColumn:'c1'}})).value;assert.equal(q.summary.coefficient,null);assert.ok(q.warnings.some(w=>w.includes('undefined')))}))
test('deleted files are pruned after complete enumeration; other roots remain isolated',async()=>fixture(async ctx=>{const d=await importCsv(ctx,'remove.csv','id,value\na,1\n');await fs.unlink(d.path);await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(ctx.engine.store.dataset(d.id),undefined);await assert.rejects(()=>ctx.engine.execute({action:'import',folder:ctx.state}),/outside/)}))
test('statistical operations never make an embedding/network request',async()=>fixture(async ctx=>{const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Network must not be used')};try{const d=await approve(ctx,await importCsv(ctx,'offline.csv','id,value\na,1\nb,2\n'));const q=await run(ctx,d,{metrics:[{op:'mean',column:'c1',as:'mean'}]});assert.equal(q.rows[0].mean.value,'1.500000')}finally{globalThis.fetch=original}}))
test('schema review cannot expand a named table beyond its imported source bounds',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'bounds.xlsx');await xlsx(file);await ctx.engine.execute({action:'import',folder:ctx.source});const d=ctx.engine.store.datasets([file])[0].data;await assert.rejects(()=>approve(ctx,d,{lastRow:99}),/source table bounds/);await assert.rejects(()=>approve(ctx,d,{lastRow:null}),/source table bounds/);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review')}))
test('statistical requests reject joins instead of silently dropping them',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'stats.csv','x,y\n1,2\n2,4\n'));await assert.rejects(()=>ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'describe',column:'c0',join:{datasetId:d.id}}}),/do not accept joins/)}))
test('cooperative cancellation rolls back an unfinished file generation',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'cancel.csv');await fs.writeFile(file,'id,value\n'+Array.from({length:4000},(_,i)=>`id${i},${i}`).join('\n'));let cancel=false;const e=new AnalyticsEngine(ctx.engine.databasePath,[ctx.source],DEFAULT_ANALYTICS_SETTINGS,()=>{if(cancel)throw new Error('Cancelled by test')},p=>{if(p.rows>=1000)cancel=true});try{await assert.rejects(()=>e.execute({action:'import',folder:ctx.source}),/Cancelled/);assert.equal(e.store.datasets([file]).length,0);assert.equal(e.store.file(file).state,'failed')}finally{e.close()}}))
test('source modification during import never publishes mismatched data',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'race.csv');await fs.writeFile(file,'id,value\n'+Array.from({length:2000},(_,i)=>`id${i},${i}`).join('\n'));let changed=false;const sync=require('node:fs');const e=new AnalyticsEngine(ctx.engine.databasePath,[ctx.source],DEFAULT_ANALYTICS_SETTINGS,()=>{},p=>{if(p.rows>=1000&&!changed){changed=true;sync.appendFileSync(file,'\nid9999,99')}});try{const p=await e.execute({action:'import',folder:ctx.source});assert.equal(p.failed,1);assert.equal(e.store.datasets([file]).length,0);assert.match(e.store.file(file).error,/Source changed/)}finally{e.close()}}))
test('recovery removes orphan tables and makes interrupted imports retryable',async()=>fixture(async ctx=>{const file=path.join(ctx.source,'recovery.csv');await fs.writeFile(file,'id,value\na,1\n');ctx.engine.store.putFile({path:file,hash:'old',size:1,mtime:0,ctime:0,state:'importing',error:'',imported:0});const orphan='ar_'+'a'.repeat(32);ctx.engine.store.db.exec(`CREATE TABLE "${orphan}"(row INTEGER PRIMARY KEY,data TEXT) STRICT`);ctx.engine.store.recover();assert.equal(ctx.engine.store.file(file).state,'failed');assert.equal(ctx.engine.store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(orphan),undefined);await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(ctx.engine.store.file(file).state,'needs-review')}))
test('excessive aggregate groups fail rather than returning a partial population',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'many.csv','id,value\n'+Array.from({length:101},(_,i)=>`id${i},1`).join('\n')));await assert.rejects(()=>run(ctx,d,{groupBy:[{column:'c0',as:'group'}],metrics:[{op:'count',as:'n'}]}),/group/i)},{maxGroups:100}))
test('worker observes cancellation flags and exits without publishing data',async()=>fixture(async ctx=>{const flag=new SharedArrayBuffer(4);Atomics.store(new Int32Array(flag),0,1);const worker=new Worker(path.join(root,'apps/shell/src/main/analytics/worker.mjs'),{workerData:{databasePath:ctx.engine.databasePath,roots:[ctx.source],settings:DEFAULT_ANALYTICS_SETTINGS,job:{action:'import',folder:ctx.source},cancel:flag,deadline:Date.now()+10000}});const messages=[];await new Promise((resolve,reject)=>{worker.on('message',m=>messages.push(m));worker.once('error',reject);worker.once('exit',resolve)});assert.ok(messages.some(m=>m.error?.includes('cancelled')));assert.equal(ctx.engine.store.datasets().length,0)}))
test('worker deadline is enforced before analytical work',async()=>fixture(async ctx=>{const worker=new Worker(path.join(root,'apps/shell/src/main/analytics/worker.mjs'),{workerData:{databasePath:ctx.engine.databasePath,roots:[ctx.source],settings:DEFAULT_ANALYTICS_SETTINGS,job:{action:'discover',paths:[],payload:{}},cancel:new SharedArrayBuffer(4),deadline:Date.now()-1}});const messages=[];await new Promise((resolve,reject)=>{worker.on('message',m=>messages.push(m));worker.once('error',reject);worker.once('exit',resolve)});assert.ok(messages.some(m=>m.error?.includes('time budget')))}))
test('empty filtered population returns null numerical statistics instead of zeros',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'empty.csv','id,value\na,1\n'));const s=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'describe',column:'c1',filters:[{column:'c0',op:'eq',value:'missing'}]}})).value;assert.equal(s.summary.count,0);assert.equal(s.summary.sum,null);assert.equal(s.summary.mean,null);assert.equal(s.summary.median,null);assert.equal(s.summary.sampleVariance,null)}))
test('ratio of complete totals computes weighted margin, not average row percentages',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'margin.csv','id,profit,revenue\na,10.00,100.00\nb,90.00,300.00\n'));const q=await run(ctx,d,{metrics:[{op:'ratio-of-sums',column:'c1',denominatorColumn:'c2',multiplyBy:100,as:'margin_percent'}]});assert.equal(q.rows[0].margin_percent.value,'25.000000');assert.equal(q.rows[0].margin_percent.rows,'2');assert.equal(q.inputSampled,false)}))
test('ratio of sums rejects missing values and reports undefined zero denominators',async()=>fixture(async ctx=>{let d=await approve(ctx,await importCsv(ctx,'ratio.csv','id,numerator,denominator\na,1,0\n'));let q=await run(ctx,d,{metrics:[{op:'ratio-of-sums',column:'c1',denominatorColumn:'c2',as:'ratio'}]});assert.equal(q.rows[0].ratio.value,null);assert.equal(q.rows[0].ratio.zeroDenominator,true);d=await approve(ctx,await importCsv(ctx,'missing-ratio.csv','id,numerator,denominator\na,1,2\nb,,4\n'));await assert.rejects(()=>run(ctx,d,{metrics:[{op:'ratio-of-sums',column:'c1',denominatorColumn:'c2',as:'ratio'}]}),/complete numerator/)}))
test('wide schemas are paginated without hiding the remaining columns',async()=>fixture(async ctx=>{const headers=Array.from({length:40},(_,i)=>`value${i}`).join(','),values=Array.from({length:40},(_,i)=>String(i)).join(',');const d=await importCsv(ctx,'wide.csv',headers+'\n'+values+'\n');const a=(await ctx.engine.execute({action:'describe',paths:[d.path],payload:{datasetId:d.id,columnLimit:16}})).value;assert.equal(a.policy.columns.length,16);assert.equal(a.totalColumns,40);assert.equal(a.nextColumnOffset,16);const b=(await ctx.engine.execute({action:'describe',paths:[d.path],payload:{datasetId:d.id,columnOffset:32,columnLimit:16}})).value;assert.equal(b.policy.columns.length,8);assert.equal(b.policy.columns[0].id,'c32');assert.equal(b.nextColumnOffset,null)}))
test('variance preserves small integer differences above JavaScript safe integer precision',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'stable.csv','value\n9007199254740993\n9007199254740994\n'));const q=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'describe',column:'c0'}})).value;assert.equal(q.summary.sampleVariance,0.5);assert.equal(q.summary.mean.value,'9007199254740993.500000')}))
test('correlation centers exact integers before converting differences to floating point',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'stable-correlation.csv','x,y\n9007199254740993,9007199254740996\n9007199254740994,9007199254740998\n9007199254740995,9007199254741000\n'));const q=(await ctx.engine.execute({action:'analyze',paths:[d.path],payload:{datasetIds:[d.id],method:'correlation',column:'c0',otherColumn:'c1'}})).value;assert.ok(Math.abs(q.summary.coefficient-1)<1e-14)}))
test('Electron IPC harness denies foreign frames and agent-side import/review commands',async()=>fixture(async ctx=>{process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state;const {electron,service}=await import('./service-harness.mjs');const sender=new electron.Sender(),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender});try{const handler=electron.handlers.get('nawa:analytics');await assert.rejects(()=>handler({sender,senderFrame:{}},'settings'),/only from/);await assert.rejects(()=>handler({sender,senderFrame:sender.mainFrame},'import',ctx.source,false,false),/Confirm local/);await assert.rejects(()=>s.selected(sender.id,[],'import',{},new AbortController().signal),/Direct review\/clearing is user-controlled/);const cfg=await handler({sender,senderFrame:sender.mainFrame},'settings');assert.ok(cfg.databasePath.includes('analytics'));assert.equal(cfg.settings.maxFileMiB,2048)}finally{s.stop()}}))
test('Electron IPC harness uses real workers for local import, review, query and source receipts',async()=>fixture(async ctx=>{process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state;const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(124),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender}),file=path.join(ctx.source,'workers.csv');await fs.writeFile(file,'id,value\na,10\nb,20\n');try{const handler=electron.handlers.get('nawa:analytics'),event={sender,senderFrame:sender.mainFrame};const p=await handler(event,'import',ctx.source,false,true);assert.equal(p.imported,1);const catalog=await handler(event,'catalog',ctx.source),d=catalog.datasets[0];await handler(event,'review',d.id,d.generation,{...d.policy,grain:'One worker fixture row',confirmed:true});const q=await s.selected(sender.id,[file],'query',{datasetIds:[d.id],metrics:[{op:'sum',column:'c1',as:'total'}]},new AbortController().signal);assert.equal(q.value.rows[0].total,'30');assert.equal(q.sources[0].path,file);assert.ok(sender.messages.length>0)}finally{s.stop()}}))
test('real workers use button-scoped consent for draft review and SQLite export without changing settings',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(229),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender})
  const file=path.join(ctx.source,'ui-export.csv');await fs.writeFile(file,'id,value\na,9007199254740993\nb,2\n')
  const signal=new AbortController().signal,permission={folder:ctx.source,reviewedDatasets:[]}
  try{
    await assert.rejects(()=>s.selected(sender.id,[file],'prepare',{},signal),/Prepare & export/)
    const prepared=await s.selected(sender.id,[file],'prepare',{},signal,permission)
    assert.equal(prepared.value.preparation.draftTables,1)
    const d=prepared.value.datasets[0]
    await s.selected(sender.id,[file],'describe',{datasetId:d.id},signal,permission)
    const approved=await s.selected(sender.id,[file],'propose-policy',{datasetId:d.id,expectedGeneration:d.generation,policy:{}},signal,permission)
    assert.equal(approved.value.status,'ready')
    const reviewed={folder:ctx.source,reviewedDatasets:[{datasetId:d.id,generation:approved.value.generation}]}
    const result=(await s.selected(sender.id,[file],'export-sqlite',{},signal,reviewed)).value,db=exportedDb(result)
    try{const statement=db.prepare(`SELECT SUM(c1) AS n FROM "${result.exports[0].sqlTable}"`);statement.setReadBigInts(true);assert.equal(statement.get().n,9007199254740995n)}finally{db.close()}
    assert.equal((await s.settings()).settings.allowAgentPreparation,false)
    await assert.rejects(()=>s.selected(sender.id,[file],'export-sqlite',{},signal),/Prepare & export/)
    const query=await s.selected(sender.id,[file],'sql',{datasetIds:[d.id],sql:`SELECT COUNT(*) AS n FROM "${result.exports[0].sqlTable}"`},signal)
    assert.equal(query.value.rows[0].n,'2')
  }finally{s.stop()}
}))
test('real workers carry an agent draft through opt-in preparation, user review and exact querying',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(224),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender})
  const file=path.join(ctx.source,'agent-files.csv'),unselected=path.join(ctx.source,'unselected.csv'),signal=new AbortController().signal
  await fs.writeFile(file,'Name,Size (bytes),Relative Path\na.txt,10,a.txt\nb.txt,20,b.txt\n');await fs.writeFile(unselected,'id\nx\n')
  try{
    const handler=electron.handlers.get('nawa:analytics'),event={sender,senderFrame:sender.mainFrame}
    await assert.rejects(()=>s.selected(sender.id,[file],'prepare',{},signal),/Prepare & export/)
    await handler(event,'saveSettings',{...DEFAULT_ANALYTICS_SETTINGS,allowAgentPreparation:true})
    const prepared=await s.selected(sender.id,[file],'prepare',{paths:['agent-files.csv']},signal),d=prepared.value.datasets[0]
    assert.equal(prepared.value.preparation.imported,1);assert.equal(ctx.engine.store.file(unselected),undefined)
    const described=(await s.selected(sender.id,[file],'describe',{datasetId:d.id},signal)).value
    await s.selected(sender.id,[file],'propose-policy',{datasetId:d.id,expectedGeneration:d.generation,policy:{grain:'One file',columns:described.suggestedPolicy.columns,key:['c2']}},signal)
    const catalog=await handler(event,'catalog',ctx.source),draft=catalog.datasets[0]
    assert.equal(draft.preparedPolicy.validatedRows,2);assert.equal(draft.status,'needs-review')
    await assert.rejects(()=>s.selected(sender.id,[file],'review',{},signal),/user-controlled/)
    await handler(event,'review',draft.id,draft.generation,{...draft.preparedPolicy.policy,confirmed:true})
    const result=await s.selected(sender.id,[file],'query',{datasetIds:[draft.id],metrics:[{op:'sum',column:'c1',as:'total'}]},signal)
    assert.equal(result.value.rows[0].total,'30')
    await handler(event,'saveSettings',{...DEFAULT_ANALYTICS_SETTINGS,allowAgentPreparation:false})
    await assert.rejects(()=>s.selected(sender.id,[file],'prepare',{},signal),/Prepare & export/)
  }finally{s.stop()}
}))
test('real service workers apply saved automatic approval and respect revocation on the next preparation',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(225),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender})
  const file=path.join(ctx.source,'auto.csv'),later=path.join(ctx.source,'later.csv'),signal=new AbortController().signal
  await fs.writeFile(file,'id,value\na,10\nb,20\n');await fs.writeFile(later,'id,value\nc,40\n')
  try{
    const handler=electron.handlers.get('nawa:analytics'),event={sender,senderFrame:sender.mainFrame}
    await handler(event,'saveSettings',{...DEFAULT_ANALYTICS_SETTINGS,allowAgentPreparation:true,allowAgentApproval:true})
    const prepared=await s.selected(sender.id,[file],'prepare',{},signal),d=prepared.value.datasets[0]
    assert.equal(prepared.value.preparation.approvedTables,1);assert.equal(d.status,'ready');assert.equal(d.approval.by,'agent');assert.equal(prepared.policyChanges.length,1)
    const query=await s.selected(sender.id,[file],'query',{datasetIds:[d.id],metrics:[{op:'sum',column:'c1',as:'total'}]},signal)
    assert.equal(query.value.rows[0].total,'30')
    await handler(event,'saveSettings',{...DEFAULT_ANALYTICS_SETTINGS,allowAgentPreparation:true,allowAgentApproval:false})
    const pending=await s.selected(sender.id,[later],'prepare',{},signal)
    assert.equal(pending.value.preparation.approvedTables,0);assert.equal(pending.value.preparation.draftTables,1)
    assert.equal((await s.selected(sender.id,[file],'discover',{},signal)).value.datasets[0].status,'ready')
  }finally{s.stop()}
}))
test('Electron supervisor cancels an owner writer through its shared cancellation flag',async()=>fixture(async ctx=>{process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state;const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(125),s=service.registerAnalyticsIpc({roots:async()=>[ctx.source],isHomeSender:w=>w===sender});await fs.writeFile(path.join(ctx.source,'cancel-worker.csv'),'id,value\na,1\n');try{const handler=electron.handlers.get('nawa:analytics'),event={sender,senderFrame:sender.mainFrame};sender.once('sent',()=>s.cancel(sender.id));await assert.rejects(()=>handler(event,'import',ctx.source,false,true),/cancelled/i);assert.equal(s.progress().running,false)}finally{s.stop()}}))
test('Electron supervisor rejects result delivery after a workspace root is detached',async()=>fixture(async ctx=>{process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state;const {electron,service}=await import('./service-harness.mjs'),sender=new electron.Sender(126);let roots=[ctx.source];const s=service.registerAnalyticsIpc({roots:async()=>roots,isHomeSender:w=>w===sender});await fs.writeFile(path.join(ctx.source,'detach.csv'),'id,value\na,1\n');try{const handler=electron.handlers.get('nawa:analytics'),event={sender,senderFrame:sender.mainFrame};sender.once('sent',()=>{roots=[]});await assert.rejects(()=>handler(event,'import',ctx.source,false,true),/permissions changed|cancelled/i)}finally{s.stop()}}))
test('overflowing REAL aggregates fail instead of serializing infinity as null',async()=>fixture(async ctx=>{const draft=await importCsv(ctx,'overflow.csv','value\n1e308\n1e308\n'),d=await approve(ctx,draft,{columns:draft.policy.columns.map(c=>({...c,type:'real',role:'measure'}))});await assert.rejects(()=>run(ctx,d,{metrics:[{op:'sum',column:'c0',as:'total'}]}),/non-finite/i)}))
test('undefined grouped ratios remain last when sorting descending',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'ratio-groups.csv','group,numerator,denominator\nA,1,0\nB,1,2\n'));const q=await run(ctx,d,{groupBy:[{column:'c0',as:'group'}],metrics:[{op:'ratio-of-sums',column:'c1',denominatorColumn:'c2',as:'ratio'}],orderBy:[{column:'ratio',descending:true}]});assert.equal(q.rows[0].group,'B');assert.equal(q.rows[1].ratio.value,null)}))
test('an importer version mismatch forces fresh review even with unchanged source bytes',async()=>fixture(async ctx=>{const d=await approve(ctx,await importCsv(ctx,'version.csv','id,value\na,1\n'));const old=ctx.engine.store.dataset(d.id);old.data.profile.importerVersion='older';ctx.engine.store.putDataset(old);const p=await ctx.engine.execute({action:'import',folder:ctx.source});assert.equal(p.imported,1);assert.equal(ctx.engine.store.dataset(d.id).data.status,'needs-review')}))
test('table-review catalog and selected-file coverage are paginated for large collections',async()=>fixture(async ctx=>{const paths=[];for(let i=0;i<26;i++){const file=path.join(ctx.source,`file${i}.csv`);paths.push(file);await fs.writeFile(file,'id,value\na,1\n')}await ctx.engine.execute({action:'import',folder:ctx.source});const a=await ctx.engine.execute({action:'catalog',folder:ctx.source});assert.equal(a.datasets.length,20);assert.equal(a.total,26);assert.equal(a.nextOffset,20);const b=await ctx.engine.execute({action:'catalog',folder:ctx.source,payload:{offset:20}});assert.equal(b.datasets.length,6);assert.equal(b.nextOffset,null);const discovered=(await ctx.engine.execute({action:'discover',paths,payload:{}})).value;assert.equal(discovered.datasets.length,25);assert.equal(discovered.nextOffset,25);assert.equal(discovered.selectedFiles.length,16);assert.equal(discovered.nextFileOffset,16);const more=(await ctx.engine.execute({action:'discover',paths,payload:{offset:25,fileOffset:16}})).value;assert.equal(more.datasets.length,1);assert.equal(more.selectedFiles.length,10);assert.equal(more.nextFileOffset,null)}))
test('cross-file unions reject incompatible reviewed row grains',async()=>fixture(async ctx=>{const a=await approve(ctx,await importCsv(ctx,'grain-a.csv','id,value\na,1\n'),{key:['c0'],grain:'One invoice'}),b=await approve(ctx,await importCsv(ctx,'grain-b.csv','id,value\nb,2\n'),{key:['c0'],grain:'One invoice line'});await assert.rejects(()=>ctx.engine.execute({action:'query',paths:[a.path,b.path],payload:{datasetIds:[a.id,b.id],metrics:[{op:'count',as:'n'}]}}),/row grains/)}))

test('fresh database initializes once for overlapping metadata requests',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {service}=await import('./service-harness.mjs')
  const s=new service.AnalyticsService({roots:async()=>[ctx.source],isHomeSender:()=>true})
  try{
    const reads=await Promise.all(Array.from({length:8},()=>s.request(201,{action:'statuses',paths:[]})))
    assert.deepEqual(reads,Array.from({length:8},()=>[]))
    const catalog=await s.request(201,{action:'catalog',folder:ctx.source})
    assert.equal(catalog.total,0)
  }finally{s.stop()}
}))

test('real analytics requests survive removal of the startup worker bundle',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {service}=await import('./service-harness.mjs')
  const s=new service.AnalyticsService({roots:async()=>[ctx.source],isHomeSender:()=>true})
  const bundle=path.join(root,'apps/shell/src/main/analytics/worker-harness.cjs')
  const original=await fs.readFile(bundle)
  try{
    await fs.unlink(bundle)
    const file=path.join(ctx.source,'rebuild.csv')
    await fs.writeFile(file,'id,value\na,10\nb,20\n')
    const imported=await s.request(203,{action:'import',folder:ctx.source})
    assert.equal(imported.imported,1)
    const catalog=await s.request(203,{action:'catalog',folder:ctx.source}),draft=catalog.datasets[0]
    await s.request(203,{action:'review',payload:{datasetId:draft.id,expectedGeneration:draft.generation,policy:{...draft.policy,grain:'One test record',confirmed:true}}})
    const result=await s.selected(203,[file],'query',{datasetIds:[draft.id],metrics:[{op:'sum',column:'c1',as:'total'}]},new AbortController().signal)
    assert.equal(result.value.rows[0].total,'30')
  }finally{s.stop();await fs.writeFile(bundle,original)}
}))

test('real workers handle imports, status refreshes and result receipt writes together',async()=>fixture(async ctx=>{
  process.env.NAWA_ANALYTICS_HARNESS_USERDATA=ctx.state
  const {service}=await import('./service-harness.mjs')
  const s=new service.AnalyticsService({roots:async()=>[ctx.source],isHomeSender:()=>true})
  const file=path.join(ctx.source,'approved.csv'),incoming=path.join(ctx.source,'incoming.csv')
  await fs.writeFile(file,'id,value\na,10\nb,20\n')
  try{
    await s.request(202,{action:'import',folder:ctx.source})
    const catalog=await s.request(202,{action:'catalog',folder:ctx.source}),draft=catalog.datasets[0]
    await s.request(202,{action:'review',payload:{datasetId:draft.id,expectedGeneration:draft.generation,policy:{...draft.policy,grain:'One test record',confirmed:true}}})
    await fs.writeFile(incoming,'id,value\n'+Array.from({length:12000},(_,i)=>`row${i},${i}`).join('\n'))
    const importing=s.request(202,{action:'import',folder:ctx.source})
    const statuses=Array.from({length:12},()=>s.request(202,{action:'statuses',paths:[file,incoming]}))
    const queries=Array.from({length:6},()=>s.selected(202,[file],'query',{datasetIds:[draft.id],metrics:[{op:'sum',column:'c1',as:'total'}]},new AbortController().signal))
    const [imported,refreshed,results]=await Promise.all([importing,Promise.all(statuses),Promise.all(queries)])
    assert.equal(imported.failed,0)
    assert.equal(imported.imported,1)
    for(const status of refreshed)assert.ok(status.every(f=>f.state!=='failed'))
    assert.equal(new Set(results.map(r=>r.value.id)).size,6)
    for(const result of results){
      assert.equal(result.value.rows[0].total,'30')
      const saved=await s.selected(202,[file],'result',{resultId:result.value.id},new AbortController().signal)
      assert.equal(saved.value.rows[0].total,'30')
    }
  }finally{s.stop()}
}))
