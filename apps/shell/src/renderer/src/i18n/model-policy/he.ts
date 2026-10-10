import { zh } from './zh'

export const he = {
  'Run location': 'מיקום הרצה',
  'Local server': 'שרת מקומי',
  'Cloud API': 'API בענן',
  'Context limit (tokens)': 'מגבלת הקשר (טוקנים)',
  'Output limit (tokens)': 'מגבלת פלט (טוקנים)',
  'API output parameter': 'פרמטר פלט API',
  Automatic: 'אוטומטי',
  'Test image understanding': 'בדיקת הבנת תמונות',
  No: 'לא',
  Yes: 'כן',
  'Advanced model settings': 'הגדרות מודל מתקדמות',
  'Tool calling verified.': 'קריאות לכלים אומתו.',
  Local: 'מקומי',
  Cloud: 'ענן',
  'Search unavailable for this format': 'חיפוש אינו זמין לפורמט הזה',
  'Analysis unavailable for this format': 'ניתוח אינו זמין לפורמט הזה',
  'Save a copy as XLSX to search, inspect or analyze it.': 'שמרו עותק XLSX לחיפוש, בדיקה או ניתוח.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'הטקסט שחולץ זמין; בדיקה ועריכה מובנות אינן זמינות לפורמט הזה.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'הניתוח המובנה תומך בטבלאות XLSX, XLSM, CSV, TSV ו-JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'מגבלת הפלט של Codex היא המלצה; תגובות כלים גדולות מדי נדחות לפני הביצוע.',
} satisfies Record<keyof typeof zh, string>
