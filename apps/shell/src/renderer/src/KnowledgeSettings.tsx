import { RagSettings } from './rag/RagSettings'
import { AnalyticsSettings } from './analytics/AnalyticsSettings'
import { useSidebarText } from './explorer/sidebar-i18n'

/** Global configuration; selection, preparation and file status stay in the workspace. */
export function KnowledgeSettings({ suspended = false }: { suspended?: boolean }) {
  const { s } = useSidebarText()
  return <div className="nawa-knowledge-settings">
    <h3 className="set-pane-title">{s('Knowledge')}</h3>
    <RagSettings compact suspended={suspended} />
    <AnalyticsSettings compact />
  </div>
}
