import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { LocaleProvider, useI18n } from '../../apps/shell/src/renderer/src/locale'
import { MyAgentSettings } from '../../apps/shell/src/renderer/src/myagent/MyAgentSettings'
import { snapshot as initial } from '../../apps/shell/tests/fixtures/myagent-settings'
import { DEFAULT_RAG_SETTINGS } from '../../apps/shell/src/shared/rag-api'
import type { RagProgress } from '../../apps/shell/src/shared/rag-api'
import { SelectedFileRefresh } from '../../apps/shell/src/renderer/src/rag/SelectedFileRefresh'
import '@genoffice/ui/tokens.css'
import '../../apps/shell/src/renderer/src/home.css'
import '../../apps/shell/src/renderer/src/settings.css'
import '../../apps/shell/src/renderer/src/rag/rag.css'
const clone = <T,>(value: T): T => structuredClone(value)
let snapshot = clone(initial), launch = { mode: 'process', serverPath: 'C:\\Server\\MyAgent.Server.exe', configurationDirectory: 'C:\\MyAgent\\server' }
let settings = { ...DEFAULT_RAG_SETTINGS, enabled: true }, hasKey = true
const folder = 'C:\\Documents', selected = [folder + '\\Survey data.xlsx', folder + '\\report.pdf']
const state = { saves: [] as unknown[], controls: [] as string[], models: [] as string[], refreshes: [] as { paths: string[] }[], checks: [] as unknown[], readinessChecks: 0, failSave: false, offline: false }
Object.assign(window, {
  aiOffice: { setLanguage: async () => {} },
  myAgentFixture: state,
  nawaRag: {
    settings: async () => ({ settings: clone(settings), hasKey, databasePath: 'fixture/mappings.json' }),
    save: async (next: typeof settings, key?: string) => { settings = clone(next); if (key !== undefined) hasKey = !!key; return { settings: clone(settings), hasKey, databasePath: 'fixture/mappings.json' } },
    test: async () => ({ dimensions: 0, message: 'Connected to fixture MyAgent.' }),
    statuses: async (paths: string[], verify: boolean) => { state.checks.push({ paths, verify }); return paths.map(path => ({ path, status: 'not-indexed', chunks: 0 })) },
    indexSelected: async (_folder: string, paths: string[]) => {
      state.refreshes.push({ paths: clone(paths) })
      const failed = state.refreshes.length === 1 ? paths.filter(path => path.endsWith('.pdf')) : []
      return { scope: 'selected', folder, running: false, scanned: paths.length, embedded: paths.length - failed.length, unchanged: 0, chunks: 1, failed: failed.length, current: '', message: 'Selected files refreshed', incomplete: false,
        files: paths.map(path => ({ path, status: failed.includes(path) ? 'failed' : 'embedded', ...(failed.includes(path) ? { error: 'OCR executable is unavailable. Configure its path and retry.' } : {}) })) }
    },
  },
  nawaMyAgent: {
    inspect: async () => { if (state.offline) throw new Error('MyAgent is offline'); return clone(snapshot) },
    diagnostics: async () => { state.readinessChecks++; return { serverUrl: snapshot.serverUrl, checkedAt: '2026-09-28T10:00:00Z', health: { ...snapshot.health, components: [{ name: 'rag-office-pdf-conversion', status: 'unavailable', enabled: true, available: false, detail: 'LibreOffice is not installed.' }] }, readiness: { ready: true, status: 'Managed provider starts automatically.', providerAvailable: false, startsOnDemand: true, model: 'local-chat' }, warnings: [] } },
    local: async () => ({ settings: clone(launch), serviceState: 'not-installed', processId: null }),
    generateKey: async () => 'new-fixture-service-key',
    saveConfiguration: async (_url: string, _revision: string, patch: any) => {
      if (state.failSave) throw new Error('Server settings changed elsewhere. Refresh before saving.')
      state.saves.push(clone(patch))
      snapshot.configuration = { ...snapshot.configuration!, provider: { ...snapshot.configuration!.provider, ...patch.provider }, rag: { ...snapshot.configuration!.rag, ...patch.rag } }
      return { snapshot: clone(snapshot), restartRequired: true, restartRequiredSettings: ['MyAgent.Rag.Roots'], applied: false }
    },
    saveLaunch: async (next: typeof launch) => { launch = clone(next); return { settings: clone(launch), serviceState: 'not-installed', processId: null } },
    choosePath: async (kind: string) => kind === 'server' ? 'C:\\Server\\MyAgent.Server.exe' : 'C:\\New documents',
    control: async (action: string) => { state.controls.push(action); return { message: `MyAgent ${action}.` } },
    model: async (action: string, profileId: string) => { state.models.push(`${profileId}:${action}`); return { profileId, state: 'Running', displayName: profileId } },
  },
})
function Fixture() {
  const { setLang } = useI18n()
  const [files, setFiles] = useState(selected), [progress, setProgress] = useState<RagProgress | null>(null)
  return <main style={{ maxWidth: 780, margin: '0 auto', padding: 16, boxSizing: 'border-box' }}>
    <button onClick={() => { setLang('ar'); document.documentElement.dataset.theme = 'dark' }}>Arabic dark</button>
    <MyAgentSettings/>
    <button onClick={() => setFiles([selected[1]])}>Select only report</button>
    <SelectedFileRefresh folder={folder} selectedFiles={files} configured progress={progress} onProgress={setProgress}/>
  </main>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider initial="en"><Fixture/></LocaleProvider>)
