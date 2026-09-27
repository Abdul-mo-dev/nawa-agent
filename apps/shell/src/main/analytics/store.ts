import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { Dataset, AnalyticsResult, SourceRef } from '../../shared/analytics-api'
const { DatabaseSync } = createRequire(import.meta.url)('node:' + 'sqlite') as typeof import('node:sqlite')
export interface FileRecord { path:string; hash:string; size:number; mtime:number; ctime:number; state:string; error:string; imported:number }
export interface StoredDataset { data:Dataset; rawTable:string; typedTable:string|null; tableKey:string }
export const tableName=(prefix:'ar'|'at')=>`${prefix}_${randomUUID().replaceAll('-','')}`
export function quotedTable(name:string):string {if(!/^(ar|at)_[a-f0-9]{32}$/.test(name))throw new Error('Invalid internal table identifier.');return `"${name}"`}
export class AnalyticsStore {
  readonly db:import('node:sqlite').DatabaseSync
  constructor(readonly path:string){
    this.db=new DatabaseSync(path,{allowExtension:false,enableDoubleQuotedStringLiterals:false})
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384;
      CREATE TABLE IF NOT EXISTS analytics_files(path TEXT PRIMARY KEY,hash TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,ctime REAL NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,imported REAL NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS analytics_datasets(id TEXT PRIMARY KEY,path TEXT NOT NULL,table_key TEXT NOT NULL,raw_table TEXT NOT NULL,typed_table TEXT,data TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS analytics_dataset_path ON analytics_datasets(path);
      CREATE TABLE IF NOT EXISTS analytics_results(id TEXT PRIMARY KEY,created REAL NOT NULL,sources TEXT NOT NULL,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS analytics_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;`)
  }
  file(path:string):FileRecord|undefined{return this.db.prepare('SELECT * FROM analytics_files WHERE path=?').get(path) as unknown as FileRecord|undefined}
  files():FileRecord[]{return this.db.prepare('SELECT * FROM analytics_files').all() as unknown as FileRecord[]}
  putFile(record:FileRecord):void{this.db.prepare('INSERT OR REPLACE INTO analytics_files VALUES(?,?,?,?,?,?,?,?)').run(record.path,record.hash,record.size,record.mtime,record.ctime,record.state,record.error,record.imported)}
  datasets(paths?:readonly string[]):StoredDataset[]{
    const allowed=paths?new Set(paths):null
    return (this.db.prepare('SELECT * FROM analytics_datasets').all() as unknown as {path:string;data:string;raw_table:string;typed_table:string|null;table_key:string}[]).filter(r=>!allowed||allowed.has(r.path)).map(r=>({data:JSON.parse(r.data),rawTable:r.raw_table,typedTable:r.typed_table,tableKey:r.table_key}))
  }
  dataset(id:string):StoredDataset|undefined{
    const r=this.db.prepare('SELECT * FROM analytics_datasets WHERE id=?').get(id) as {data:string;raw_table:string;typed_table:string|null;table_key:string}|undefined
    return r?{data:JSON.parse(r.data),rawTable:r.raw_table,typedTable:r.typed_table,tableKey:r.table_key}:undefined
  }
  putDataset(record:StoredDataset):void{const d=record.data;this.db.prepare('INSERT OR REPLACE INTO analytics_datasets VALUES(?,?,?,?,?,?)').run(d.id,d.path,record.tableKey,record.rawTable,record.typedTable,JSON.stringify(d))}
  dropTable(name:string|null):void{if(name)this.db.exec(`DROP TABLE IF EXISTS ${quotedTable(name)}`)}
  replaceFile(record:FileRecord,datasets:StoredDataset[]):void{
    const previous=this.datasets([record.path]);this.db.exec('BEGIN IMMEDIATE')
    try{this.db.prepare('DELETE FROM analytics_datasets WHERE path=?').run(record.path);for(const d of datasets)this.putDataset(d);this.putFile(record);for(const d of previous){this.dropTable(d.rawTable);this.dropTable(d.typedTable)}this.db.exec('COMMIT')}
    catch(e){this.db.exec('ROLLBACK');throw e}
  }
  clear(paths:readonly string[]):void{
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const ds=this.datasets(paths);for(const d of ds){this.dropTable(d.rawTable);this.dropTable(d.typedTable);this.db.prepare('DELETE FROM analytics_datasets WHERE id=?').run(d.data.id)}
      const allowed=new Set(paths);for(const p of allowed)this.db.prepare('DELETE FROM analytics_files WHERE path=?').run(p)
      for(const r of this.db.prepare('SELECT id,sources FROM analytics_results').all() as unknown as {id:string;sources:string}[])if((JSON.parse(r.sources) as SourceRef[]).some(s=>allowed.has(s.path)))this.db.prepare('DELETE FROM analytics_results WHERE id=?').run(r.id)
      this.db.exec('COMMIT')
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  result(id:string):AnalyticsResult|undefined{const r=this.db.prepare('SELECT body FROM analytics_results WHERE id=?').get(id) as {body:string}|undefined;return r?JSON.parse(r.body):undefined}
  saveResult(result:AnalyticsResult,keep:number):void{
    const body=JSON.stringify(result);if(Buffer.byteLength(body)>4*1024*1024)throw new Error('Result receipt is too large. Narrow the query or output.')
    this.db.prepare('INSERT INTO analytics_results VALUES(?,?,?,?)').run(result.id,result.createdAt,JSON.stringify(result.sources),body)
    this.db.prepare('DELETE FROM analytics_results WHERE id IN (SELECT id FROM analytics_results ORDER BY created DESC LIMIT -1 OFFSET ?)').run(keep)
  }
  recover():void{
    // Only the single writer calls this, before starting a new import/review/clear job.
    this.db.prepare("UPDATE analytics_files SET state='failed',error='Import was interrupted. Retry importing this file.' WHERE state='importing'").run()
    const used=new Set(this.datasets().flatMap(d=>[d.rawTable,d.typedTable].filter((p):p is string=>!!p)))
    for(const r of this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as {name:string}[])if(/^(ar|at)_[a-f0-9]{32}$/.test(r.name)&&!used.has(r.name))this.dropTable(r.name)
  }
  reader(check:()=>void):import('node:sqlite').DatabaseSync{
    const db=new DatabaseSync(this.path,{readOnly:true,allowExtension:false,enableDoubleQuotedStringLiterals:false})
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384;')
    let calls=0
    db.function('analytics_guard',{directOnly:true,deterministic:false},()=>{if(++calls%256===0)check();return 1})
    if(typeof db.aggregate!=='function'){db.close();throw new Error('Structured analysis requires Node/Electron with node:sqlite aggregate support (Node 22.16 or newer).')}
    // String accumulator also works with older @types/node aggregate contracts.
    // Decimal integers never pass through Number, including totals above signed 64-bit range.
    db.aggregate<string>('analytics_exact_sum',{useBigIntArguments:true,start:'',step:(s:string,v:unknown)=>{if(v===null)return s;if(typeof v!=='bigint')throw new Error('Exact sums require validated integer/decimal values.');return (BigInt(s||'0')+v).toString()},result:(s:string)=>s===''?null:s})
    db.aggregate<string>('analytics_exact_mean',{useBigIntArguments:true,start:'0,0',step:(s:string,v:unknown)=>{if(v===null)return s;if(typeof v!=='bigint')throw new Error('Exact means require validated integer/decimal values.');const [sum,count]=s.split(',');return `${BigInt(sum!)+v},${BigInt(count!)+1n}`},result:(s:string)=>{const [sum,count]=s.split(',');return count==='0'?null:JSON.stringify({numerator:sum,denominator:count})}})
    db.aggregate<string>('analytics_exact_ratio',{useBigIntArguments:true,start:'0,0,0',step:(s:string,x:unknown,y:unknown)=>{if(x===null||y===null)throw new Error('Ratio-of-sums requires complete numerator/denominator values. Explicitly filter missing rows and report the exclusion.');if(typeof x!=='bigint'||typeof y!=='bigint')throw new Error('Exact ratios require integer/decimal columns.');const [num,den,count]=s.split(',');return `${BigInt(num!)+x},${BigInt(den!)+y},${BigInt(count!)+1n}`},result:(s:string)=>{const [numerator,denominator,count]=s.split(',');return count==='0'?null:JSON.stringify({numerator,denominator,count})}})
    db.exec('BEGIN')
    return db
  }
  close():void{this.db.close()}
}
