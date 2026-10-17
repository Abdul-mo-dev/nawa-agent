import { zh } from './zh'

export const ms = {
  modernCopy:
    'Suntingan akan disimpan dalam salinan .{to} baharu ini. Fail .{from} asal kekal tidak berubah.',
  workbookCopy:
    'Suntingan akan disimpan dalam salinan .xlsx baharu ini. Fail .{from} asal kekal tidak berubah.',
  workbookImport:
    'Nilai sel dan formula yang disokong diimport. Pemformatan, carta, imej, makro dan julat bernama tidak dikekalkan. Formula yang dikekalkan sebagai nilai cache: {formulas}. Helaian dengan formula yang tidak boleh dibaca: {sheets}.',
  chatCopy:
    'Suntingan akan disimpan dalam fail .{to} baharu ini. Fail .{from} asal kekal tidak berubah. Penukaran mungkin mengubah susun atur atau animasi; makro tidak dikekalkan.',
  notice:
    '.{from} diimport sebagai salinan .{to} yang boleh disunting. Pilih fail baharu ketika menyimpan; fail asal kekal tanpa perubahan. Susun atur atau animasi mungkin berubah, dan makro tidak dikekalkan.',
  missing:
    'Pasang LibreOffice untuk mengimport fail Office atau OpenDocument, atau tetapkan NAWA_LIBREOFFICE_PATH kepada fail boleh lakunya dan mulakan semula Nawa.',
  tooLarge: 'Import Office dihadkan kepada 64 MiB.',
  failed:
    'Fail tidak dapat ditukar. Fail mungkin rosak, dilindungi kata laluan atau tidak disokong.',
  encrypted:
    'Fail yang dilindungi kata laluan tidak boleh diimport. Simpan salinan tanpa penyulitan dalam aplikasi asal dahulu.',
} satisfies Record<keyof typeof zh, string>
