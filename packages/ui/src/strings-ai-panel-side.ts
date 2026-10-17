import type { Lang } from '@genoffice/i18n'
import type { AiPanelSide } from './ai-panel-prefs'

// Shared by every editor's AI header; each label names the destination side.
export const AI_PANEL_SIDE_LABELS: Record<Lang, Record<AiPanelSide, string>> = {
  en: { left: 'Move AI panel to the left', right: 'Move AI panel to the right' },
  ja: { left: 'AI パネルを左側に移動', right: 'AI パネルを右側に移動' },
  ar: {
    left: 'نقل لوحة الذكاء الاصطناعي إلى اليسار',
    right: 'نقل لوحة الذكاء الاصطناعي إلى اليمين',
  },
}
