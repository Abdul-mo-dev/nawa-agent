import type { Lang } from '@genoffice/i18n'
import type { AiPanelWidth } from './use-ai-panel-width'

const labels: Record<Lang, string> = {
  en: 'Resize Nawa chat',
  ja: 'Nawa チャットの幅を変更',
  ar: 'تغيير عرض محادثة Nawa',
}

/** Shared physical-side pointer and keyboard resizing, with an announced width. */
export function AiPanelResizer({ panel, lang }: { panel: AiPanelWidth; lang: Lang }) {
  return (
    <div
      className="ai-panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={labels[lang]}
      aria-controls={panel.panelId}
      {...panel.resizerProps}
      onPointerDown={panel.startResize}
    />
  )
}
