import { randomUUID } from 'node:crypto'
import type { AnalyticsResult, DataQuery, DataFilter } from '../../shared/analytics-api'
import { QuerySession, type Relation, type Field } from './query'
import { object, text } from './validation'
import { cellDisplay, decimal, display, divide, pow10, validDate, jsonSafe } from './numeric'
function numeric(session:QuerySession,relation:Relation,key:unknown):Field {
  const field=session.field(relation.fields,key)
  if(!['integer','decimal','real'].includes(field.column.type)||field.column.role!=='measure')throw new Error('Statistics require a reviewed numeric measure column.')
  return field
}
function coefficient(value:unknown,scale:number):bigint {
  const d=decimal(String(value));if(d.scale>scale)throw new Error('Inconsistent statistic scale.');return d.coefficient*pow10(scale-d.scale)
}
function receipt(session:QuerySession,raw:unknown,relation:Relation,summary:Record<string,unknown>,rows:Record<string,unknown>[]=[],population:Record<string,unknown>={}):AnalyticsResult{
  return {id:'analysis_'+randomUUID(),createdAt:Date.now(),operation:'statistics',sources:relation.sources,sql:[...session.sql],parameters:[...session.parameters],population,columns:[],rows:jsonSafe(rows) as Record<string,unknown>[],totalResultRows:rows.length,displayedRows:rows.length,outputTruncated:false,inputSampled:false,warnings:relation.warnings,summary:jsonSafe(summary) as Record<string,unknown>,request:raw}
}
/** Defined numerical methods over complete filtered rows; no arbitrary code execution or row sampling. */
export function analyze(session:QuerySession,input:unknown):AnalyticsResult {
  const r=object(input,'analysis')
  if(r.join!==undefined)throw new Error('Statistical methods do not accept joins. Use a reviewed analytical source or query_data for validated joins.')
  const method=text(r.method,'analysis method'),relation=session.relation(r),f=numeric(session,relation,r.column)
  if(method==='compare-periods')return comparePeriods(session,r,relation,f)
  if(!['describe','correlation'].includes(method))throw new Error('Use describe, correlation, or compare-periods.')
  const {cte,from,where,params}=relation,scale=f.column.type==='decimal'?f.column.scale:0
  session.currency(relation,[])
  const matched=session.count(`${cte} SELECT COUNT(*) n FROM ${from} WHERE ${where}`,params)
  if(method==='correlation'){
    const other=numeric(session,relation,r.otherColumn),otherScale=other.column.type==='decimal'?other.column.scale:0
    let n=0,mx=0,my=0,sx=0,sy=0,cov=0,originX:bigint|null=null,originY:bigint|null=null
    const sql=`${cte} SELECT ${f.sql} x,${other.sql} y FROM ${from} WHERE ${where} AND ${f.sql} IS NOT NULL AND ${other.sql} IS NOT NULL`
    for(const row of session.statement(sql,params).iterate(...params)){
      session.check();if(f.column.type!=='real'&&originX===null)originX=BigInt(String(row.x));if(other.column.type!=='real'&&originY===null)originY=BigInt(String(row.y));const x=(originX===null?Number(row.x):Number(BigInt(String(row.x))-originX))/10**scale,y=(originY===null?Number(row.y):Number(BigInt(String(row.y))-originY))/10**otherScale
      n++;const dx=x-mx,dy=y-my;mx+=dx/n;my+=dy/n;sx+=dx*(x-mx);sy+=dy*(y-my);cov+=dx*(y-my)
      if(![mx,my,sx,sy,cov].every(Number.isFinite))throw new Error('Numerical overflow during correlation. Rescale the measure units.')
    }
    const pearson=n>1&&sx>0&&sy>0?Math.max(-1,Math.min(1,cov/(Math.sqrt(sx)*Math.sqrt(sy)))):null
    const result=receipt(session,input,relation,{method:'Pearson correlation (online centered covariance)',coefficient:pearson,pairedRows:n,excludedMissingPairs:matched-n,precision:'Approximate floating-point statistic; all eligible pairs processed.',interpretation:'Association, not causation. No significance test, confidence interval or causal claim is implied.'},[],{matchedRows:matched,pairedRows:n})
    if(pearson===null)result.warnings.push('Correlation is undefined with fewer than two paired observations or a constant column.')
    return result
  }
  const exact=f.column.type!=='real',sumFn=exact?'analytics_exact_sum':'SUM',meanFn=exact?'analytics_exact_mean':'AVG'
  const aggregate=session.all(`${cte} SELECT COUNT(${f.sql}) n,MIN(${f.sql}) minimum,MAX(${f.sql}) maximum,${sumFn}(${f.sql}) total,${meanFn}(${f.sql}) mean FROM ${from} WHERE ${where}`,params)[0]!
  const n=Number(aggregate.n),mean=aggregate.mean===null?null:exact?JSON.parse(String(aggregate.mean)):null
  const quantile=(q:number):unknown=>{
    if(!n)return null
    const position=(n-1)*q,offset=Math.floor(position/4),remainder=position%4
    const values=session.all(`${cte} SELECT ${f.sql} v FROM ${from} WHERE ${where} AND ${f.sql} IS NOT NULL ORDER BY ${f.sql} LIMIT 2 OFFSET ?`,[...params,offset])
    const a=values[0]!.v,b=values[1]?.v??a
    if(!exact)return Number(a)+(Number(b)-Number(a))*remainder/4
    const numerator=BigInt(String(a))*4n+(BigInt(String(b))-BigInt(String(a)))*BigInt(remainder),denominator=4n*pow10(scale)
    return {value:divide(numerator,denominator,Math.max(6,scale)),exactRational:{numerator:numerator.toString(),denominator:denominator.toString()}}
  }
  let seen=0,runningMean=0,m2=0,origin:bigint|null=null
  const sql=`${cte} SELECT ${f.sql} v FROM ${from} WHERE ${where} AND ${f.sql} IS NOT NULL`
  for(const row of session.statement(sql,params).iterate(...params)){
    session.check();if(exact&&origin===null)origin=BigInt(String(row.v));const x=(origin===null?Number(row.v):Number(BigInt(String(row.v))-origin))/10**scale,delta=x-runningMean;seen++;runningMean+=delta/seen;m2+=delta*(x-runningMean)
    if(!Number.isFinite(m2)||!Number.isFinite(runningMean))throw new Error('Numerical overflow during variance. Rescale the source units.')
  }
  if(seen!==n)throw new Error('Population changed during statistics; retry against a stable snapshot.')
  const summary:Record<string,unknown>={method:'Complete-population descriptive statistics',count:n,missing:matched-n,
    minimum:cellDisplay(aggregate.minimum,f.column),maximum:cellDisplay(aggregate.maximum,f.column),
    sum:aggregate.total===null?null:exact?display(BigInt(String(aggregate.total)),scale):aggregate.total,
    mean:mean?{value:divide(BigInt(mean.numerator),BigInt(mean.denominator)*pow10(scale),Math.max(6,scale)),exactRational:{numerator:mean.numerator,denominator:(BigInt(mean.denominator)*pow10(scale)).toString()}}:aggregate.mean,
    q1:quantile(1),median:quantile(2),q3:quantile(3),quantileDefinition:'Linear interpolation at (n - 1) p over all non-null observations; exact rational interpolation for integer/decimal columns.',
    populationVariance:seen?m2/seen:null,sampleVariance:seen>1?m2/(seen-1):null,
    populationStdDev:seen?Math.sqrt(Math.max(0,m2/seen)):null,sampleStdDev:seen>1?Math.sqrt(Math.max(0,m2/(seen-1))):null,
    precision:exact?'Sum and rational mean/quantiles are exact for stored values. Variance/stddev are approximate floating-point calculations.':'REAL values and statistics use approximate floating point.',
    unit:f.column.unit||'unspecified',nullPolicy:'Null values excluded from numerical statistics and counted separately; no imputation.'}
  return receipt(session,input,relation,summary,[],{matchedRows:matched,nonNullRows:n,excludedMissing:matched-n})
}
function comparePeriods(session:QuerySession,r:Record<string,unknown>,relation:Relation,f:Field):AnalyticsResult{
  const date=session.field(relation.fields,r.dateColumn),group=session.field(relation.fields,r.groupColumn)
  if(date.column.type!=='date')throw new Error('Period comparisons require a validated date column.')
  if(f.column.type==='real')throw new Error('Exact contribution reconciliation requires an integer or fixed-decimal measure.')
  const current=object(r.current,'current period'),previous=object(r.previous,'previous period')
  const period=(p:Record<string,unknown>)=>{const from=text(p.from,'period start'),to=text(p.to,'exclusive period end');if(!validDate(from)||!validDate(to)||from>=to)throw new Error('Use a nonempty ISO date interval [from, to).');return {from,to}}
  const a=period(current),b=period(previous)
  if(a.from<b.to&&b.from<a.to)throw new Error('Comparison periods must not overlap.')
  const query=(p:{from:string;to:string}):DataQuery=>({datasetIds:r.datasetIds as string[],filters:[...(r.filters as DataFilter[]??[]),{column:String(r.dateColumn),op:'gte',value:p.from},{column:String(r.dateColumn),op:'lt',value:p.to}],groupBy:[{column:String(r.groupColumn),as:'group'}],metrics:[{op:'sum',column:String(r.column),as:'value'},{op:'count',as:'records'},{op:'count',column:String(r.column),as:'valid_values'}]})
  // Internal result expansion is bounded by maxGroups, not the user-facing display limit.
  const now=session.execute(query(a),session.settings.maxGroups),before=session.execute(query(b),session.settings.maxGroups)
  const scale=f.column.type==='decimal'?f.column.scale:0,values=new Map<string,{group:unknown;current:bigint;previous:bigint;currentRows:number;previousRows:number;currentValid:number;previousValid:number}>()
  for(const [result,side] of [[now,'current'],[before,'previous']] as const)for(const row of result.rows){if(Number(row.records)>0&&Number(row.valid_values)===0)throw new Error('A period group has only missing measure values; it cannot be treated as zero.');const key=JSON.stringify(row.group);let item=values.get(key);if(!item){item={group:row.group,current:0n,previous:0n,currentRows:0,previousRows:0,currentValid:0,previousValid:0};values.set(key,item)}item[side]=row.value===null?0n:coefficient(row.value,scale);item[side==='current'?'currentRows':'previousRows']=Number(row.records);item[side==='current'?'currentValid':'previousValid']=Number(row.valid_values)}
  if(values.size>session.settings.maxGroups)throw new Error('Too many comparison groups. Narrow the group/filter.')
  const all=[...values.values()],totalCurrent=all.reduce((s,v)=>s+v.current,0n),totalPrevious=all.reduce((s,v)=>s+v.previous,0n),delta=totalCurrent-totalPrevious
  all.sort((x,y)=>{const a=x.current-x.previous,b=y.current-y.previous,aa=a<0n?-a:a,bb=b<0n?-b:b;return aa>bb?-1:aa<bb?1:0})
  const rows=all.slice(0,session.settings.resultRows).map(v=>{const d=v.current-v.previous;return {group:v.group,current:display(v.current,scale),previous:display(v.previous,scale),change:display(d,scale),changePercent:divide(d*100n,v.previous,4),contributionToNetChangePercent:divide(d*100n,delta,4),currentRows:v.currentRows,previousRows:v.previousRows,currentMissingValues:v.currentRows-v.currentValid,previousMissingValues:v.previousRows-v.previousValid}})
  const sumOfChanges=all.reduce((s,v)=>s+v.current-v.previous,0n)
  if(sumOfChanges!==delta)throw new Error('Contribution reconciliation failed.')
  const result=receipt(session,r,relation,{method:'Exact period sums and additive change attribution',currentPeriod:a,previousPeriod:b,group:group.column.name,unit:f.column.unit||'unspecified',current:display(totalCurrent,scale),previous:display(totalPrevious,scale),change:display(delta,scale),changePercent:divide(delta*100n,totalPrevious,4),reconciled:true,currentMissingValues:all.reduce((n,v)=>n+v.currentRows-v.currentValid,0),previousMissingValues:all.reduce((n,v)=>n+v.previousRows-v.previousValid,0),nullPolicy:'Period sums exclude null measure values; missing values are counted, not imputed.',allGroupChanges:display(sumOfChanges,scale),netContributionDenominator:display(delta,scale),interpretation:'Arithmetic attribution only, not a causal explanation. Zero denominators return null; contributions can be negative or exceed 100% when groups offset one another.'},rows,{current:now.population,previous:before.population})
  result.totalResultRows=all.length;result.outputTruncated=rows.length<all.length
  result.warnings.push('Absent groups are treated as zero recorded activity within the approved imported population; this does not establish that external source periods are complete. Percent changes with negative baselines need domain interpretation.')
  return result
}
