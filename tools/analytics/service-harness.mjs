/** Electron lifecycle test double; the analytical workers, filesystem and SQLite remain real. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const project=process.env.NAWA_ANALYTICS_PROJECT,build=process.env.NAWA_ANALYTICS_BUILD
if(!project||!build)throw new Error('Run through tools/analytics/test.mjs.')
const require=createRequire(path.join(project,'package.json')),ts=require('typescript'),folder=path.join(build,'apps/shell/src/main/analytics')
const stub=path.join(folder,'electron-harness.mjs')
await fs.writeFile(stub,`import {EventEmitter} from 'node:events';export const app=new EventEmitter();app.getPath=()=>process.env.NAWA_ANALYTICS_HARNESS_USERDATA;export const handlers=new Map();export const ipcMain={handle:(name,fn)=>handlers.set(name,fn)};export class Sender extends EventEmitter{constructor(id=123){super();this.id=id;this.mainFrame={};this.messages=[]}isDestroyed(){return false}send(...args){this.messages.push(args);this.emit('sent',...args)}}`)
const source=await fs.readFile(path.join(project,'apps/shell/src/main/analytics/service.ts'),'utf8')
let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
code=code.replace(/import workerPath from ['"]\.\/worker\?modulePath['"];?/,`const workerPath=${JSON.stringify(path.join(folder,'worker.mjs'))};`)
code=code.replace(/(['"])electron\1/g,"'./electron-harness.mjs'").replace(/(from\s*)(['"])(\.[^'"]+)\2/g,(all,from,q,spec)=>`${from}${q}${spec.endsWith('.mjs')?spec:spec+'.mjs'}${q}`)
const output=path.join(folder,'service-harness.mjs');await fs.writeFile(output,code)
export const electron=await import(pathToFileURL(stub).href)
export const service=await import(pathToFileURL(output).href)
