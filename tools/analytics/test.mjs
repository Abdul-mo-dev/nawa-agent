#!/usr/bin/env node
/** Project-local core tests. Uses the checkout's real file-safety/XML/date helpers and dependencies. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(path.join(root,'package.json'))
process.chdir(root)
let ts
try{ts=require('typescript')}catch{console.error('Install the project dependencies before running analytics tests.');process.exit(1)}
const output=await fs.mkdtemp(path.join(os.tmpdir(),'nawa-analytics-test-')),visited=new Set()
async function emit(relative){
  relative=relative.replaceAll('\\','/');if(visited.has(relative))return;visited.add(relative)
  const source=await fs.readFile(path.join(root,relative),'utf8'),dependencies=[]
  const result=ts.transpileModule(source,{fileName:relative,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}})
  const update=spec=>{if(spec.startsWith('.')&&!/\.(?:mjs|js|json|css)$/.test(spec)){const dep=path.posix.normalize(path.posix.join(path.posix.dirname(relative),spec+'.ts'));dependencies.push(dep);return spec+'.mjs'}return spec}
  const js=result.outputText.replace(/(from\s*|import\s*\(\s*|import\s*)(['"])([^'"]+)\2/g,(all,before,quote,spec)=>`${before}${quote}${update(spec)}${quote}`)
  const target=path.join(output,relative.replace(/\.tsx?$/,'.mjs'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,js)
  for(const dep of dependencies)await emit(dep)
}
let code=1
try{
  await fs.symlink(path.join(root,'node_modules'),path.join(output,'node_modules'),process.platform==='win32'?'junction':'dir')
  await emit('apps/shell/src/main/analytics/engine.ts');await emit('apps/shell/src/main/analytics/worker.ts')
  const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true,noEmit:true,lib:['lib.es2022.d.ts','lib.dom.d.ts'],types:['node']}
  const config=ts.convertCompilerOptionsFromJson({target:'ES2022',module:'ESNext',moduleResolution:'bundler',strict:true,skipLibCheck:true,noEmit:true,lib:['ES2022','DOM'],types:['node']},root).options
  const program=ts.createProgram([...visited].map(p=>path.join(root,p)),config)
  const diagnostics=ts.getPreEmitDiagnostics(program)
  if(diagnostics.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=>os.EOL}))
  console.log(`Strict core TypeScript check passed (${visited.size} source modules).`)
  const syntaxRoots=['apps/shell/src/main/analytics','apps/shell/src/renderer/src/analytics','apps/shell/src/preload/analytics.ts','apps/shell/src/shared/analytics-api.ts']
  let syntaxCount=0
  async function syntax(relative){const target=path.join(root,relative),stat=await fs.stat(target);if(stat.isDirectory()){for(const name of await fs.readdir(target))await syntax(path.join(relative,name));return}if(!/\.tsx?$/.test(relative))return
    const source=await fs.readFile(target,'utf8'),out=ts.transpileModule(source,{fileName:target,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}})
    if(out.diagnostics?.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(out.diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=>os.EOL}));syntaxCount++
  }
  for(const relative of syntaxRoots)await syntax(relative)
  console.log(`Added main/preload/UI TypeScript syntax checks passed (${syntaxCount} modules; not a full Electron/React typecheck).`)

  code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',path.join(root,process.argv.includes('--large')?'tools/analytics/stress.mjs':'tools/analytics/cases.mjs')],{stdio:'inherit',env:{...process.env,NAWA_ANALYTICS_BUILD:output,NAWA_ANALYTICS_PROJECT:root}});child.once('error',reject);child.once('exit',n=>resolve(n??1))})
}catch(e){console.error(e.stack||String(e))}
finally{await fs.rm(output,{recursive:true,force:true})}
process.exitCode=code
