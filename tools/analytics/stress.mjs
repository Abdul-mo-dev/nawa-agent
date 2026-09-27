/** Optional >64 MiB streaming acceptance fixture. Deletes its generated files after completion. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
const build=process.env.NAWA_ANALYTICS_BUILD
if(!build)throw new Error('Run node tools/analytics/test.mjs --large.')
const {AnalyticsEngine}=await import(pathToFileURL(path.join(build,'apps/shell/src/main/analytics/engine.mjs')).href)
const {DEFAULT_ANALYTICS_SETTINGS}=await import(pathToFileURL(path.join(build,'apps/shell/src/shared/analytics-api.mjs')).href)
test('CSV larger than 64 MiB streams through import, full validation and exact SQL sum',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nawa-data-large-')),source=path.join(dir,'source');await fs.mkdir(source)
  const file=path.join(source,'large.csv'),rows=220000,description='x'.repeat(320),writer=await fs.open(file,'wx')
  try{await writer.write('id,amount,description\n');for(let base=0;base<rows;base+=1000)await writer.write(Array.from({length:Math.min(1000,rows-base)},(_,i)=>`record${base+i},0.10,${description}\n`).join(''))}finally{await writer.close()}
  const bytes=(await fs.stat(file)).size;assert.ok(bytes>64*1048576)
  const engine=new AnalyticsEngine(path.join(dir,'analytics.sqlite3'),[source],DEFAULT_ANALYTICS_SETTINGS,()=>{})
  const timings={},start=performance.now();let rss=process.memoryUsage().rss
  const memory=setInterval(()=>{rss=Math.max(rss,process.memoryUsage().rss)},200)
  try{
    const imported=await engine.execute({action:'import',folder:source});assert.equal(imported.failed,0);assert.equal(imported.imported,1);timings.importMs=performance.now()-start
    const draft=engine.store.datasets([file])[0].data,reviewStart=performance.now()
    const ready=await engine.execute({action:'review',payload:{datasetId:draft.id,expectedGeneration:draft.generation,policy:{...draft.policy,grain:'One generated transaction',columns:draft.policy.columns.map(c=>c.id==='c1'?{...c,scale:2,unit:'synthetic units'}:c),key:['c0'],confirmed:true}}});assert.equal(ready.rows,rows);timings.validateMs=performance.now()-reviewStart
    const queryStart=performance.now(),result=(await engine.execute({action:'query',paths:[file],payload:{datasetIds:[draft.id],metrics:[{op:'count',as:'records'},{op:'sum',column:'c1',as:'total'}]}})).value
    timings.queryMs=performance.now()-queryStart;assert.equal(result.rows[0].records,String(rows));assert.equal(result.rows[0].total,'22000.00');assert.equal(result.inputSampled,false)
    console.log(JSON.stringify({fixture:'synthetic ASCII CSV, not a Windows/user-workbook benchmark',bytes,rows,result:result.rows[0],timings,peakObservedRssMiB:Math.round(rss/1048576)},null,2))
  }finally{clearInterval(memory);engine.close();await fs.rm(dir,{recursive:true,force:true})}
})
