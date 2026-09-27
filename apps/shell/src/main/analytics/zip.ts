import { open, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInflateRaw } from 'node:zlib'
import { utf8 } from './stream'
const crcTable = Uint32Array.from({length:256}, (_,n) => { for(let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1; return n>>>0 })
function crc32(crc: number, bytes: Uint8Array): number { for(const b of bytes) crc=crcTable[(crc^b)&255]!^(crc>>>8);return crc>>>0 }
interface Entry { name:string; offset:number; compressed:number; expanded:number; method:number; flags:number; crc:number }
/** Local-only ZIP reader. ZIP64/encryption are rejected rather than incompletely imported. */
export class TableZip {
  private entries=new Map<string,Entry>()
  private directoryOffset=0
  private expandedTotal=0
  private constructor(private path:string,private handle:FileHandle,private maxExpanded:number,private check:()=>void) {}
  static async load(path:string,maxExpanded:number,check:()=>void):Promise<TableZip> {
    const handle=await open(path,'r'), zip=new TableZip(path,handle,maxExpanded,check)
    try { await zip.directory();return zip } catch(e) {await handle.close();throw e}
  }
  private async read(at:number,length:number):Promise<Buffer> {
    if(length<0||at<0)throw new Error('Invalid ZIP offset.')
    const b=Buffer.alloc(length);let got=0
    while(got<length) {const r=await this.handle.read(b,got,length-got,at+got);if(!r.bytesRead)throw new Error('Truncated ZIP file.');got+=r.bytesRead}
    return b
  }
  private async directory():Promise<void> {
    const {size}=await this.handle.stat(),length=Math.min(size,65557),tail=await this.read(size-length,length)
    let end=-1
    for(let i=tail.length-22;i>=0;i--) if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break}
    if(end<0)throw new Error('Invalid XLSX ZIP directory.')
    const count=tail.readUInt16LE(end+10),bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16)
    if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||count!==tail.readUInt16LE(end+8))throw new Error('Multi-disk ZIP is unsupported.')
    if(count===65535||bytes===0xffffffff||offset===0xffffffff)throw new Error('ZIP64 workbooks are unsupported. Export the tables as CSV/TSV for streaming import.')
    if(count>20000||bytes>32*1024*1024||offset+bytes>size-length+end)throw new Error('ZIP directory limit exceeded.')
    this.directoryOffset=offset
    const data=await this.read(offset,bytes);let at=0
    for(let i=0;i<count;i++) {
      if(at+46>data.length||data.readUInt32LE(at)!==0x02014b50)throw new Error('Invalid ZIP entry.')
      const flags=data.readUInt16LE(at+8),method=data.readUInt16LE(at+10),compressed=data.readUInt32LE(at+20),expanded=data.readUInt32LE(at+24),nameLength=data.readUInt16LE(at+28),extra=data.readUInt16LE(at+30),comment=data.readUInt16LE(at+32),localOffset=data.readUInt32LE(at+42)
      const next=at+46+nameLength+extra+comment
      if(next>data.length||compressed===0xffffffff||expanded===0xffffffff||localOffset===0xffffffff)throw new Error('ZIP64 or truncated workbook entry.')
      const name=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(at+46,at+46+nameLength))
      if(name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').includes('..')||this.entries.has(name))throw new Error('Unsafe or duplicate ZIP entry name.')
      if(flags&1||![0,8].includes(method))throw new Error('Encrypted or unsupported ZIP compression.')
      if(expanded>this.maxExpanded||localOffset+30+compressed>offset)throw new Error('Workbook entry exceeds the resource bounds.')
      this.entries.set(name,{name,flags,method,compressed,expanded,offset:localOffset,crc:data.readUInt32LE(at+16)});at=next
    }
    if(at!==data.length)throw new Error('Unexpected ZIP directory content.')
  }
  has(name:string):boolean{return this.entries.has(name)}
  names():string[]{return [...this.entries.keys()]}
  async *part(name:string):AsyncGenerator<Buffer> {
    const e=this.entries.get(name);if(!e)throw new Error(`Missing workbook part: ${name}`)
    const header=await this.read(e.offset,30)
    if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==e.method||header.readUInt16LE(6)&1)throw new Error('Invalid ZIP local header.')
    const nameLength=header.readUInt16LE(26),start=e.offset+30+nameLength+header.readUInt16LE(28)
    const actualName=await this.read(e.offset+30,nameLength)
    if(actualName.toString('utf8')!==e.name||start+e.compressed>this.directoryOffset)throw new Error('ZIP entry bounds mismatch.')
    if(!e.compressed){if(e.expanded||e.crc)throw new Error('Truncated ZIP entry.');return}
    const source=createReadStream(this.path,{start,end:start+e.compressed-1,highWaterMark:65536})
    const inflate=e.method===8?createInflateRaw():null
    if(inflate)source.on('error',error=>inflate.destroy(error))
    const output=inflate?source.pipe(inflate):source
    let count=0,crc=0xffffffff
    try {
      for await(const bytes of output){this.check();const b=Buffer.from(bytes);count+=b.length;this.expandedTotal+=b.length;if(count>e.expanded||this.expandedTotal>this.maxExpanded)throw new Error('Workbook expansion/read budget exceeded.');crc=crc32(crc,b);yield b}
      if(count!==e.expanded||((crc^0xffffffff)>>>0)!==e.crc)throw new Error('Workbook ZIP checksum or length mismatch.')
    }finally{source.destroy();inflate?.destroy()}
  }
  async text(name:string):Promise<string>{let out='';for await(const s of utf8(this.part(name))){out+=s;if(out.length>16*1024*1024)throw new Error('Workbook metadata exceeds 16 MiB.')}return out}
  close():Promise<void>{return this.handle.close()}
}
