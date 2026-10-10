import { zh } from './zh'

export const ar = {
  'Run location': 'مكان التشغيل',
  'Local server': 'خادم محلي',
  'Cloud API': 'واجهة سحابية',
  'Context limit (tokens)': 'حد السياق (رموز)',
  'Output limit (tokens)': 'حد الإخراج (رموز)',
  'API output parameter': 'معلمة حد الإخراج',
  Automatic: 'تلقائي',
  'Test image understanding': 'اختبار فهم الصور',
  No: 'لا',
  Yes: 'نعم',
  'Advanced model settings': 'إعدادات النموذج المتقدمة',
  'Tool calling verified.': 'تم التحقق من استدعاء الأدوات.',
  Local: 'محلي',
  Cloud: 'سحابي',
  'Search unavailable for this format': 'البحث غير متاح لهذا التنسيق',
  'Analysis unavailable for this format': 'التحليل غير متاح لهذا التنسيق',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'احفظ نسخة بتنسيق XLSX للبحث أو الفحص أو التحليل.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'النص المستخرج متاح؛ الفحص والتحرير الأصليان غير متاحين لهذا التنسيق.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'يدعم التحليل الأصلي جداول XLSX وXLSM وCSV وTSV وJSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'حد إخراج Codex إرشادي؛ تُرفض استجابات الأدوات الكبيرة قبل التنفيذ.',
} satisfies Record<keyof typeof zh, string>
