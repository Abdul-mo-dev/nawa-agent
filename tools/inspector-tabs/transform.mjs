/** Guarded structural transforms; target actual JSX nodes, never an entire user file replacement. */
export const SOURCE_PATHS = [
  'apps/shell/src/renderer/src/explorer/ExplorerHome.tsx',
  'apps/shell/src/renderer/src/explorer/model.ts',
  'apps/shell/src/renderer/src/rag/RagToolbar.tsx',
  'apps/shell/src/renderer/src/analytics/AnalyticsToolbar.tsx',
]
const assert=(ok,message)=>{if(!ok)throw new Error(message)}
const tag=node=>node?.getText?.()
function tree(ts,name,text){const sf=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert(!sf.parseDiagnostics.length,`${name}: source does not parse; no changes applied.`);return sf}
function find(ts,sf,test){const found=[];const visit=node=>{if(test(node))found.push(node);ts.forEachChild(node,visit)};visit(sf);return found}
function one(values,label){assert(values.length===1,`${label}: expected one source node, found ${values.length}. Reconcile source changes rather than forcing the update.`);return values[0]}
function editAll(source,edits){let result=source,last=source.length+1;for(const e of [...edits].sort((a,b)=>b.start-a.start)){assert(e.end<=last,'Overlapping source edits; refused.');result=result.slice(0,e.start)+e.text+result.slice(e.end);last=e.start}return result}
function attr(ts,node,name){return node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.text===name)}
function classIs(ts,node,name){const a=attr(ts,node,'className');return a?.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text.split(/\s+/).includes(name)}
function opening(ts,node){return ts.isJsxElement(node)?node.openingElement:ts.isJsxSelfClosingElement(node)?node:null}
function element(ts,sf,name){return find(ts,sf,n=>(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&tag(opening(ts,n).tagName)===name)}
function replaceOnce(s,a,b,label){assert(s.split(a).length===2,`${label}: expected edit anchor missing or duplicated.`);return s.replace(a,b)}

export function transformExplorer(ts,source){
  const sf=tree(ts,'ExplorerHome.tsx',source)
  if(element(ts,sf,'WorkspaceInspector').length){validateExplorer(ts,source);return source}
  const controls=['RagToolbar','AnalyticsToolbar'].map(name=>one(element(ts,sf,name),name))
  assert(controls.every(n=>ts.isJsxSelfClosingElement(n)),'Unexpected non-self-closing directory toolbar.')
  const originalControl=controls.map(node=>{
    assert(!attr(ts,node,'inSidebar'),'Unexpected partial sidebar integration.')
    const key=attr(ts,node,'key')?'':' key={folder ?? "no-directory"}'
    return node.getText(sf).replace(/\s*\/>$/,`${key} inSidebar />`)
  })
  const inspectorCandidates=find(ts,sf,n=>{
    if(!ts.isJsxExpression(n)||!n.expression||!ts.isBinaryExpression(n.expression)||n.expression.operatorToken.kind!==ts.SyntaxKind.AmpersandAmpersandToken||n.expression.left.getText(sf)!=='inspectorVisible')return false
    const right=n.expression.right
    if(!ts.isJsxFragment(right))return false
    const hasSplitter=find(ts,right,x=>ts.isJsxSelfClosingElement(x)&&tag(x.tagName)==='Splitter').length===1
    const hasInspector=find(ts,right,x=>ts.isJsxElement(x)&&classIs(ts,x.openingElement,'ex-inspector')).length===1
    return hasSplitter&&hasInspector
  })
  const inspector=one(inspectorCandidates,'Inspector visibility expression')
  const splitter=one(find(ts,inspector,n=>ts.isJsxSelfClosingElement(n)&&tag(n.tagName)==='Splitter'),'Inspector splitter')
  const label=attr(ts,splitter,'label');assert(label?.initializer,'Inspector splitter label missing.')
  let splitText=splitter.getText(sf)
  const from=label.initializer.getStart(sf)-splitter.getStart(sf),to=label.initializer.end-splitter.getStart(sf)
  splitText=splitText.slice(0,from)+"{prefs.pane === 'rag' ? 'Directory RAG' : prefs.pane === 'analytics' ? 'Structured Data Analysis' : prefs.pane === 'ai' ? t('assistant') : t('details')}"+splitText.slice(to)
  const conditional=one(find(ts,inspector,n=>ts.isConditionalExpression(n)&&n.whenTrue.getText(sf)==='detailsPane()'),'Existing Details/assistant content')
  const aside=one(find(ts,inspector,n=>ts.isJsxElement(n)&&classIs(ts,n.openingElement,'ex-inspector')),'Existing inspector aside')
  const meaningful=nodes=>nodes.filter(n=>!ts.isJsxText(n)||n.text.trim())
  const asideChildren=meaningful(aside.children)
  assert(asideChildren.length===2&&asideChildren.some(n=>ts.isJsxExpression(n)&&n.expression===conditional),'Inspector contains additional content; refused to discard unrelated UI.')
  const tabbar=one(asideChildren.filter(n=>ts.isJsxElement(n)&&classIs(ts,n.openingElement,'ex-inspector-tabs')),'Existing tab bar')
  const oldTabs=meaningful(tabbar.children)
  assert(oldTabs.length===3&&oldTabs.filter(n=>tag(opening(ts,n)?.tagName)==='button').length===2&&oldTabs.filter(n=>tag(opening(ts,n)?.tagName)==='ToolButton').length===1,'The original inspector tab set changed; reconcile it before applying.')
  const fragment=inspector.expression.right
  assert(ts.isJsxFragment(fragment)&&meaningful(fragment.children).length===2,'Additional inspector content would be removed; refused.')
  const assistant=conditional.whenFalse.getText(sf)
  assert(element(ts,conditional.whenFalse,'WorkspaceChat').length===1,'Expected the existing WorkspaceChat instance; refused to reconstruct it.')
  const replacement=`{inspectorVisible && <>${splitText}
        <WorkspaceInspector active={prefs.pane === 'none' ? 'ai' : prefs.pane}
          assistantLabel={t('assistant')} detailsLabel={t('details')} closeLabel={t('close')}
          folder={folder && currentRootPath ? folder : null}
          onChange={pane => changePrefs({ pane })} onClose={() => changePrefs({ pane: 'none' })}
          onAddFolder={() => { void addRoot() }}
          assistant={${assistant}}
          details={detailsPane()}
          rag={${originalControl[0]}}
          analytics={${originalControl[1]}}
        />
      </>}`
  const edits=[{start:inspector.getStart(sf),end:inspector.end,text:replacement}]
  const wrappers=find(ts,sf,n=>ts.isJsxElement(n)&&classIs(ts,n.openingElement,'nawa-indexing-panels'))
  assert(wrappers.length<=1,'Multiple indexing wrappers found.')
  if(wrappers.length){
    const wrapper=wrappers[0]
    assert(controls.every(n=>n.getStart(sf)>wrapper.getStart(sf)&&n.end<wrapper.end),'Indexing wrapper contains unexpected controls.')
    const content=wrapper.children.filter(n=>!ts.isJsxText(n)||n.text.trim())
    assert(content.length===2&&content.every(n=>controls.includes(n)),'Indexing wrapper contains unrelated content; refused to remove it.')
    edits.push({start:wrapper.getStart(sf),end:wrapper.end,text:''})
  }else for(const control of controls)edits.push({start:control.getStart(sf),end:control.end,text:''})
  const shortcuts=element(ts,sf,'IndexingShortcuts')
  assert(shortcuts.length<=1,'Multiple global indexing shortcut rows found.')
  for(const shortcut of shortcuts)edits.push({start:shortcut.getStart(sf),end:shortcut.end,text:''})
  for(const node of sf.statements){if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)){
    const imports=node.importClause.namedBindings.elements
    if(imports.length===1&&imports[0].name.text==='IndexingShortcuts')edits.push({start:node.getStart(sf),end:node.end,text:''})
  }}
  let result=editAll(source,edits)
  result="import { WorkspaceInspector } from './WorkspaceInspector'\n"+result
  const reset="    { label: t('resetLayout'), divider: true, action: () => setPrefs({ ...DEFAULT_PREFERENCES }) },"
  result=replaceOnce(result,reset,`    { label: 'Directory RAG', icon: 'search', checked: prefs.pane === 'rag', disabled: editorActive || windowWidth < 900, action: () => changePrefs({ pane: 'rag' }) },
    { label: 'Structured Data Analysis', icon: 'list', checked: prefs.pane === 'analytics', disabled: editorActive || windowWidth < 900, action: () => changePrefs({ pane: 'analytics' }) },
`+reset,'View menu')
  validateExplorer(ts,result)
  return result
}
export function validateExplorer(ts,source){
  const sf=tree(ts,'ExplorerHome.tsx',source),panel=one(element(ts,sf,'WorkspaceInspector'),'WorkspaceInspector')
  assert(element(ts,sf,'RagToolbar').length===1&&element(ts,sf,'AnalyticsToolbar').length===1,'A directory control was lost or duplicated.')
  assert(element(ts,sf,'IndexingShortcuts').length===0,'Old global shortcuts are still rendered.')
  for(const name of ['RagToolbar','AnalyticsToolbar']){
    const node=element(ts,sf,name)[0]
    assert(node.getStart(sf)>panel.getStart(sf)&&node.end<panel.end,`${name} is still outside the sidebar.`)
    assert(!!attr(ts,opening(ts,node),'inSidebar'),`${name} is missing sidebar mode.`)
  }
  const chat=one(element(ts,sf,'WorkspaceChat'),'WorkspaceChat')
  assert(chat.getStart(sf)>panel.getStart(sf)&&chat.end<panel.end,'Chat moved outside the preserved tab host.')
  for(const name of ['assistant','details','rag','analytics'])assert(!!attr(ts,opening(ts,panel),name),`Missing ${name} panel`)
}
export function transformPreferences(ts,source){
  tree(ts,'model.ts',source)
  if(source.includes("pane: 'ai' | 'details' | 'rag' | 'analytics' | 'none'")){
    assert(source.includes("p.pane === 'rag'")&&source.includes("p.pane === 'analytics'"),'Partially changed panel preference validation.');return source
  }
  let next=replaceOnce(source,"pane: 'ai' | 'details' | 'none'","pane: 'ai' | 'details' | 'rag' | 'analytics' | 'none'",'Panel preference type')
  next=replaceOnce(next,"p.pane === 'ai' || p.pane === 'details' || p.pane === 'none'","p.pane === 'ai' || p.pane === 'details' || p.pane === 'rag' || p.pane === 'analytics' || p.pane === 'none'",'Panel preference parsing')
  tree(ts,'model.ts',next);return next
}
export function transformToolbar(ts,source,name){
  const sf=tree(ts,name+'.tsx',source),fn=one(find(ts,sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name),name+' function')
  const param=fn.parameters[0]
  assert(param&&ts.isObjectBindingPattern(param.name)&&param.type&&ts.isTypeLiteralNode(param.type),name+': unexpected props shape.')
  const details=one(find(ts,fn,n=>ts.isJsxElement(n)&&tag(n.openingElement.tagName)==='details'),name+' outer disclosure')
  const open=attr(ts,details.openingElement,'open')
  if(param.name.elements.some(e=>e.name.getText(sf)==='inSidebar')){
    assert(open?.initializer?.getText(sf).includes('inSidebar'),name+': partial sidebar-mode change.');return source
  }
  assert(!param.name.elements.some(e=>e.dotDotDotToken),name+': rest props require manual reconciliation.')
  const edits=[]
  const binding=param.name.getText(sf)
  const tail=binding.slice(0,-1).trimEnd().endsWith(',')?' inSidebar = false ':', inSidebar = false '
  edits.push({start:param.name.end-1,end:param.name.end-1,text:tail})
  const typeText=param.type.getText(sf).slice(0,-1).trimEnd()
  edits.push({start:param.type.end-1,end:param.type.end-1,text:(/[;,]$/.test(typeText)?' ': '; ')+'inSidebar?: boolean '})
  if(open){assert(open.initializer&&ts.isJsxExpression(open.initializer)&&open.initializer.expression,name+': unexpected disclosure state.');edits.push({start:open.initializer.getStart(sf),end:open.initializer.end,text:`{inSidebar || (${open.initializer.expression.getText(sf)})}`})}
  else edits.push({start:details.openingElement.end-1,end:details.openingElement.end-1,text:' open={inSidebar || undefined}'})
  const next=editAll(source,edits);tree(ts,name+'.tsx',next);return next
}
export function transformSources(ts,sources){
  const results=new Map()
  for(const path of SOURCE_PATHS){const input=sources.get(path);assert(typeof input==='string',`Required source is missing: ${path}`)
    const bom=input.startsWith('\uFEFF')?'\uFEFF':'',crlf=input.includes('\r\n'),text=(bom?input.slice(1):input).replace(/\r\n/g,'\n')
    const output=path.endsWith('ExplorerHome.tsx')?transformExplorer(ts,text):path.endsWith('/model.ts')?transformPreferences(ts,text):transformToolbar(ts,text,path.endsWith('RagToolbar.tsx')?'RagToolbar':'AnalyticsToolbar')
    results.set(path,bom+(crlf?output.replace(/\n/g,'\r\n'):output))
  }return results
}
