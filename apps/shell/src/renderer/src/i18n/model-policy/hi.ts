import { zh } from './zh'

export const hi = {
  'Run location': 'चलाने का स्थान',
  'Local server': 'स्थानीय सर्वर',
  'Cloud API': 'क्लाउड API',
  'Context limit (tokens)': 'संदर्भ सीमा (टोकन)',
  'Output limit (tokens)': 'आउटपुट सीमा (टोकन)',
  'API output parameter': 'API आउटपुट पैरामीटर',
  Automatic: 'स्वचालित',
  'Test image understanding': 'चित्र समझ का परीक्षण',
  No: 'नहीं',
  Yes: 'हाँ',
  'Advanced model settings': 'उन्नत मॉडल सेटिंग',
  'Tool calling verified.': 'टूल कॉल सत्यापित।',
  Local: 'स्थानीय',
  Cloud: 'क्लाउड',
  'Search unavailable for this format': 'इस प्रारूप में खोज उपलब्ध नहीं है',
  'Analysis unavailable for this format': 'इस प्रारूप में विश्लेषण उपलब्ध नहीं है',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'खोज, निरीक्षण या विश्लेषण के लिए XLSX प्रति सहेजें।',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'निकाला गया पाठ उपलब्ध है; इस प्रारूप में मूल निरीक्षण और संपादन उपलब्ध नहीं हैं।',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'मूल विश्लेषण XLSX, XLSM, CSV, TSV और JSON तालिकाओं का समर्थन करता है।',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Codex की आउटपुट सीमा सलाह है; बड़े टूल उत्तर निष्पादन से पहले अस्वीकार किए जाते हैं।',
} satisfies Record<keyof typeof zh, string>
