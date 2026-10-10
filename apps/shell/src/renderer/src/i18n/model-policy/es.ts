import { zh } from './zh'

export const es = {
  'Run location': 'Lugar de ejecución',
  'Local server': 'Servidor local',
  'Cloud API': 'API en la nube',
  'Context limit (tokens)': 'Límite de contexto (tokens)',
  'Output limit (tokens)': 'Límite de salida (tokens)',
  'API output parameter': 'Parámetro de salida de API',
  Automatic: 'Automático',
  'Test image understanding': 'Probar comprensión de imágenes',
  No: 'No',
  Yes: 'Sí',
  'Advanced model settings': 'Ajustes avanzados del modelo',
  'Tool calling verified.': 'Llamadas a herramientas verificadas.',
  Local: 'Local',
  Cloud: 'Nube',
  'Search unavailable for this format': 'Búsqueda no disponible para este formato',
  'Analysis unavailable for this format': 'Análisis no disponible para este formato',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Guarda una copia XLSX para buscar, inspeccionar o analizar.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'El texto extraído está disponible; este formato no permite inspección ni edición nativas.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'El análisis nativo admite tablas XLSX, XLSM, CSV, TSV y JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'El límite de salida de Codex es orientativo; las respuestas de herramientas demasiado grandes se rechazan antes de ejecutarse.',
} satisfies Record<keyof typeof zh, string>
