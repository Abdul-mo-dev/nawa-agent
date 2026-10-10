import { zh } from './zh'

export const cs = {
  'Run location': 'Místo spuštění',
  'Local server': 'Místní server',
  'Cloud API': 'Cloudové API',
  'Context limit (tokens)': 'Limit kontextu (tokeny)',
  'Output limit (tokens)': 'Limit výstupu (tokeny)',
  'API output parameter': 'Parametr výstupu API',
  Automatic: 'Automaticky',
  'Test image understanding': 'Ověřit porozumění obrázkům',
  No: 'Ne',
  Yes: 'Ano',
  'Advanced model settings': 'Pokročilá nastavení modelu',
  'Tool calling verified.': 'Volání nástrojů ověřeno.',
  Local: 'Místní',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Hledání není pro tento formát dostupné',
  'Analysis unavailable for this format': 'Analýza není pro tento formát dostupná',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Uložte kopii XLSX pro hledání, kontrolu nebo analýzu.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Extrahovaný text je dostupný; nativní kontrola a úpravy tohoto formátu nejsou dostupné.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Nativní analýza podporuje tabulky XLSX, XLSM, CSV, TSV a JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Limit výstupu Codex je orientační; příliš velké odpovědi nástrojů se před provedením odmítnou.',
} satisfies Record<keyof typeof zh, string>
