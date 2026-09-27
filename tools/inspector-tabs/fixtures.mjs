/** Representative source shapes from the inspected Explorer and both delivered update layouts. */
export const assistantExpression = `(folder && currentRootPath) || selectedItems.length > 0 ? <WorkspaceChat folder={folder} folderName={folder ? basename(folder) : 'Selected items'} scopePaths={selectedItems.filter(item => item.kind === 'file').map(item => item.path)} scopeDirs={selectedItems.filter(item => item.kind === 'folder').map(item => item.path)} onOpenFile={openFile} onClose={() => changePrefs({ pane: 'none' })} /> : <div className="ex-pane-empty"><h2>{t('chooseFolder')}</h2><button onClick={() => { void addRoot() }}>{t('add')}</button></div>`
export function explorerFixture(hotfix=false){
 return `// LOCAL EDIT MUST SURVIVE
import { RagToolbar } from '../rag/RagToolbar'
import { AnalyticsToolbar } from '../analytics/AnalyticsToolbar'
${hotfix?"import { IndexingShortcuts } from '../indexing/IndexingShortcuts'":''}
export function ExplorerHome() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  ${hotfix?"const openIndexingSettings = (section: 'rag' | 'analytics') => { setSettingsOpen(true) }":''}
  const viewActions = (): MenuAction[] => [
    { label: t('assistant'), checked: prefs.pane === 'ai', action: () => changePrefs({ pane: 'ai' }) },
    { label: t('details'), checked: prefs.pane === 'details', action: () => changePrefs({ pane: 'details' }) },
    { label: t('resetLayout'), divider: true, action: () => setPrefs({ ...DEFAULT_PREFERENCES }) },
  ]
  return <div className="explorer">
    <div className="ex-command-bar">File commands</div>
    {inspectorVisible && <div className="unrelated-visibility-one" />}
    {inspectorVisible && <span className="unrelated-visibility-two" />}
    ${hotfix?'<IndexingShortcuts folder={folder} editorActive={editorActive} onSettings={openIndexingSettings} onAddFolder={() => { void addRoot() }} onBack={() => navigate({kind:"home"})} />':''}
    <div className="ex-body">
      <main className="ex-center">
        {editorActive ? <div>Native editor</div> : <>
          ${hotfix?'<div className="nawa-indexing-panels">':''}
          <RagToolbar folder={folder}${hotfix?" onSettings={() => openIndexingSettings('rag')} onAddFolder={() => { void addRoot() }}":''} />
          <AnalyticsToolbar folder={folder}${hotfix?" onSettings={() => openIndexingSettings('analytics')} onAddFolder={() => { void addRoot() }}":''} />
          ${hotfix?'</div>':''}
          <FileList items={items} />
        </>}
      </main>
      {inspectorVisible && <><Splitter label={prefs.pane === 'ai' ? t('assistant') : t('details')} value={effectiveInspectorWidth} min={300} max={Math.min(560, Math.max(300, windowWidth - (navigationVisible ? prefs.navigationWidth : 0) - 380))} reverse onChange={inspectorWidth => changePrefs({ inspectorWidth })} /><aside className="ex-inspector" aria-label={prefs.pane === 'ai' ? t('assistant') : t('details')}><div className="ex-inspector-tabs" role="tablist" aria-label="Inspector"><button role="tab" aria-selected={prefs.pane === 'ai'} onClick={() => changePrefs({ pane: 'ai' })}>{t('assistant')}</button><button role="tab" aria-selected={prefs.pane === 'details'} onClick={() => changePrefs({ pane: 'details' })}>{t('details')}</button><ToolButton icon="close" label={t('close')} onClick={() => changePrefs({ pane: 'none' })} /></div>
        {prefs.pane === 'details' ? detailsPane() : ${assistantExpression}}
      </aside></>}
    </div>
    {settingsOpen && <ExplorerSettings onClose={() => setSettingsOpen(false)} />}
  </div>
}`
}
export function toolbarFixture(name,hotfix=false){
 const rag=name==='RagToolbar'
 return `import {useState} from 'react'
export function ${name}({folder${hotfix?', onSettings, onAddFolder':''}}:{folder:string|null${hotfix?';onSettings?:()=>void;onAddFolder?:()=>void':''}}){
  const [open,setOpen]=useState(false)
  const [consent,setConsent]=useState(false)
  if(!folder)return null
  return <section className="${rag?'nawa-rag-toolbar':'nawa-data-toolbar'}">
    <details${rag?'':' open={open} onToggle={event=>setOpen(event.currentTarget.open)}'}><summary>${name}</summary>
      <input type="checkbox" checked={consent} onChange={event=>setConsent(event.currentTarget.checked)}/>
      <button disabled={!consent}>${rag?'Index / refresh directory':'Import / refresh table data'}</button>
    </details>
  </section>
}`
}
export const modelFixture=`export interface Preferences {
  pane: 'ai' | 'details' | 'none'
  inspectorWidth: number
}
export const DEFAULT_PREFERENCES:Preferences={pane:'ai',inspectorWidth:360}
export const PREFERENCES_KEY='nawa.explorer.preferences.v1'
export function parsePreferences(raw:string|null):Preferences{
  try {const p=JSON.parse(raw||'{}') as Partial<Preferences>|null,d=DEFAULT_PREFERENCES
  if(!p||typeof p!=='object')return {...d}
  return {pane: p.pane === 'ai' || p.pane === 'details' || p.pane === 'none' ? p.pane : d.pane,inspectorWidth:p.inspectorWidth||d.inspectorWidth}
  }catch{return {...DEFAULT_PREFERENCES}}
}`
export function sourcesFixture(hotfix=false){return new Map([
 ['apps/shell/src/renderer/src/explorer/ExplorerHome.tsx',explorerFixture(hotfix)],
 ['apps/shell/src/renderer/src/explorer/model.ts',modelFixture],
 ['apps/shell/src/renderer/src/rag/RagToolbar.tsx',toolbarFixture('RagToolbar',hotfix)],
 ['apps/shell/src/renderer/src/analytics/AnalyticsToolbar.tsx',toolbarFixture('AnalyticsToolbar',hotfix)],
])}
