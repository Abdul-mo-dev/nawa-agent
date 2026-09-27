#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
import {validateExplorer} from './transform.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(path.join(root,'package.json'))
let ts;try{ts=require('typescript')}catch{console.error('Install the checkout dependencies before running the sidebar tests.');process.exit(1)}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nawa-inspector-tests-'))
let code=1
try{
 const source=await fs.readFile(path.join(root,'apps/shell/src/renderer/src/explorer/ExplorerHome.tsx'),'utf8');validateExplorer(ts,source)
 for(const relative of ['apps/shell/src/renderer/src/explorer/ExplorerHome.tsx','apps/shell/src/renderer/src/explorer/model.ts','apps/shell/src/renderer/src/rag/RagToolbar.tsx','apps/shell/src/renderer/src/analytics/AnalyticsToolbar.tsx']){
  const text=await fs.readFile(path.join(root,relative),'utf8'),result=ts.transpileModule(text,{fileName:relative,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}})
  if(result.diagnostics?.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>root,getNewLine:()=>os.EOL}))
 }
 await fs.writeFile(path.join(temp,'hooks.mjs'),`let current,cursor;const states=new Map();export function begin(key){if(!states.has(key))states.set(key,[]);current=states.get(key);cursor=0;}export function useState(initial){const i=cursor++,s=current;if(!(i in s))s[i]=typeof initial==='function'?initial():initial;return [s[i],v=>{s[i]=typeof v==='function'?v(s[i]):v}];}export function useRef(v){return useState(()=>({current:v}))[0]}export function useId(){return useState(()=> 'panel-'+states.size)[0]}export function useEffect(){};`)
 for(const name of ['inspector-tabs-model.ts','WorkspaceInspector.tsx']){
  const file=path.join(root,'apps/shell/src/renderer/src/explorer',name),text=await fs.readFile(file,'utf8')
  let result=ts.transpileModule(text,{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React,jsxFactory:'h',jsxFragmentFactory:'Fragment'}})
  if(result.diagnostics?.length)throw new Error('Inspector component syntax error')
  let js=result.outputText.replace(/import ['"][^'"]+\.css['"];?/g,'').replace(/from ['"]react['"]/g,"from './hooks.mjs'").replace(/from ['"]\.\/inspector-tabs-model['"]/g,"from './inspector-tabs-model.mjs'")
  if(name.endsWith('tsx'))js=`const Fragment=Symbol.for('fragment');const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});\n`+js
  await fs.writeFile(path.join(temp,name.replace(/\.tsx?$/,'.mjs')),js)
 }
 const model=await fs.readFile(path.join(root,'apps/shell/src/renderer/src/explorer/model.ts'),'utf8')
 await fs.writeFile(path.join(temp,'preferences.mjs'),ts.transpileModule(model,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText)
 console.log('Updated source structure and TypeScript syntax passed. Component/state checks use an isolated hook harness, not a complete Electron runtime.')
 code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',path.join(root,'tools/inspector-tabs/cases.mjs')],{stdio:'inherit',env:{...process.env,NAWA_INSPECTOR_BUILD:temp,NAWA_INSPECTOR_PROJECT:root}});child.once('error',reject);child.once('exit',n=>resolve(n??1))})
}catch(error){console.error(error.stack||String(error))}
finally{await fs.rm(temp,{recursive:true,force:true})}
process.exitCode=code
