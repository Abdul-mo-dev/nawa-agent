import { zh } from './zh'

export const it = {
  'Run location': 'Luogo di esecuzione',
  'Local server': 'Server locale',
  'Cloud API': 'API cloud',
  'Context limit (tokens)': 'Limite del contesto (token)',
  'Output limit (tokens)': 'Limite di output (token)',
  'API output parameter': 'Parametro di output API',
  Automatic: 'Automatico',
  'Test image understanding': 'Verifica comprensione delle immagini',
  No: 'No',
  Yes: 'Sì',
  'Advanced model settings': 'Impostazioni avanzate del modello',
  'Tool calling verified.': 'Chiamate agli strumenti verificate.',
  Local: 'Locale',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Ricerca non disponibile per questo formato',
  'Analysis unavailable for this format': 'Analisi non disponibile per questo formato',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Salva una copia XLSX per cercare, ispezionare o analizzare.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Il testo estratto è disponibile; ispezione e modifica native non sono disponibili per questo formato.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'L’analisi nativa supporta tabelle XLSX, XLSM, CSV, TSV e JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Il limite di output Codex è indicativo; risposte degli strumenti troppo grandi vengono rifiutate prima dell’esecuzione.',
} satisfies Record<keyof typeof zh, string>
