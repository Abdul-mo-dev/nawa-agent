import { basename, extname, posix } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readXml, descendants, children, attr, innerText, type XmlNode } from '../../../../../packages/file-parse/src/rag-xml'
import { builtinDateFormat, classifyFormatCode, formatSerial, type DateFormatParts } from '../../../../../packages/file-parse/src/xlsx-dates'
import { delimited, fileText, jsonArray, jsonLines, jsonRecord, xmlFragments, type RawCell, type RawRow, type ReadEvent, type ReadLimits, type SourceTable } from './stream'
import { TableZip } from './zip'
export const TABLE_EXTENSIONS = new Set(['.csv','.tsv','.jsonl','.ndjson','.json','.xlsx','.xlsm'])
export function columnNumber(name:string):number {
  if(!/^[A-Z]{1,3}$/i.test(name))throw new Error('Invalid Excel column reference.')
  let n=0;for(const c of name.toUpperCase())n=n*26+c.charCodeAt(0)-64
  if(n<1||n>16384)throw new Error('Excel column out of range.');return n
}
export function columnName(n:number):string {let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}
function cellRef(value:string):{column:number;row:number}{const m=/^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(value);if(!m)throw new Error('Invalid Excel cell reference.');const row=Number(m[2]);if(row<1||row>1048576)throw new Error('Excel row out of range.');return {column:columnNumber(m[1]!),row}}
function range(value:string):{firstColumn:number;lastColumn:number;headerRow:number;lastRow:number}{const p=value.split(':');if(p.length>2)throw new Error('Invalid table range.');const a=cellRef(p[0]!),b=cellRef(p[1]??p[0]!);if(b.column<a.column||b.row<a.row)throw new Error('Reversed table range.');return {firstColumn:a.column,lastColumn:b.column,headerRow:a.row,lastRow:b.row}}
function resolvePart(from:string,target:string):string {
  if(/^[a-z]+:/i.test(target)||target.includes('\\')||target.includes('\0')||target.includes('#'))throw new Error('External or unsafe workbook relationship.')
  const name=posix.normalize(target.startsWith('/')?target.slice(1):posix.join(posix.dirname(from),target))
  if(name.startsWith('../')||name==='..'||!name.startsWith('xl/'))throw new Error('Workbook relationship escapes xl/.')
  return name
}
async function relations(zip:TableZip,part:string):Promise<Map<string,{path:string;type:string}>> {
  const relPath=posix.join(posix.dirname(part),'_rels',posix.basename(part)+'.rels'),out=new Map<string,{path:string;type:string}>()
  if(zip.has(relPath))for(const r of descendants(readXml(await zip.text(relPath)),'Relationship')){
    if(attr(r,'TargetMode').toLowerCase()==='external')continue
    const key=attr(r,'Id');if(out.has(key))throw new Error('Duplicate workbook relationship.')
    out.set(key,{path:resolvePart(part,attr(r,'Target')),type:attr(r,'Type')})
  }
  return out
}
function richText(node:XmlNode):string {
  return children(node).map(c=>c.name.split(':').pop()==='t'?innerText(c):c.name.split(':').pop()==='r'?children(c,'t').map(innerText).join(''):'').join('')
}
async function* workbook(file:string,db:DatabaseSync,limits:ReadLimits):AsyncGenerator<ReadEvent> {
  // Limits cover repeated part reads as well as decompression. Shared strings live in SQLite, not a giant JS array.
  const zip=await TableZip.load(file,Math.max(256*1024*1024,Math.min(16*1024**3,limits.maxBytes*8)),limits.check)
  db.exec('DROP TABLE IF EXISTS temp.analytics_shared_strings; CREATE TEMP TABLE analytics_shared_strings(id INTEGER PRIMARY KEY,value TEXT NOT NULL) STRICT;')
  try {
    const workbookPart='xl/workbook.xml',doc=readXml(await zip.text(workbookPart)),rels=await relations(zip,workbookPart)
    const date1904=['1','true'].includes(attr(descendants(doc,'workbookPr')[0],'date1904'))
    const warnings:string[]=[]
    if(zip.names().some(p=>p.startsWith('xl/externalLinks/')))warnings.push('Workbook has external links. They are not fetched or recalculated.')
    if(zip.has('xl/vbaProject.bin'))warnings.push('Workbook contains macros. They are not executed.')
    if(descendants(doc,'calcPr').some(n=>attr(n,'fullCalcOnLoad')==='1'||attr(n,'forceFullCalc')==='1'))warnings.push('Workbook requests recalculation; saved formula caches may be stale.')
    const styles:Map<number,DateFormatParts>=new Map()
    const stylePart=[...rels.values()].find(r=>r.type.endsWith('/styles'))?.path??'xl/styles.xml'
    if(zip.has(stylePart)){
      const s=readXml(await zip.text(stylePart)),custom=new Map(descendants(s,'numFmt').map(n=>[Number(attr(n,'numFmtId')),classifyFormatCode(attr(n,'formatCode'))]))
      const xfs=descendants(s,'cellXfs')[0]
      if(xfs)children(xfs,'xf').forEach((n,i)=>{const id=Number(attr(n,'numFmtId')||0),parts=custom.has(id)?custom.get(id):builtinDateFormat(id);if(parts)styles.set(i,parts)})
    }
    const stringPart=[...rels.values()].find(r=>r.type.endsWith('/sharedStrings'))?.path??'xl/sharedStrings.xml'
    if(zip.has(stringPart)){
      const insert=db.prepare('INSERT INTO temp.analytics_shared_strings VALUES(?,?)');let i=0
      db.exec('BEGIN')
      try{for await(const fragment of xmlFragments(zip.part(stringPart),'si',limits)){const n=descendants(readXml(fragment),'si')[0]!;insert.run(i++,richText(n));if(i%1000===0){db.exec('COMMIT; BEGIN');limits.check()}}db.exec('COMMIT')}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}
    }
    const getString=db.prepare('SELECT value FROM temp.analytics_shared_strings WHERE id=?'),cache=new Map<number,string>()
    const shared=(value:string):string=>{if(!/^\d+$/.test(value))throw new Error('Invalid shared-string index.');const i=Number(value);let s=cache.get(i);if(s!==undefined)return s;const r=getString.get(i) as {value:string}|undefined;if(!r)throw new Error('Missing shared string.');s=r.value;cache.set(i,s);if(cache.size>512)cache.delete(cache.keys().next().value!);return s}
    const sheets=descendants(doc,'sheet')
    if(sheets.length>512)throw new Error('Too many worksheets.')
    for(const [sheetIndex,sheet] of sheets.entries()){
      limits.check()
      const sheetName=attr(sheet,'name'),rel=rels.get(attr(sheet,'id'))
      if(!rel)throw new Error(`Missing worksheet relationship: ${sheetName}`)
      if(!rel.type.endsWith('/worksheet')){warnings.push(`Non-worksheet part ${sheetName} is not tabular data.`);continue}
      const sheetPart=rel.path,sheetRels=await relations(zip,sheetPart),tables:SourceTable[]=[]
      const sheetWarnings=[...warnings]
      if(attr(sheet,'state')&&attr(sheet,'state')!=='visible')sheetWarnings.push(`Sheet is ${attr(sheet,'state')}; review its intended inclusion.`)
      for(const tRel of sheetRels.values())if(tRel.type.endsWith('/table')){
        const node=descendants(readXml(await zip.text(tRel.path)),'table')[0];if(!node)throw new Error('Missing Excel table definition.')
        const bounds=range(attr(node,'ref')),headers=descendants(node,'tableColumn').map(c=>attr(c,'name'))
        const headerCount=Number(attr(node,'headerRowCount')||1),totalCount=Number(attr(node,'totalsRowCount')||0)
        if(![0,1].includes(headerCount)||!Number.isSafeInteger(totalCount)||totalCount<0||totalCount>1)throw new Error('Unsupported table header/total row count.')
        if(bounds.lastColumn-bounds.firstColumn+1>limits.maxColumns)throw new Error('Table column limit reached.')
        if(headers.length!==bounds.lastColumn-bounds.firstColumn+1)throw new Error('Named table column count does not match its range.')
        const name=attr(node,'displayName')||attr(node,'name')
        tables.push({key:`sheet${sheetIndex}_table${tables.length}`,name,sheet:sheetName,range:attr(node,'ref'),kind:'xlsx-named-table',...bounds,
          headerRow:headerCount?bounds.headerRow:0,firstRow:bounds.headerRow+headerCount,lastRow:bounds.lastRow-totalCount,headers,
          warnings:[...sheetWarnings,'Scope is the declared Excel table; notes, charts and cells outside named tables are not analytical rows.',...(totalCount?['Declared totals row excluded from detail data.']:[])]})
      }
      if(tables.length>64)throw new Error('Too many tables on a worksheet.')
      if(!tables.length)tables.push({key:`sheet${sheetIndex}`,name:sheetName,sheet:sheetName,range:'detected worksheet region',kind:'xlsx-sheet-region',firstColumn:16384,lastColumn:0,headerRow:0,firstRow:1,lastRow:null,
        warnings:[...sheetWarnings,'No named Excel table. Review header, boundaries, subtotals and row grain before analysis. Merged cells are NOT forward-filled.']})
      for(const table of tables)yield {kind:'table',table}
      let previousRow=0
      for await(const fragment of xmlFragments(zip.part(sheetPart),'row',limits)){
        const node=descendants(readXml(fragment),'row')[0]!,r=Number(attr(node,'r')||previousRow+1)
        if(!Number.isSafeInteger(r)||r<=previousRow||r>1048576)throw new Error('Invalid or out-of-order worksheet row.')
        previousRow=r;const cells:Record<number,RawCell>=Object.create(null);let previousCol=0
        for(const cell of children(node,'c')){
          const ref=attr(cell,'r'),position=ref?cellRef(ref):{column:previousCol+1,row:r}
          if(position.row!==r||position.column<=previousCol)throw new Error('Invalid or duplicate worksheet cell reference.')
          previousCol=position.column
          const type=attr(cell,'t'),v=children(cell,'v')[0],f=children(cell,'f')[0],is=children(cell,'is')[0]
          let value=v?innerText(v):null,kind:RawCell['kind']='number',error:string|undefined
          if(type==='s'){value=value===null?null:shared(value.trim());kind='text'}
          else if(type==='inlineStr'){value=is?richText(is):'';kind='text'}
          else if(type==='str'){kind='text'}
          else if(type==='b'){if(value!==null&&!['0','1'].includes(value.trim()))throw new Error('Invalid workbook boolean.');value=value===null?null:value.trim()==='1'?'true':'false';kind='boolean'}
          else if(type==='e'){error=value||'Excel error';kind='text'}
          else if(type==='d'){kind='date'}
          else if(type&&type!=='n')throw new Error(`Unsupported cell type: ${type}`)
          if(kind==='number'&&value!==null&&styles.has(Number(attr(cell,'s')))){
            const formatted=formatSerial(Number(value),styles.get(Number(attr(cell,'s')))!,date1904)
            if(formatted!==null){value=formatted;kind='date'}
          }
          if(value!==null||f||error)cells[position.column]={value,kind,...(f?{formula:innerText(f)||`[${attr(f,'t')||'shared'} formula; saved value only]`}:{}),...(error?{error}:{})}
        }
        if(Object.keys(cells).length>limits.maxColumns)throw new Error('Populated worksheet row exceeds the column limit.')
        for(const table of tables){
          if(table.kind==='xlsx-named-table'&&(r<(table.headerRow||table.firstRow)||r>(table.lastRow??r)))continue
          const subset=Object.fromEntries(Object.entries(cells).filter(([c])=>table.kind!=='xlsx-named-table'||Number(c)>=table.firstColumn&&Number(c)<=table.lastColumn))
          if(table.kind!=='xlsx-named-table'&&!Object.keys(subset).length)continue
          if(table.kind==='xlsx-sheet-region'&&Object.keys(subset).length){
            const columns=Object.keys(subset).map(Number);table.firstColumn=Math.min(table.firstColumn,...columns);table.lastColumn=Math.max(table.lastColumn,...columns)
            if(table.lastColumn-table.firstColumn+1>limits.maxColumns)throw new Error('Detected worksheet region is too wide; define a named Excel table or export the intended region.')
            if(!table.headerRow){table.headerRow=r;table.firstRow=r+1}
          }
          yield {kind:'row',table:table.key,row:{row:r,cells:subset,hidden:['1','true'].includes(attr(node,'hidden'))}}
        }
      }
    }
  }finally{db.exec('DROP TABLE IF EXISTS temp.analytics_shared_strings');await zip.close()}
}
export async function* readTables(file:string,db:DatabaseSync,limits:ReadLimits):AsyncGenerator<ReadEvent>{
  const ext=extname(file).toLowerCase()
  if(ext==='.xlsx'||ext==='.xlsm'){yield*workbook(file,db,limits);return}
  const table:SourceTable={key:'records',name:basename(file,ext),sheet:'',range:'all records',kind:ext.slice(1),firstColumn:1,lastColumn:0,headerRow:ext==='.csv'||ext==='.tsv'?1:0,firstRow:ext==='.csv'||ext==='.tsv'?2:1,lastRow:null,warnings:[]}
  if(ext==='.csv'||ext==='.tsv'){
    table.warnings.push('First record is a candidate header. Confirm headers, units, subtotals and row grain before analysis. Input encoding: UTF-8.')
    yield{kind:'table',table}
    for await(const row of delimited(fileText(file),ext==='.tsv'?'\t':',',limits)){table.lastColumn=Math.max(table.lastColumn,Object.keys(row.cells).length);yield{kind:'row',table:table.key,row}}
    return
  }
  if(['.jsonl','.ndjson','.json'].includes(ext)){
    table.headers=[];table.warnings.push('Nested objects/arrays are preserved as JSON text; they are not exploded into rows. JSON numbers retain original decimal lexemes.')
    yield{kind:'table',table}
    const headers=new Map<string,number>(),records=ext==='.json'?jsonArray(fileText(file),limits):jsonLines(fileText(file),limits)
    for await(const record of records){
      const values=jsonRecord(record.text),cells:Record<number,RawCell>=Object.create(null)
      for(const [key,cell]of Object.entries(values)){if(!headers.has(key)){headers.set(key,headers.size+1);table.headers.push(key);if(headers.size>limits.maxColumns)throw new Error('JSON column limit exceeded.')}cells[headers.get(key)!]=cell}
      table.lastColumn=headers.size;yield{kind:'row',table:table.key,row:{row:record.row,cells,firstLine:record.row,lastLine:record.row}}
    }
    return
  }
  throw new Error('No validated table adapter for this format. Use CSV, TSV, JSON/JSONL, XLSX or XLSM. PDF/Office narrative RAG is not a table import.')
}
