import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { AnalyticsSettings, AnalyticsResult, DataColumn, DataQuery, DataMetric, SourceRef } from '../../shared/analytics-api'
import { samePath } from '../directory-actions/file-safety'
import { AnalyticsStore, quotedTable, type StoredDataset } from './store'
import { object, list, text, id, int } from './validation'
import { convert, display, divide, pow10, cellDisplay, jsonSafe } from './numeric'
export interface Field { column:DataColumn; sql:string; side:'left'|'right' }
export interface Relation {
  cte:string; from:string; where:string; params:SQLInputValue[]; fields:Map<string,Field>;
  datasets:StoredDataset[]; sources:SourceRef[]; warnings:string[]; unmatched:number
}
export class QuerySession {
  readonly db:DatabaseSync
  readonly sql:string[]=[]
  readonly parameters:unknown[][]=[]
  constructor(readonly store:AnalyticsStore,readonly paths:string[],readonly settings:AnalyticsSettings,readonly check:()=>void,databasePath?:string){this.db=store.reader(check,databasePath)}
  close():void{this.db.close()}
  statement(sql:string,params:SQLInputValue[]=[]):import('node:sqlite').StatementSync{
    this.check();this.sql.push(sql);this.parameters.push(jsonSafe(params) as unknown[])
    const s=this.db.prepare(sql);s.setReadBigInts(true);return s
  }
  all(sql:string,params:SQLInputValue[]=[]):Record<string,unknown>[] {return this.statement(sql,params).all(...params) as Record<string,unknown>[]}
  count(sql:string,params:SQLInputValue[]=[]):number{return Number(this.statement(sql,params).get(...params)?.n??0)}
  dataset(value:unknown):StoredDataset {
    const key=text(value,'dataset ID',80),d=this.store.dataset(key)
    if(!d||!this.paths.some(p=>samePath(p,d.data.path)))throw new Error('Dataset is not available within the selected-file scope.')
    const file=this.store.file(d.data.path)
    if(!file||!['ready','needs-review'].includes(file.state)||file.hash!==d.data.sourceHash||d.data.status!=='ready'||!d.typedTable)throw new Error(`Dataset ${d.data.name} is not analytics-ready. Import and review it first.`)
    return d
  }
  relation(raw:unknown):Relation {
    const r=object(raw,'query');if('sql' in r)throw new Error('Raw SQL is not accepted. Use the structured query schema.');const ids=list(r.datasetIds,'datasetIds',16).map(v=>text(v,'dataset ID',80))
    if(!ids.length||new Set(ids).size!==ids.length)throw new Error('Choose 1–16 distinct datasets.')
    const left=ids.map(k=>this.dataset(k)),base=left[0]!,columns=base.data.policy.columns
    const signature=(d:StoredDataset)=>JSON.stringify({grain:d.data.policy.grain.trim().toLowerCase(),columns:d.data.policy.columns.map(c=>({name:c.name,type:c.type,scale:c.scale,role:c.role,unit:c.unit})),key:d.data.policy.key,currencyColumn:d.data.policy.currencyColumn})
    if(left.some(d=>signature(d)!==signature(base)))throw new Error('Union schemas, row grains, scales, units, keys and currency policies must match exactly. Review the schemas rather than guessing mappings.')
    for(let i=0;i<left.length;i++)for(let j=i+1;j<left.length;j++)if(left[i]!.data.sourceHash===left[j]!.data.sourceHash&&!samePath(left[i]!.data.path,left[j]!.data.path))throw new Error('Identical source-file exports would be counted twice. Select only one copy.')
    const select=(d:StoredDataset)=>`SELECT __row,'${d.data.id}' AS __dataset_id,${columns.map(c=>`"${c.id}"`).join(',')} FROM ${quotedTable(d.typedTable!)} WHERE analytics_guard()`
    let cte=`WITH a AS (${left.map(select).join(' UNION ALL ')})`,from='a',unmatched=0
    const fields=new Map<string,Field>(columns.map(c=>[c.id,{column:c,sql:`a."${c.id}"`,side:'left'}]))
    if(left.length>1){
      if(!base.data.policy.key.length)throw new Error('Cross-file unions require an approved unique business key to detect overlapping exports.')
      const keys=base.data.policy.key.map(k=>`"${k}"`).join(',')
      if(this.all(`${cte} SELECT 1 AS duplicate FROM a GROUP BY ${keys} HAVING COUNT(*)>1 LIMIT 1`).length)throw new Error('Overlapping row keys found across datasets. Resolve duplicate exports before aggregating.')
    }
    const datasets=[...left],warnings=left.flatMap(d=>d.data.warnings)
    if(r.join!==undefined){
      const j=object(r.join,'join'),right=this.dataset(j.datasetId)
      if(ids.includes(right.data.id))throw new Error('Self-joins are not available through this guarded analysis interface.')
      const lk=list(j.leftKeys,'left join keys',8).map(v=>id(v)),rk=list(j.rightKeys,'right join keys',8).map(v=>id(v))
      if(!lk.length||lk.length!==rk.length)throw new Error('Supply corresponding left and right join keys.')
      if(j.kind!=='left'&&j.kind!=='inner')throw new Error('Join kind must be left or inner.')
      const rightCols=right.data.policy.columns
      const conditions=lk.map((k,i)=>{const l=fields.get(k)?.column,rc=rightCols.find(c=>c.id===rk[i]);if(!l||!rc||l.type!==rc.type||l.scale!==rc.scale||l.type==='real')throw new Error('Join keys must exist and use identical non-REAL types and decimal scales.');return `a."${k}"=b."${rk[i]}"`})
      const rightCTE=`SELECT __row,'${right.data.id}' AS __dataset_id,${rightCols.map(c=>`"${c.id}"`).join(',')} FROM ${quotedTable(right.typedTable!)} WHERE analytics_guard()`
      cte+=`, b AS (${rightCTE})`
      if(this.all(`${cte} SELECT 1 AS duplicate FROM b WHERE ${rk.map(k=>`"${k}" IS NOT NULL`).join(' AND ')} GROUP BY ${rk.map(k=>`"${k}"`).join(',')} HAVING COUNT(*)>1 LIMIT 1`).length)throw new Error('Right join keys are not unique. This join would multiply fact rows; aggregate or fix the lookup table first.')
      unmatched=this.count(`${cte} SELECT COUNT(*) n FROM a LEFT JOIN b ON ${conditions.join(' AND ')} WHERE b.__row IS NULL`)
      if(unmatched)warnings.push(`${unmatched} left-side rows have no matching right-side key before query filters.${j.kind==='inner'?' These rows are excluded by the inner join.':''}`)
      from=`a ${j.kind==='left'?'LEFT':'INNER'} JOIN b ON ${conditions.join(' AND ')}`
      for(const c of rightCols)fields.set(`right.${c.id}`,{column:c,sql:`b."${c.id}"`,side:'right'})
      datasets.push(right);warnings.push(...right.data.warnings)
    }
    const params:SQLInputValue[]=[],parts=['analytics_guard()']
    for(const input of list(r.filters??[],'filters',32)){
      const f=object(input,'filter'),field=this.field(fields,f.column),op=text(f.op,'filter operator',20)
      if(op==='is-null'||op==='not-null'){parts.push(`${field.sql} IS ${op==='not-null'?'NOT ':''}NULL`);continue}
      const add=(v:unknown):string=>{
        if(v===null)throw new Error('Use is-null/not-null for null filters.')
        if(typeof v!=='string'&&typeof v!=='number'&&typeof v!=='boolean')throw new Error('Filter values must be scalar strings, safe numbers or booleans.')
        if(typeof v==='number'&&!Number.isSafeInteger(v)&&field.column.type!=='real')throw new Error('Pass exact decimal and large integer filter values as strings, not JavaScript numbers.')
        const s=typeof v==='boolean'?String(v):text(String(v),'filter value',10000,true)
        params.push(convert(s,{...field.column,nullable:false}) as SQLInputValue);return '?'
      }
      if(op==='in'){const values=list(f.value,'IN values',100);parts.push(values.length?`${field.sql} IN (${values.map(add).join(',')})`:'0');continue}
      if(op==='contains'){if(field.column.type!=='text')throw new Error('contains is available only for text columns.');parts.push(`instr(${field.sql},${add(f.value)})>0`);continue}
      const operators:Record<string,string>={eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}
      if(!operators[op])throw new Error('Unsupported filter operator.')
      parts.push(`${field.sql}${operators[op]}${add(f.value)}`)
    }
    return {cte,from,where:parts.join(' AND '),params,fields,datasets,sources:datasets.map(d=>({path:d.data.path,hash:d.data.sourceHash,datasetId:d.data.id,generation:d.data.generation})),warnings:[...new Set(warnings)],unmatched}
  }
  field(fields:Map<string,Field>,key:unknown):Field{
    const k=text(key,'column ID',80),f=fields.get(k);if(!f)throw new Error(`Unknown column ${k}. Use c0/c1 identifiers from describe_dataset; joined columns use right.c0.`);return f
  }
  currency(relation:Relation,groupColumns:string[]):void{
    const key=relation.datasets[0]!.data.policy.currencyColumn
    if(!key||groupColumns.includes(key))return
    const f=this.field(relation.fields,key)
    const n=this.count(`${relation.cte} SELECT COUNT(DISTINCT ${f.sql}) n FROM ${relation.from} WHERE ${relation.where}`,relation.params)
    const missing=this.count(`${relation.cte} SELECT COUNT(*) n FROM ${relation.from} WHERE ${relation.where} AND (${f.sql} IS NULL OR ${f.sql}='')`,relation.params)
    if(n>1||missing)throw new Error('Currency scope is mixed or missing. Filter one complete currency or group by the approved currency column before aggregating measures.')
  }
  execute(raw:unknown,internalLimit?:number):AnalyticsResult{
    const r=object(raw,'query'),relation=this.relation(r),{cte,from,where,params}=relation
    const limit=internalLimit??(r.limit===undefined?this.settings.resultRows:int(r.limit,'displayed rows',1,this.settings.resultRows))
    const groupInputs=list(r.groupBy??[],'groupBy',8),metricInputs=list(r.metrics??[],'metrics',16),names=new Set<string>()
    const unique=(name:unknown)=>{const n=id(name,'output name');if(names.has(n)||n.startsWith('__'))throw new Error('Output names must be unique and may not start with __.');names.add(n);return n}
    const groups=groupInputs.map((raw,i)=>{const g=object(raw,'group'),field=this.field(relation.fields,g.column),name=unique(g.as??`group_${i}`);let expression=field.sql
      if(g.period!==undefined){if(field.column.type!=='date'||!['day','month','year'].includes(String(g.period)))throw new Error('Period grouping requires a validated date column.');expression=`substr(${field.sql},1,${g.period==='year'?4:g.period==='month'?7:10})`}
      return {name,expression,key:String(g.column),field,period:g.period}
    })
    const metrics=metricInputs.map(raw=>{
      const m=object(raw,'metric'),name=unique(m.as),op=text(m.op,'metric operator') as DataMetric['op']
      if(!['count','count-distinct','sum','mean','min','max','ratio-of-sums'].includes(op))throw new Error('Unsupported metric operator.')
      const field=m.column===undefined?undefined:this.field(relation.fields,m.column)
      if(op!=='count'&&!field)throw new Error('This metric requires a column.')
      if(field?.side==='right'&&['sum','mean','count','ratio-of-sums'].includes(op))throw new Error('Aggregating lookup-side values after a many-to-one join can double-count them. Query the lookup dataset separately.')
      if(['sum','mean','ratio-of-sums'].includes(op)&&(!field||!['integer','decimal','real'].includes(field.column.type)||field.column.role!=='measure'))throw new Error('SUM/mean require a reviewed numeric measure, not an identifier or untyped column.')
      const denominator=op==='ratio-of-sums'?this.field(relation.fields,m.denominatorColumn):undefined
      const multiplyBy=m.multiplyBy===undefined?1:int(m.multiplyBy,'ratio multiplier',1,100)
      if(op==='ratio-of-sums'&&(!denominator||denominator.side==='right'||denominator.column.role!=='measure'||!['integer','decimal'].includes(denominator.column.type)||field!.column.type==='real'))throw new Error('Ratio-of-sums requires two left-side reviewed integer/decimal measures.')
      if(op==='ratio-of-sums'&&![1,100].includes(multiplyBy))throw new Error('Ratio multiplier must be 1 or 100.')
      const expression=op==='ratio-of-sums'?`analytics_exact_ratio(${field!.sql},${denominator!.sql})`:op==='count'?`COUNT(${field?.sql??'*'})`:op==='count-distinct'?`COUNT(DISTINCT ${field!.sql})`:op==='sum'?`${field!.column.type==='real'?'SUM':'analytics_exact_sum'}(${field!.sql})`:op==='mean'?`${field!.column.type==='real'?'AVG':'analytics_exact_mean'}(${field!.sql})`:`${op.toUpperCase()}(${field!.sql})`
      return {name,op,field,denominator,multiplyBy,expression}
    })
    if(groups.length&&!metrics.length)throw new Error('A grouped query must include at least one metric.')
    if(metrics.some(m=>m.op==='sum'||m.op==='mean'||m.op==='ratio-of-sums'||['min','max'].includes(m.op)&&m.field?.column.role==='measure'&&['integer','decimal','real'].includes(m.field.column.type)))this.currency(relation,groups.map(g=>g.key))
    for(const metric of metrics)if(metric.op==='ratio-of-sums'){
      const missing=this.count(`${cte} SELECT COUNT(*) n FROM ${from} WHERE ${where} AND (${metric.field!.sql} IS NULL OR ${metric.denominator!.sql} IS NULL)`,params)
      if(missing)throw new Error(`Ratio-of-sums requires complete numerator/denominator values; ${missing} rows are missing an input. Filter explicitly and report exclusions.`)
    }
    const matched=this.count(`${cte} SELECT COUNT(*) n FROM ${from} WHERE ${where}`,params)
    const result:AnalyticsResult={id:'analysis_'+randomUUID(),createdAt:Date.now(),operation:'query',sources:relation.sources,sql:[],parameters:[],population:{matchedRows:matched,sourceRows:relation.datasets.map(d=>({datasetId:d.data.id,rows:d.data.rows,excludedByPolicy:d.data.excludedRows,grain:d.data.policy.grain})),unmatchedJoinRowsBeforeFilters:relation.unmatched},columns:[],rows:[],totalResultRows:0,displayedRows:0,outputTruncated:false,inputSampled:false,warnings:relation.warnings,request:raw}
    if(metrics.length){
      const select=[...groups.map(g=>`${g.expression} AS "${g.name}"`),...metrics.map(m=>`${m.expression} AS "${m.name}"`)]
      const sql=`${cte} SELECT ${select.join(',')} FROM ${from} WHERE ${where}${groups.length?' GROUP BY '+groups.map(g=>g.expression).join(','):''}`
      const rows:Record<string,unknown>[]=[]
      for(const row of this.statement(sql,params).iterate(...params)){if(rows.length>=this.settings.maxGroups)throw new Error('Query has too many result groups. Narrow the grouping/filter; input data was not sampled.');rows.push(row as Record<string,unknown>);this.check()}
      const meta=new Map<string,{kind:string;column?:DataColumn}>([...groups.map(g=>[g.name,{kind:g.period?'period':'column',column:g.field.column}] as const),...metrics.map(m=>[m.name,{kind:m.op,column:m.field?.column}] as const)])
      const orders=list(r.orderBy??[],'orderBy',8).map(v=>{const o=object(v,'order'),key=text(o.column,'order column');if(!meta.has(key))throw new Error('Aggregate orderBy uses an output group/metric name.');return {key,descending:o.descending===true}})
      const compare=(a:unknown,b:unknown,m:{kind:string;column?:DataColumn}):number=>{
        if(a===b)return 0;if(a==null)return 1;if(b==null)return -1
        if(m.kind==='ratio-of-sums'){const x=JSON.parse(String(a)),y=JSON.parse(String(b));let xn=BigInt(x.numerator),xd=BigInt(x.denominator),yn=BigInt(y.numerator),yd=BigInt(y.denominator);if(!xd&&!yd)return 0;if(!xd)return 1;if(!yd)return -1;if(xd<0n){xd=-xd;xn=-xn}if(yd<0n){yd=-yd;yn=-yn}const l=xn*yd,r=yn*xd;return l<r?-1:l>r?1:0}
        if(m.kind==='mean'&&m.column?.type!=='real'){const x=JSON.parse(String(a)),y=JSON.parse(String(b));const left=BigInt(x.numerator)*BigInt(y.denominator),right=BigInt(y.numerator)*BigInt(x.denominator);return left<right?-1:left>right?1:0}
        if(m.kind==='sum'&&m.column?.type!=='real'){const x=BigInt(String(a)),y=BigInt(String(b));return x<y?-1:x>y?1:0}
        if(typeof a==='bigint'&&typeof b==='bigint'||typeof a==='number'&&typeof b==='number')return a<b?-1:a>b?1:0
        return String(a)<String(b)?-1:String(a)>String(b)?1:0
      }
      rows.sort((a,b)=>{for(const o of orders.length?orders:groups.map(g=>({key:g.name,descending:false}))){const m=meta.get(o.key)!,missing=(value:unknown)=>value==null||m.kind==='ratio-of-sums'&&BigInt(JSON.parse(String(value)).denominator)===0n;const am=missing(a[o.key]),bm=missing(b[o.key]);if(am!==bm)return am?1:-1;const v=compare(a[o.key],b[o.key],m);if(v)return am||bm?v:o.descending?-v:v}return 0})
      result.totalResultRows=rows.length
      result.rows=rows.slice(0,limit).map(row=>Object.fromEntries(Object.entries(row).map(([key,v])=>{
        const m=meta.get(key)!,c=m.column,scale=c?.type==='decimal'?c.scale:0
        if(v==null)return[key,null]
        if(m.kind==='sum'&&c?.type!=='real')return[key,display(BigInt(String(v)),scale)]
        if(m.kind==='ratio-of-sums'){const metric=metrics.find(x=>x.name===key)!,q=JSON.parse(String(v)),denScale=metric.denominator!.column.type==='decimal'?metric.denominator!.column.scale:0,num=BigInt(q.numerator)*pow10(denScale)*BigInt(metric.multiplyBy),den=BigInt(q.denominator)*pow10(scale);return[key,{value:divide(num,den,6),exactRational:den===0n?null:{numerator:num.toString(),denominator:den.toString()},multiplyBy:metric.multiplyBy,rows:q.count,zeroDenominator:den===0n,nullPolicy:'Missing values rejected; filter explicitly to exclude them.',numeratorUnit:c?.unit??'',denominatorUnit:metric.denominator!.column.unit}]}
        if(m.kind==='mean'&&c?.type!=='real'){const q=JSON.parse(String(v)),den=BigInt(q.denominator)*pow10(scale);return[key,{value:divide(BigInt(q.numerator),den,Math.max(6,scale)),exactRational:{numerator:q.numerator,denominator:den.toString()},rounding:'half-away-from-zero display'}]}
        return[key,c&&m.kind!=='period'&&!['count','count-distinct'].includes(m.kind)?cellDisplay(v,c):jsonSafe(v)]
      })))
      result.columns=[...groups.map(g=>({name:g.name,type:g.period?'period':g.field.column.type,sourceColumn:g.key})),...metrics.map(m=>({name:m.name,operation:m.op,sourceColumn:m.field?.column.name,unit:m.field?.column.unit??'',numericEncoding:m.field?.column.type==='real'?'approximate IEEE-754':'exact integers/decimals serialized as strings; means include an exact rational'}))]
    }else{
      const selected=list(r.columns??relation.datasets[0]!.data.policy.columns.slice(0,12).map(c=>c.id),'columns',32).map(v=>({key:text(v,'column'),field:this.field(relation.fields,v)}))
      if(!selected.length||new Set(selected.map(s=>s.key)).size!==selected.length)throw new Error('Choose distinct columns.')
      const order=list(r.orderBy??[],'orderBy',8).map(v=>{const o=object(v,'order');return `${this.field(relation.fields,o.column).sql} ${o.descending===true?'DESC':'ASC'}`})
      const sql=`${cte} SELECT a.__dataset_id AS __dataset_id,a.__row AS __source_row${relation.datasets.length>list(r.datasetIds,'datasets').length?',b.__dataset_id AS __right_dataset_id,b.__row AS __right_source_row':''},${selected.map((s,i)=>`${s.field.sql} AS v${i}`).join(',')} FROM ${from} WHERE ${where} ORDER BY ${order.length?order.join(','):'a.__dataset_id,a.__row'} LIMIT ?`
      const rows=this.all(sql,[...params,limit])
      result.totalResultRows=matched
      result.rows=rows.map(row=>({__dataset_id:row.__dataset_id,__source_row:String(row.__source_row),...(row.__right_dataset_id?{__right_dataset_id:row.__right_dataset_id,__right_source_row:String(row.__right_source_row)}:{}),...Object.fromEntries(selected.map((s,i)=>[s.key,cellDisplay(row[`v${i}`],s.field.column)]))}))
      result.columns=selected.map(s=>({id:s.key,name:s.field.column.name,type:s.field.column.type,unit:s.field.column.unit}))
      result.warnings.push('Detail rows are a bounded display, not a representative statistical sample. Use metrics/analyze_data for population statistics.')
    }
    result.displayedRows=result.rows.length;result.outputTruncated=result.totalResultRows>result.rows.length
    result.rows=jsonSafe(result.rows) as Record<string,unknown>[]
    result.sql=[...this.sql];result.parameters=[...this.parameters]
    return result
  }
}
