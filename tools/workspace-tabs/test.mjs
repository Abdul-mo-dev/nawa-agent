#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(path.join(root,'package.json'))
let ts;try{ts=require('typescript')}catch{console.error('Install project dependencies before running workspace-tab tests.');process.exit(1)}
const read=relative=>fs.readFile(path.join(root,relative),'utf8')
const checks=[]
function check(name,ok){if(!ok)throw new Error(name);checks.push(name)}
const explorer=await read('apps/shell/src/renderer/src/explorer/ExplorerHome.tsx')
const model=await read('apps/shell/src/renderer/src/explorer/model.ts')
const chat=await read('apps/shell/src/renderer/src/WorkspaceChat.tsx')
const settings=await read('apps/shell/src/renderer/src/SettingsModal.tsx')
check('three-tab host is installed',explorer.includes('<WorkspaceControlPanel'))
check('old Details inspector destination removed',!explorer.includes("prefs.pane === 'details'"))
check('RAG/analytics controls removed from main file area',!explorer.includes('<RagToolbar')&&!explorer.includes('<AnalyticsToolbar'))
check('View menu exposes RAG & Analytics',explorer.includes("label: 'RAG & Analytics'"))
check('View menu exposes AI Provider',explorer.includes("label: 'AI Provider'"))
check('pane preferences use only current destinations',model.includes("'ai' | 'ragAnalytics' | 'provider' | 'none'"))
check('legacy RAG/analytics pane values migrate',model.includes("p.pane === 'rag' || p.pane === 'analytics' ? 'ragAnalytics'"))
check('assistant no longer renders file indexing panel',!chat.includes('<FileSearchPanel')&&!chat.includes("from './directory-actions/FileSearchPanel'"))
check('AiModelPane is reusable by sidebar',settings.includes('export function AiModelPane'))
check('RAG settings removed from global Settings navigation',!settings.includes("section === 'rag'")&&!settings.includes("id: 'rag'"))
check('analytics settings removed from global Settings navigation',!settings.includes("section === 'analytics'")&&!settings.includes("id: 'analytics'"))
const files=[
 'apps/shell/src/renderer/src/explorer/ExplorerHome.tsx',
 'apps/shell/src/renderer/src/explorer/model.ts',
 'apps/shell/src/renderer/src/WorkspaceChat.tsx',
 'apps/shell/src/renderer/src/SettingsModal.tsx',
 'apps/shell/src/renderer/src/explorer/WorkspaceControlPanel.tsx',
 'apps/shell/src/renderer/src/explorer/RagAnalyticsPanel.tsx',
 'apps/shell/src/renderer/src/explorer/workspace-tabs-model.ts',
]
for(const relative of files){const source=await read(relative),result=ts.transpileModule(source,{fileName:relative,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}),errors=(result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);if(errors.length)throw new Error(`${relative}: ${ts.formatDiagnostics(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>root,getNewLine:()=>os.EOL})}`)}
console.log(`Workspace tabs checks passed (${checks.length} structural checks + ${files.length} TypeScript syntax checks).`)
