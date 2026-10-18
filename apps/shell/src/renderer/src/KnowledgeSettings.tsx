import { AnalyticsSettings } from './analytics/AnalyticsSettings'
import { useSidebarText } from './explorer/sidebar-i18n'
import { useI18n } from './locale'
import { localModelStrings } from './i18n/strings-local-models'

/** Global configuration; selection, preparation and file status stay in the workspace. */
export function KnowledgeSettings({ onOpenModels }: { onOpenModels(): void }) {
  const { s } = useSidebarText()
  const { lang } = useI18n(),
    copy = localModelStrings[lang]
  return (
    <div className="nawa-knowledge-settings">
      <h3 className="set-pane-title">{s('Knowledge')}</h3>
      <p>{copy.modelSettingsHint}</p>
      <button type="button" className="set-btn" onClick={onOpenModels}>
        {copy.modelSettingsLink}
      </button>
      <AnalyticsSettings compact />
    </div>
  )
}
