import { zh } from './zh'

export const de = {
  'Run location': 'Ausführungsort',
  'Local server': 'Lokaler Server',
  'Cloud API': 'Cloud-API',
  'Context limit (tokens)': 'Kontextlimit (Tokens)',
  'Output limit (tokens)': 'Ausgabelimit (Tokens)',
  'API output parameter': 'API-Ausgabeparameter',
  Automatic: 'Automatisch',
  'Test image understanding': 'Bildverständnis testen',
  No: 'Nein',
  Yes: 'Ja',
  'Advanced model settings': 'Erweiterte Modelleinstellungen',
  'Tool calling verified.': 'Tool-Aufrufe geprüft.',
  Local: 'Lokal',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Suche für dieses Format nicht verfügbar',
  'Analysis unavailable for this format': 'Analyse für dieses Format nicht verfügbar',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Eine XLSX-Kopie für Suche, Prüfung oder Analyse speichern.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Extrahierter Text ist verfügbar; native Prüfung und Bearbeitung werden für dieses Format nicht unterstützt.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Native Analyse unterstützt XLSX-, XLSM-, CSV-, TSV- und JSON-Tabellen.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Das Codex-Ausgabelimit ist ein Richtwert; zu große Tool-Antworten werden vor der Ausführung abgewiesen.',
} satisfies Record<keyof typeof zh, string>
