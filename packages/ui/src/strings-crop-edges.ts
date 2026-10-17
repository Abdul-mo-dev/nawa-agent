import type { Lang } from '@genoffice/i18n'
import type { CropEdge } from './image-dialogs'

// Shared accessible names for the crop edge handles, so every edge is reachable
// by keyboard and still announced in the editor's own language.
export const CROP_EDGE_LABELS: Record<Lang, Record<CropEdge, string>> = {
  en: {
    nw: 'Top left edge',
    n: 'Top edge',
    ne: 'Top right edge',
    e: 'Right edge',
    se: 'Bottom right edge',
    s: 'Bottom edge',
    sw: 'Bottom left edge',
    w: 'Left edge',
  },
  ja: {
    nw: '左上の辺',
    n: '上辺',
    ne: '右上の辺',
    e: '右辺',
    se: '右下の辺',
    s: '下辺',
    sw: '左下の辺',
    w: '左辺',
  },
  ar: {
    nw: 'الحافة العلوية اليسرى',
    n: 'الحافة العلوية',
    ne: 'الحافة العلوية اليمنى',
    e: 'الحافة اليمنى',
    se: 'الحافة السفلية اليمنى',
    s: 'الحافة السفلية',
    sw: 'الحافة السفلية اليسرى',
    w: 'الحافة اليسرى',
  },
}
