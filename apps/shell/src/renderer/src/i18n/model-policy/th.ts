import { zh } from './zh'

export const th = {
  'Run location': 'ตำแหน่งการทำงาน',
  'Local server': 'เซิร์ฟเวอร์ในเครื่อง',
  'Cloud API': 'API คลาวด์',
  'Context limit (tokens)': 'ขีดจำกัดบริบท (โทเคน)',
  'Output limit (tokens)': 'ขีดจำกัดเอาต์พุต (โทเคน)',
  'API output parameter': 'พารามิเตอร์เอาต์พุต API',
  Automatic: 'อัตโนมัติ',
  'Test image understanding': 'ทดสอบความเข้าใจภาพ',
  No: 'ไม่',
  Yes: 'ใช่',
  'Advanced model settings': 'การตั้งค่าโมเดลขั้นสูง',
  'Tool calling verified.': 'ตรวจสอบการเรียกเครื่องมือแล้ว',
  Local: 'ในเครื่อง',
  Cloud: 'คลาวด์',
  'Search unavailable for this format': 'ไม่รองรับการค้นหาในรูปแบบนี้',
  'Analysis unavailable for this format': 'ไม่รองรับการวิเคราะห์ในรูปแบบนี้',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'บันทึกสำเนา XLSX เพื่อค้นหา ตรวจสอบ หรือวิเคราะห์',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'มีข้อความที่สกัดแล้ว แต่ไม่รองรับการตรวจสอบและแก้ไขแบบเนทีฟในรูปแบบนี้',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'การวิเคราะห์แบบเนทีฟรองรับตาราง XLSX, XLSM, CSV, TSV และ JSON',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'ขีดจำกัดเอาต์พุต Codex เป็นคำแนะนำ คำตอบเครื่องมือที่ใหญ่เกินไปจะถูกปฏิเสธก่อนดำเนินการ',
} satisfies Record<keyof typeof zh, string>
