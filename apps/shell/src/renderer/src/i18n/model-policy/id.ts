import { zh } from './zh'

export const id = {
  'Run location': 'Lokasi eksekusi',
  'Local server': 'Server lokal',
  'Cloud API': 'API cloud',
  'Context limit (tokens)': 'Batas konteks (token)',
  'Output limit (tokens)': 'Batas keluaran (token)',
  'API output parameter': 'Parameter keluaran API',
  Automatic: 'Otomatis',
  'Test image understanding': 'Uji pemahaman gambar',
  No: 'Tidak',
  Yes: 'Ya',
  'Advanced model settings': 'Pengaturan model lanjutan',
  'Tool calling verified.': 'Pemanggilan alat terverifikasi.',
  Local: 'Lokal',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Pencarian tidak tersedia untuk format ini',
  'Analysis unavailable for this format': 'Analisis tidak tersedia untuk format ini',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Simpan salinan XLSX untuk mencari, memeriksa, atau menganalisis.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Teks hasil ekstraksi tersedia; pemeriksaan dan pengeditan asli tidak tersedia untuk format ini.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Analisis asli mendukung tabel XLSX, XLSM, CSV, TSV, dan JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Batas keluaran Codex bersifat anjuran; respons alat yang terlalu besar ditolak sebelum dijalankan.',
} satisfies Record<keyof typeof zh, string>
