/** Guarded transforms for the consolidated Nawa sidebar controls. */
export const SOURCE_PATHS = [
  'apps/shell/src/renderer/src/explorer/ExplorerHome.tsx',
  'apps/shell/src/renderer/src/explorer/model.ts',
  'apps/shell/src/renderer/src/WorkspaceChat.tsx',
  'apps/shell/src/renderer/src/SettingsModal.tsx',
]
const assert=(ok,message)=>{if(!ok)throw new Error(message)}
const tag=node=>node?.getText?.()
function tree(ts,name,text){const sf=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert(!sf.parseDiagnostics.length,`${name}: source does not parse; no changes applied.`);return sf}
function find(ts,sf,test){const found=[];const visit=node=>{if(test(node))found.push(node);ts.forEachChild(node,visit)};visit(sf);return found}
function one(values,label){assert(values.length===1,`${label}: expected one source node, found ${values.length}. Reconcile source changes rather than forcing the update.`);return values[0]}
function editAll(source,edits){let result=source,last=source.length+1;for(const e of [...edits].sort((a,b)=>b.start-a.start)){assert(e.end<=last,'Overlapping source edits; refused.');result=result.slice(0,e.start)+e.text+result.slice(e.end);last=e.start}return result}
function attr(ts,node,name){return node.attributes?.properties?.find(p=>ts.isJsxAttribute(p)&&p.name.text===name)}
function classIs(ts,node,name){const a=attr(ts,node,'className');return a?.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text.split(/\s+/).includes(name)}
function opening(ts,node){return ts.isJsxElement(node)?node.openingElement:ts.isJsxSelfClosingElement(node)?node:null}
function element(ts,sf,name){return find(ts,sf,n=>(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&tag(opening(ts,n).tagName)===name)}
function literalAttr(ts,node,name,value){const a=attr(ts,node,name);return !!a?.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text===value}
function meaningful(nodes){return nodes.filter(n=>!n.kind||!('text' in n)||String(n.text).trim())}
function removeLine(source,pattern){return source.replace(pattern,'')}

function inspectorExpression(ts,sf){
  return one(find(ts,sf,n=>{
    if(!ts.isJsxExpression(n)||!n.expression||!ts.isBinaryExpression(n.expression)||n.expression.operatorToken.kind!==ts.SyntaxKind.AmpersandAmpersandToken||n.expression.left.getText(sf)!=='inspectorVisible')return false
    const right=n.expression.right
    if(!ts.isJsxFragment(right))return false
    const hasSplitter=find(ts,right,x=>ts.isJsxSelfClosingElement(x)&&tag(x.tagName)==='Splitter').length===1
    const hasHost=find(ts,right,x=>(ts.isJsxElement(x)||ts.isJsxSelfClosingElement(x))&&(classIs(ts,opening(ts,x),'ex-inspector')||tag(opening(ts,x).tagName)==='WorkspaceInspector'||tag(opening(ts,x).tagName)==='WorkspaceControlPanel')).length===1
    return hasSplitter&&hasHost
  }),'Inspector visibility expression')
}
function assistantExpression(ts,sf,inspector){
  const existing=find(ts,inspector,n=>(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&tag(opening(ts,n).tagName)==='WorkspaceControlPanel')
  if(existing.length){const a=attr(ts,opening(ts,existing[0]),'assistant');assert(a?.initializer&&ts.isJsxExpression(a.initializer)&&a.initializer.expression,'WorkspaceControlPanel assistant prop missing.');return a.initializer.expression.getText(sf)}
  const older=find(ts,inspector,n=>(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&tag(opening(ts,n).tagName)==='WorkspaceInspector')
  if(older.length){const a=attr(ts,opening(ts,older[0]),'assistant');assert(a?.initializer&&ts.isJsxExpression(a.initializer)&&a.initializer.expression,'WorkspaceInspector assistant prop missing.');return a.initializer.expression.getText(sf)}
  const candidates=find(ts,inspector,n=>ts.isConditionalExpression(n)&&element(ts,n.whenFalse,'WorkspaceChat').length===1)
  return one(candidates,'Existing Details/assistant content').whenFalse.getText(sf)
}

export function transformExplorer(ts,source){
  let sf=tree(ts,'ExplorerHome.tsx',source)
  if(element(ts,sf,'WorkspaceControlPanel').length){validateExplorer(ts,source);return source}
  const inspector=inspectorExpression(ts,sf)
  const assistant=assistantExpression(ts,sf,inspector)
  const splitter=one(find(ts,inspector,n=>ts.isJsxSelfClosingElement(n)&&tag(n.tagName)==='Splitter'),'Inspector splitter')
  const label=attr(ts,splitter,'label');assert(label?.initializer,'Inspector splitter label missing.')
  let splitText=splitter.getText(sf)
  const from=label.initializer.getStart(sf)-splitter.getStart(sf),to=label.initializer.end-splitter.getStart(sf)
  splitText=splitText.slice(0,from)+"{prefs.pane === 'ragAnalytics' ? 'RAG & Analytics' : prefs.pane === 'provider' ? 'AI Provider' : t('assistant')}"+splitText.slice(to)
  const replacement=`{inspectorVisible && <>${splitText}\n        <WorkspaceControlPanel active={prefs.pane === 'none' ? 'ai' : prefs.pane}\n          assistantLabel={t('assistant')} closeLabel={t('close')}\n          folder={folder && currentRootPath ? folder : null}\n          onChange={pane => changePrefs({ pane })} onClose={() => changePrefs({ pane: 'none' })}\n          onAddFolder={() => { void addRoot() }}\n          assistant={${assistant}}\n        />\n      </>}`
  const edits=[{start:inspector.getStart(sf),end:inspector.end,text:replacement}]
  // Remove the old main-file-area indexing controls when they are not already inside an older inspector host.
  for(const name of ['RagToolbar','AnalyticsToolbar']){
    for(const node of element(ts,sf,name)) if(!(node.getStart(sf)>inspector.getStart(sf)&&node.end<inspector.end)) edits.push({start:node.getStart(sf),end:node.end,text:''})
  }
  for(const node of element(ts,sf,'IndexingShortcuts'))edits.push({start:node.getStart(sf),end:node.end,text:''})
  // Remove the inspector Details button from the command bar. File-list "details" view remains untouched.
  const infoButtons=element(ts,sf,'ToolButton').filter(n=>literalAttr(ts,opening(ts,n),'icon','info'))
  assert(infoButtons.length<=1,'Multiple Details inspector buttons found.')
  for(const node of infoButtons)edits.push({start:node.getStart(sf),end:node.end,text:''})
  let result=editAll(source,edits)
  if(!result.includes("from './WorkspaceControlPanel'"))result="import { WorkspaceControlPanel } from './WorkspaceControlPanel'\n"+result
  // Remove obsolete workspace-panel imports if a prior tabs bundle had been installed.
  result=removeLine(result,/^import \{ WorkspaceInspector \} from '\.\/WorkspaceInspector'\r?\n/m)
  result=removeLine(result,/^import \{ IndexingShortcuts \} from ['"][^'"]+['"]\r?\n/m)
  // View menu: remove old inspector destinations and add the two current destinations after Assistant.
  result=removeLine(result,/^\s*\{ label: t\('details'\), icon: 'info', checked: prefs\.pane === 'details'.*\},\r?\n/m)
  result=removeLine(result,/^\s*\{ label: 'Directory RAG'.*prefs\.pane === 'rag'.*\},\r?\n/m)
  result=removeLine(result,/^\s*\{ label: 'Structured Data Analysis'.*prefs\.pane === 'analytics'.*\},\r?\n/m)
  result=removeLine(result,/^\s*\{ label: 'RAG & Analytics'.*prefs\.pane === 'ragAnalytics'.*\},\r?\n/m)
  result=removeLine(result,/^\s*\{ label: 'AI Provider'.*prefs\.pane === 'provider'.*\},\r?\n/m)
  const assistantLine=/^(\s*\{ label: t\('assistant'\).*checked: prefs\.pane === 'ai'.*\},)\r?$/m
  const match=result.match(assistantLine);assert(match,'Assistant View-menu entry not found.')
  result=result.replace(assistantLine,`${match[1]}\n    { label: 'RAG & Analytics', icon: 'search', checked: prefs.pane === 'ragAnalytics', disabled: editorActive || windowWidth < 900, action: () => changePrefs({ pane: 'ragAnalytics' }) },\n    { label: 'AI Provider', icon: 'settings', checked: prefs.pane === 'provider', disabled: editorActive || windowWidth < 900, action: () => changePrefs({ pane: 'provider' }) },`)
  validateExplorer(ts,result)
  return result
}

export function validateExplorer(ts,source){
  const sf=tree(ts,'ExplorerHome.tsx',source),panel=one(element(ts,sf,'WorkspaceControlPanel'),'WorkspaceControlPanel')
  assert(element(ts,sf,'WorkspaceInspector').length===0,'Old four-tab inspector is still rendered.')
  assert(element(ts,sf,'RagToolbar').length===0&&element(ts,sf,'AnalyticsToolbar').length===0,'RAG/analytics controls are still rendered in the main file area.')
  assert(element(ts,sf,'IndexingShortcuts').length===0,'Old global indexing shortcuts are still rendered.')
  assert(element(ts,sf,'ToolButton').filter(n=>literalAttr(ts,opening(ts,n),'icon','info')).length===0,'Details inspector button still exists.')
  const chat=one(element(ts,sf,'WorkspaceChat'),'WorkspaceChat')
  assert(chat.getStart(sf)>panel.getStart(sf)&&chat.end<panel.end,'Chat moved outside the workspace panel host.')
  for(const name of ['assistant','folder','onAddFolder'])assert(!!attr(ts,opening(ts,panel),name),`Missing ${name} panel prop`)
  assert(source.includes("prefs.pane === 'ragAnalytics'")&&source.includes("prefs.pane === 'provider'"),'New inspector destinations are missing.')
}

export function transformPreferences(ts,source){
  const sf=tree(ts,'model.ts',source),edits=[]
  const interfaces=find(ts,sf,n=>ts.isInterfaceDeclaration(n)&&n.name.text==='Preferences')
  const prefs=one(interfaces,'Preferences interface')
  const pane=one(prefs.members.filter(m=>ts.isPropertySignature(m)&&m.name?.getText(sf)==='pane'),'Preferences.pane')
  assert(pane.type,'Preferences.pane has no type.')
  edits.push({start:pane.type.getStart(sf),end:pane.type.end,text:"'ai' | 'ragAnalytics' | 'provider' | 'none'"})
  const parseFns=find(ts,sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='parsePreferences')
  const fn=one(parseFns,'parsePreferences')
  const assignments=find(ts,fn,n=>ts.isPropertyAssignment(n)&&n.name.getText(sf)==='pane'&&n.initializer.getText(sf).includes('p.pane'))
  const pa=one(assignments,'parsePreferences pane assignment')
  edits.push({start:pa.initializer.getStart(sf),end:pa.initializer.end,text:"p.pane === 'none' ? 'none' : p.pane === 'ragAnalytics' || p.pane === 'provider' || p.pane === 'ai' ? p.pane : p.pane === 'rag' || p.pane === 'analytics' ? 'ragAnalytics' : 'ai'"})
  const result=editAll(source,edits);const out=tree(ts,'model.ts',result)
  assert(result.includes("'ai' | 'ragAnalytics' | 'provider' | 'none'"),'Panel preference type update failed.')
  return result
}

export function transformWorkspaceChat(ts,source){
  const sf=tree(ts,'WorkspaceChat.tsx',source),edits=[]
  for(const node of element(ts,sf,'FileSearchPanel'))edits.push({start:node.getStart(sf),end:node.end,text:''})
  for(const node of sf.statements){if(ts.isImportDeclaration(node)&&String(node.moduleSpecifier.text).endsWith('/FileSearchPanel'))edits.push({start:node.getStart(sf),end:node.end,text:''})}
  const result=editAll(source,edits);const out=tree(ts,'WorkspaceChat.tsx',result)
  assert(element(ts,out,'FileSearchPanel').length===0,'File indexing/search controls remain in Nawa assistant.')
  return result
}

export function transformSettings(ts,source){
  let result=source
  // Export the existing model settings pane for the AI Provider inspector tab.
  if(!/export\s+function\s+AiModelPane\b/.test(result)){
    assert(/function\s+AiModelPane\b/.test(result),'AiModelPane was not found in SettingsModal.')
    result=result.replace(/function\s+AiModelPane\b/,'export function AiModelPane')
  }
  // RAG and analytics settings now live in the combined inspector tab, not the global Settings nav.
  result=removeLine(result,/^import \{ RagSettings \} from '\.\/rag\/RagSettings'\r?\n/m)
  result=removeLine(result,/^import \{ AnalyticsSettings \} from '\.\/analytics\/AnalyticsSettings'\r?\n/m)
  result=removeLine(result,/^\s*\{ id: 'rag', labelKey: '[^']+' \},\r?\n/m)
  result=removeLine(result,/^\s*\{ id: 'analytics', labelKey: '[^']+' \},\r?\n/m)
  result=removeLine(result,/^\s*\{section === 'rag' && <RagSettings \/>\}\r?\n/m)
  result=removeLine(result,/^\s*\{section === 'analytics' && <AnalyticsSettings \/>\}\r?\n/m)
  // Without the earlier status hotfix these values can leave SectionId entirely.
  // If that hotfix added an initialSection prop, keep the literals as compatibility-only
  // values so its already-typed prop cannot break the build; they are still absent from
  // navigation and render no Settings page.
  if(!result.includes('initialSection')) result=result.replace(/type SectionId = ([^\n]+)/,(_m,union)=>`type SectionId = ${union.replace(/\s*\|\s*'rag'/g,'').replace(/\s*\|\s*'analytics'/g,'')}`)
  // Restore the normal translated section label now that special RAG/analytics entries are gone.
  result=result.replace(/\{s\.id === 'rag' \? 'Embeddings & RAG' : s\.id === 'analytics' \?\s*'Structured Data Analysis'\s*: t\(s\.labelKey\)\}/g,"{t(s.labelKey)}")
  result=result.replace(/\{s\.id === 'rag' \? 'Embeddings & RAG' : t\(s\.labelKey\)\}/g,"{t(s.labelKey)}")
  const sf=tree(ts,'SettingsModal.tsx',result)
  assert(find(ts,sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='AiModelPane'&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).length===1,'AiModelPane was not exported.')
  assert(!result.includes("section === 'rag'")&&!result.includes("section === 'analytics'"),'RAG/analytics global settings sections remain.')
  return result
}

export function transformSources(ts,sources){
  const results=new Map()
  for(const path of SOURCE_PATHS){const input=sources.get(path);assert(typeof input==='string',`Required source is missing: ${path}`)
    const bom=input.startsWith('\uFEFF')?'\uFEFF':'',crlf=input.includes('\r\n'),text=(bom?input.slice(1):input).replace(/\r\n/g,'\n')
    const output=path.endsWith('ExplorerHome.tsx')?transformExplorer(ts,text):path.endsWith('/model.ts')?transformPreferences(ts,text):path.endsWith('/WorkspaceChat.tsx')?transformWorkspaceChat(ts,text):transformSettings(ts,text)
    results.set(path,bom+(crlf?output.replace(/\n/g,'\r\n'):output))
  }return results
}
