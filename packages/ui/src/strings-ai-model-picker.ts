import type { Lang } from '@genoffice/i18n'

export interface AiModelPickerStrings {
  /** chip tooltip / list heading */
  title: string
  /** chip text while no provider is usable yet */
  choose: string
  /** last row: jump to Settings › AI Model */
  manage: string
}

export const AI_MODEL_PICKER_STRINGS: Record<Lang, AiModelPickerStrings> = {
  en: { title: 'Model', choose: 'Choose model', manage: 'Manage models…' },
  ja: { title: 'モデル', choose: 'モデルを選択', manage: 'モデルを管理…' },
  ar: { title: 'النموذج', choose: 'اختيار النموذج', manage: 'إدارة النماذج…' },
}
