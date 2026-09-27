import { parentPort, workerData } from 'node:worker_threads'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AnalyticsEngine, type AnalyticsJob } from './engine'
import { settings, message } from './validation'
const data=workerData as {databasePath:string;roots:string[];settings:unknown;job:AnalyticsJob;cancel:SharedArrayBuffer;deadline:number}
const flag=new Int32Array(data.cancel)
const check=()=>{if(Atomics.load(flag,0))throw new Error('Analysis/import cancelled. No partial generation was published.');if(Date.now()>data.deadline)throw new Error('Analysis exceeded its time budget. Narrow the operation or increase its explicit limit.')}
let engine:AnalyticsEngine|undefined
async function main():Promise<void>{
const heartbeat=setInterval(()=>parentPort?.postMessage({heartbeat:true}),1000)
try{
  await mkdir(dirname(data.databasePath),{recursive:true})
  engine=new AnalyticsEngine(data.databasePath,data.roots,settings(data.settings),check,p=>parentPort?.postMessage({progress:p}))
  const result=await engine.execute(data.job)
  check();parentPort?.postMessage({result})
}catch(e){parentPort?.postMessage({error:message(e)})}
finally{clearInterval(heartbeat);engine?.close();parentPort?.close()}

}
void main()
