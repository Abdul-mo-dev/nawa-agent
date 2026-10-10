import { zh } from './zh'

export const zh_TW = {
  'Run location': '執行位置',
  'Local server': '本機伺服器',
  'Cloud API': '雲端 API',
  'Context limit (tokens)': '上下文上限（Token）',
  'Output limit (tokens)': '輸出上限（Token）',
  'API output parameter': 'API 輸出參數',
  Automatic: '自動',
  'Test image understanding': '測試影像理解',
  No: '否',
  Yes: '是',
  'Advanced model settings': '進階模型設定',
  'Tool calling verified.': '工具呼叫已驗證。',
  Local: '本機',
  Cloud: '雲端',
  'Search unavailable for this format': '此格式不支援搜尋',
  'Analysis unavailable for this format': '此格式不支援分析',
  'Save a copy as XLSX to search, inspect or analyze it.': '另存為 XLSX 副本以搜尋、檢查或分析。',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    '可擷取文字；此格式不支援原生檢查或編輯。',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    '原生分析支援 XLSX、XLSM、CSV、TSV 和 JSON 表格。',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Codex 輸出上限為建議值；過大的工具回應會在執行前被拒絕。',
} satisfies Record<keyof typeof zh, string>
