import { zh } from './zh'

export const ru = {
  'Run location': 'Место выполнения',
  'Local server': 'Локальный сервер',
  'Cloud API': 'Облачный API',
  'Context limit (tokens)': 'Лимит контекста (токены)',
  'Output limit (tokens)': 'Лимит вывода (токены)',
  'API output parameter': 'Параметр вывода API',
  Automatic: 'Автоматически',
  'Test image understanding': 'Проверить понимание изображений',
  No: 'Нет',
  Yes: 'Да',
  'Advanced model settings': 'Расширенные настройки модели',
  'Tool calling verified.': 'Вызов инструментов проверен.',
  Local: 'Локально',
  Cloud: 'Облако',
  'Search unavailable for this format': 'Поиск недоступен для этого формата',
  'Analysis unavailable for this format': 'Анализ недоступен для этого формата',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Сохраните копию XLSX для поиска, проверки или анализа.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Извлечённый текст доступен; встроенная проверка и редактирование этого формата недоступны.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Встроенный анализ поддерживает таблицы XLSX, XLSM, CSV, TSV и JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Лимит вывода Codex рекомендательный; слишком большие ответы инструментов отклоняются до выполнения.',
} satisfies Record<keyof typeof zh, string>
