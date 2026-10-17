import { zh } from './zh'

export const id = {
  modernCopy:
    'Perubahan akan disimpan ke salinan .{to} baru ini. File .{from} asli tetap tidak berubah.',
  workbookCopy:
    'Perubahan akan disimpan ke salinan .xlsx baru ini. File .{from} asli tetap tidak berubah.',
  workbookImport:
    'Nilai sel dan rumus yang didukung diimpor. Pemformatan, grafik, gambar, makro, dan rentang bernama tidak disertakan. Rumus yang dipertahankan sebagai nilai cache: {formulas}. Sheet dengan rumus yang tidak dapat dibaca: {sheets}.',
  chatCopy:
    'Perubahan akan disimpan ke file .{to} baru ini. File .{from} asli tetap tidak berubah. Konversi dapat mengubah tata letak atau animasi; makro tidak dipertahankan.',
  notice:
    '.{from} diimpor sebagai salinan .{to} yang dapat diedit. Pilih berkas baru saat menyimpan; berkas asli tetap utuh. Tata letak atau animasi dapat berubah, dan makro tidak dipertahankan.',
  missing:
    'Instal LibreOffice untuk mengimpor file Office atau OpenDocument, atau atur NAWA_LIBREOFFICE_PATH ke file eksekusinya lalu mulai ulang Nawa.',
  tooLarge: 'Impor Office dibatasi hingga 64 MiB.',
  failed:
    'File tidak dapat dikonversi. File mungkin rusak, dilindungi kata sandi, atau tidak didukung.',
  encrypted:
    'File yang dilindungi kata sandi tidak dapat diimpor. Simpan salinan tanpa enkripsi di aplikasi asal terlebih dahulu.',
} satisfies Record<keyof typeof zh, string>
