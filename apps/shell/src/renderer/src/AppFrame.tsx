import { useEffect, useState } from 'react'
import type { TabSummary } from '../../shared/tabs-api'
import { DEFAULT_EXPLORER_LAYOUT } from '../../shared/explorer-layout'
import { Home } from './Home'
import { Onboarding } from './Onboarding'
import { TabBar } from './TabBar'
import { ExplorerHome } from './explorer/ExplorerHome'

interface AppFrameProps { initialOnboardingSeen: boolean }

export function AppFrame({ initialOnboardingSeen }: AppFrameProps) {
  const [active, setActive] = useState<TabSummary | undefined>()
  const [legacy, setLegacy] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(!initialOnboardingSeen)
  const homeActive = !active || active.kind === 'home'
  useEffect(() => {
    let alive = true
    const apply = (tabs: TabSummary[]) => { if (alive) setActive(tabs.find(tab => tab.active)) }
    void window.aiOfficeTabs.list().then(apply).catch(console.error)
    const off = window.aiOfficeTabs.onChanged(apply)
    return () => { alive = false; off() }
  }, [])
  useEffect(() => {
    // The original home still exists as a fallback, including its cloud/project features.
    if (legacy) window.nawaExplorer?.setLayout(DEFAULT_EXPLORER_LAYOUT)
  }, [legacy])
  const finishOnboarding = async (): Promise<boolean> => {
    try {
      if (!(await window.aiOffice.setOnboardingSeen())) return false
      setShowOnboarding(false)
      return true
    } catch { return false }
  }
  return <div className="app-frame">
    <TabBar />
    <div className="app-frame-content ex-frame-content">
      {legacy ? <div style={{ height: '100%', visibility: homeActive ? 'visible' : 'hidden' }}>
        <Home />
        <button type="button" className="ex-legacy-back" onClick={() => setLegacy(false)}>Return to Explorer</button>
      </div> : <ExplorerHome editorTab={homeActive ? undefined : active} onOpenLegacy={() => {
        void window.aiOfficeTabs.activate('home').then(() => setLegacy(true)).catch(console.error)
      }} />}
    </div>
    {showOnboarding && homeActive && <Onboarding onDone={finishOnboarding} />}
  </div>
}
