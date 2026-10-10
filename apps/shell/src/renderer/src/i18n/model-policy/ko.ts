import { zh } from './zh'

export const ko = {
  'Run location': '실행 위치',
  'Local server': '로컬 서버',
  'Cloud API': '클라우드 API',
  'Context limit (tokens)': '컨텍스트 한도(토큰)',
  'Output limit (tokens)': '출력 한도(토큰)',
  'API output parameter': 'API 출력 매개변수',
  Automatic: '자동',
  'Test image understanding': '이미지 이해 테스트',
  No: '아니요',
  Yes: '예',
  'Advanced model settings': '고급 모델 설정',
  'Tool calling verified.': '도구 호출이 확인되었습니다.',
  Local: '로컬',
  Cloud: '클라우드',
  'Search unavailable for this format': '이 형식은 검색을 지원하지 않습니다',
  'Analysis unavailable for this format': '이 형식은 분석을 지원하지 않습니다',
  'Save a copy as XLSX to search, inspect or analyze it.':
    '검색·검사·분석을 위해 XLSX 복사본을 저장하세요.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    '추출된 텍스트는 제공되지만 이 형식의 기본 검사 및 편집은 지원되지 않습니다.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    '기본 분석은 XLSX, XLSM, CSV, TSV 및 JSON 표를 지원합니다.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Codex 출력 한도는 권장값이며 큰 도구 응답은 실행 전에 거부됩니다.',
} satisfies Record<keyof typeof zh, string>
